/* sidecar test suite — spins the real server against a temp fixture dir and hits the real API.
   Run: npm test */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync, execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

// mirror the server's content hash (sha1 hex, first 12) so tests can assert the returned hash
// equals the sha of the exact bytes on disk.
const sha_of = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

const PORT = 4991;
const BASE = `http://127.0.0.1:${PORT}`;
let dir, proc;

const DOC = `# Title

Intro paragraph with **bold** text and a [link](https://example.com).

## Section A

Repeated line here.

## Section B

Repeated line here.

- item one
- item two

| a | b |
| - | - |
| 1 | 2 |

\`\`\`js
const x = 1;
\`\`\`

Closing paragraph.
`;

const j = (r) => r.json();
// Retry once on a CONNECTION-level failure. undici keeps sockets alive between requests, but Node's
// server closes an idle connection after keepAliveTimeout (5s) — so the first fetch following a long
// stretch of non-HTTP tests (the CLI block runs for seconds without touching the server) reuses a
// socket the server has already closed and gets ECONNRESET. Nothing to do with the code under test:
// it moved when the tests were reordered, always landing on whichever HTTP test came first after the
// gap. Retrying establishes a fresh connection. Only connection errors retry; a real HTTP response,
// including a 4xx/5xx, is returned untouched.
async function fetchRetry(url, init) {
  try { return await fetch(url, init); }
  catch (e) {
    if (!/fetch failed/.test(e.message)) throw e;
    return fetch(url, init);
  }
}
const state = () => fetchRetry(`${BASE}/api/state?path=doc.md`).then(j);
const put = (url, body) => fetchRetry(`${BASE}${url}`, { method: 'PUT',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (url, body) => fetchRetry(`${BASE}${url}`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// Raw GET so we can set an arbitrary Host header (fetch/undici normalizes it to the target).
const rawGet = (pathname, host) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET',
    headers: host ? { Host: host } : {} }, (res) => {
    let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', reject); req.end();
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
  fs.writeFileSync(path.join(dir, 'doc.md'), DOC);
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: dir });
  proc = spawn('node', [path.join(__dirname, 'server.js'), dir],
    { env: { ...process.env, SIDECAR_PORT: PORT }, stdio: 'pipe' });
  await new Promise((res, rej) => {
    proc.stdout.on('data', (d) => { if (d.toString().includes('ready')) res(); });
    proc.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server never became ready')), 8000);
  });
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('state returns markdown, hash, empty review', async () => {
  const s = await state();
  assert.equal(s.markdown, DOC);
  assert.match(s.hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(s.review.items, []);
});

test('save with correct baseHash succeeds and returns new hash', async () => {
  const s = await state();
  const next = s.markdown.replace('Intro paragraph', 'Intro paragraph EDITED');
  const r = await put('/api/save', { path: 'doc.md', content: next, baseHash: s.hash });
  assert.equal(r.status, 200);
  const body = await j(r);
  assert.notEqual(body.hash, s.hash);
  assert.match(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), /EDITED/);
});

test('save with stale baseHash returns 409 and does not clobber', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const r = await put('/api/save', { path: 'doc.md', content: 'CLOBBERED', baseHash: 'deadbeef0000' });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
});

test('save without baseHash overrides (explicit "save anyway" path)', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const r = await put('/api/save', { path: 'doc.md', content: before, baseHash: undefined });
  assert.equal(r.status, 200);
});

test('save preserves CRLF endings — client PUTs all-LF (marked normalizes), file stays CRLF', async () => {
  // fixture with CRLF endings; git-tracked separately from doc.md so other tests are unaffected.
  const crlfDoc = 'Line one.\r\nLine two.\r\nLine three.\r\n';
  fs.writeFileSync(path.join(dir, 'crlf.md'), crlfDoc);
  const s = await fetch(`${BASE}/api/state?path=crlf.md`).then(j);
  assert.ok(s.markdown.includes('\r\n'), 'state returns the raw CRLF bytes');
  // client sends the same text but all-LF (what marked+serializer produce) plus a small edit.
  const edited = s.markdown.replace(/\r\n/g, '\n').replace('Line two.', 'Line two EDITED.');
  const r = await put('/api/save', { path: 'crlf.md', content: edited, baseHash: s.hash });
  assert.equal(r.status, 200);
  const saved = fs.readFileSync(path.join(dir, 'crlf.md'), 'utf8');
  assert.ok(saved.includes('\r\n'), 'CRLF endings preserved');
  assert.ok(!saved.replace(/\r\n/g, '').includes('\n'), 'no lone \\n left (every \\n preceded by \\r)');
  assert.match(saved, /Line two EDITED\./, 'the edit landed');
  // returned hash matches what is actually on disk, so the next baseHash stays valid.
  assert.equal((await j(r)).hash, sha_of(saved));
});

test('save keeps an LF file LF — no stray \\r introduced', async () => {
  const lfDoc = 'Alpha.\nBeta.\nGamma.\n';
  fs.writeFileSync(path.join(dir, 'lf.md'), lfDoc);
  const s = await fetch(`${BASE}/api/state?path=lf.md`).then(j);
  const edited = s.markdown.replace('Beta.', 'Beta EDITED.');
  const r = await put('/api/save', { path: 'lf.md', content: edited, baseHash: s.hash });
  assert.equal(r.status, 200);
  const saved = fs.readFileSync(path.join(dir, 'lf.md'), 'utf8');
  assert.ok(!saved.includes('\r'), 'no \\r introduced into an LF file');
  assert.match(saved, /Beta EDITED\./);
  assert.equal((await j(r)).hash, sha_of(saved), 'returned hash matches on-disk LF bytes');
});

test('save returned hash equals the sha of the bytes actually written (CRLF)', async () => {
  const crlfDoc = 'One.\r\nTwo.\r\n';
  fs.writeFileSync(path.join(dir, 'crlf2.md'), crlfDoc);
  const s = await fetch(`${BASE}/api/state?path=crlf2.md`).then(j);
  const r = await put('/api/save', { path: 'crlf2.md', content: 'One.\nTwo CHANGED.\n', baseHash: s.hash });
  const body = await j(r);
  const saved = fs.readFileSync(path.join(dir, 'crlf2.md'), 'utf8');
  assert.ok(saved.includes('\r\n'));
  // next save with the returned hash as baseHash must NOT 409 (optimistic lock stays consistent).
  const r2 = await put('/api/save', { path: 'crlf2.md', content: 'One.\nTwo CHANGED AGAIN.\n', baseHash: body.hash });
  assert.equal(r2.status, 200, 'returned hash matched on-disk bytes — no false 409');
});

test('review PUT merges by id — agent items written between load and save survive', async () => {
  // client loads (empty-ish), agent writes an item straight to the sidecar, client PUTs its own item
  const agentItem = { id: 'agent1', kind: 'comment', by: 'claude',
    anchor: { quote: 'Closing paragraph.', occurrence: 0 }, status: 'open',
    thread: [{ by: 'claude', at: 'x', text: 'agent note' }] };
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'),
    JSON.stringify({ schema: 1, items: [agentItem] }));
  const clientItem = { id: 'alex1', kind: 'comment', by: 'alex',
    anchor: { quote: 'item one', occurrence: 0 }, status: 'open',
    thread: [{ by: 'alex', at: 'x', text: 'alex note' }] };
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [clientItem] } });
  const body = await j(r);
  const ids = body.review.items.map(i => i.id).sort();
  assert.deepEqual(ids, ['agent1', 'alex1']);
});

test('review PUT same-id merge unions threads — a stale client PUT cannot drop the agent reply (H1)', async () => {
  const p = path.join(dir, 'doc.md.review.json');
  // 1) client seeds c1 with one human message.
  const human1 = { by: 'alex', at: '2026-07-18T10:00:00Z', text: 'first human note' };
  await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'alex', anchor: { quote: 'item one', occurrence: 0 },
      status: 'open', thread: [human1] }] } });
  // 2) agent appends a reply straight to the sidecar (the client never sees it).
  const agentMsg = { by: 'claude', at: '2026-07-18T10:05:00Z', text: 'agent reply' };
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  onDisk.items.find(i => i.id === 'c1').thread.push(agentMsg);
  fs.writeFileSync(p, JSON.stringify(onDisk));
  // 3) human, whose loaded copy predates the agent reply, adds their own reply and PUTs the STALE c1
  //    (has human1 + human2, MISSING agentMsg).
  const human2 = { by: 'alex', at: '2026-07-18T10:10:00Z', text: 'second human note' };
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'alex', anchor: { quote: 'item one', occurrence: 0 },
      status: 'open', thread: [human1, human2] }] } });
  const thread = (await j(r)).review.items.find(i => i.id === 'c1').thread;
  const texts = thread.map(m => m.text);
  assert.ok(texts.includes('agent reply'), 'agent reply was dropped — the H1 data-loss bug');
  assert.ok(texts.includes('second human note'), 'human reply was dropped');
  assert.ok(texts.includes('first human note'));
  assert.equal(thread.length, 3, 'exactly the three distinct messages, no dupes');
  assert.deepEqual(texts, ['first human note', 'agent reply', 'second human note'], 'insertion order: on-disk (human1, agent reply) then the incoming new one (human2)');
});

test('review PUT same-id merge does not regress a decided status back to open', async () => {
  const p = path.join(dir, 'doc.md.review.json');
  // on disk: c2 already resolved.
  await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c2', kind: 'comment', by: 'alex', anchor: { quote: 'item two', occurrence: 0 },
      status: 'resolved', decidedAt: '2026-07-18T09:00:00Z', thread: [] }] } });
  // stale PUT still thinks c2 is open.
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [
    { id: 'c2', kind: 'comment', by: 'alex', anchor: { quote: 'item two', occurrence: 0 },
      status: 'open', thread: [] }] } });
  const c2 = (await j(r)).review.items.find(i => i.id === 'c2');
  assert.equal(c2.status, 'resolved', 'terminal status regressed to open');
  assert.equal(c2.decidedAt, '2026-07-18T09:00:00Z', 'decidedAt not carried');
});

test('review PUT same-id no-op merge: unchanged item keeps identical thread + status, no dupes', async () => {
  const p = path.join(dir, 'doc.md.review.json');
  const item = { id: 'c3', kind: 'comment', by: 'alex', anchor: { quote: 'Title', occurrence: 0 },
    status: 'open', thread: [
      { by: 'alex', at: '2026-07-18T08:00:00Z', text: 'a' },
      { by: 'claude', at: '2026-07-18T08:01:00Z', text: 'b' }] };
  await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [item] } });
  // PUT the very same item again (normal single-writer save with no concurrent change).
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1, items: [item] } });
  const c3 = (await j(r)).review.items.find(i => i.id === 'c3');
  assert.equal(c3.status, 'open');
  assert.deepEqual(c3.thread, item.thread, 'thread changed on a no-op PUT (dupes or reorder)');
});

test('accept applies replacement at exact anchor and settles the card', async () => {
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  review.items.push({ id: 'sug1', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'Closing paragraph.', occurrence: 0 }, replacement: 'Closing paragraph, improved.' });
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug1' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(md, /Closing paragraph, improved\./);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug1').status, 'accepted');
});

test('accept with occurrence targets the right duplicate', async () => {
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  review.items.push({ id: 'sug2', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'Repeated line here.', occurrence: 1 }, replacement: 'Second copy, replaced.' });
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug2' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const a = md.indexOf('Repeated line here.');       // first copy intact
  const b = md.indexOf('Second copy, replaced.');    // second copy replaced
  assert.ok(a !== -1 && b !== -1 && a < b, 'first stayed, second replaced');
});

// A visible-text quote MATCHES its marked-up source — that tolerance is the point, and comments rely
// on it. But it must not be SPLICED: the file has "**bold** text", so the quote "bold text" resolves to
// the raw span `bold** text`, which begins inside the bold run. Replacing it used to write
// "****bold** prose" — four asterisks, broken emphasis. This test asserted only /\*\*bold\*\* prose/,
// which the corrupted string also satisfies, so it passed for the whole time the bug existed.
test('tolerant anchor matches visible text, but accept refuses to splice a half-marked span', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  review.items.push({ id: 'sug3', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'bold text', occurrence: 0 }, replacement: '**bold** prose' });
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'), JSON.stringify(review));

  // It still resolves — the matcher is unchanged.
  const Anchor = require('./public/anchor.js');
  assert.ok(Anchor.findNth(before, 'bold text', 0), 'visible-text quote still matches');

  const r = await post('/api/accept', { path: 'doc.md', id: 'sug3' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /unbalanced/);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before, 'file untouched');

  // Quoting the raw markdown gives a splice-safe span, and that applies cleanly.
  review.items.push({ id: 'sug3b', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: '**bold** text', occurrence: 0 }, replacement: '**bold** prose' });
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'), JSON.stringify(review));
  const r2 = await post('/api/accept', { path: 'doc.md', id: 'sug3b' });
  assert.equal(r2.status, 200);
  const after = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(after, /with \*\*bold\*\* prose and/);
  assert.ok(!/\*\*\*\*/.test(after), 'no doubled markers');
});

test('accept on a vanished anchor 409s and orphans the card, file untouched', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  review.items.push({ id: 'sug4', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'THIS TEXT DOES NOT EXIST ANYWHERE', occurrence: 0 }, replacement: 'x' });
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug4' });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug4').status, 'orphaned');
});

test('orphan detection is idempotent — repeated reads do not rewrite the sidecar (no reload storms)', async () => {
  await state(); // may legitimately write once (annotate pass)
  const p = path.join(dir, 'doc.md.review.json');
  const m1 = fs.statSync(p).mtimeMs;
  await state(); await state(); await state();
  const m2 = fs.statSync(p).mtimeMs;
  assert.equal(m1, m2, 'sidecar rewritten on read with no changes');
});

test('reject settles without touching the file', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  review.items.push({ id: 'sug5', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'item two', occurrence: 0 }, replacement: 'item 2' });
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'), JSON.stringify(review));
  const r = await post('/api/reject', { path: 'doc.md', id: 'sug5' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
});

test('format bold wraps the selection at its anchor', async () => {
  const r = await post('/api/format', { path: 'doc.md', quote: 'item one', occurrence: 0, op: 'bold' });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), /\*\*item one\*\*/);
});

test('format bold is a toggle — re-applying unwraps', async () => {
  const r = await post('/api/format', { path: 'doc.md', quote: 'item one', occurrence: 0, op: 'bold' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.doesNotMatch(md, /\*\*item one\*\*/);
  assert.match(md, /- item one/);
});

test('format link wraps the selection as a markdown link', async () => {
  const r = await post('/api/format', { path: 'doc.md', quote: 'item two', occurrence: 0,
    op: 'link', url: 'https://example.org' });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), /\[item two\]\(https:\/\/example\.org\)/);
});

test('format occurrence targets the right duplicate', async () => {
  const s = await state();  // fixture is mutated by earlier tests — seed our own duplicate pair
  await put('/api/save', { path: 'doc.md', content: s.markdown + '\nDUPX marker.\n\nDUPX marker.\n', baseHash: s.hash });
  const r = await post('/api/format', { path: 'doc.md', quote: 'DUPX marker.', occurrence: 1, op: 'italic' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const first = md.indexOf('DUPX marker.');           // first copy still plain
  const second = md.indexOf('_DUPX marker._');         // second copy italicized
  assert.ok(first !== -1 && second !== -1 && first < second, 'first plain, second italic');
});

test('format on a vanished anchor 409s and leaves the file untouched', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const r = await post('/api/format', { path: 'doc.md', quote: 'NO SUCH TEXT ANYWHERE', occurrence: 0, op: 'bold' });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
});

test('path traversal is refused with a JSON 4xx (not an HTML stack trace)', async () => {
  const r = await fetch(`${BASE}/api/state?path=${encodeURIComponent('../../../etc/passwd')}`);
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  assert.match(r.headers.get('content-type') || '', /json/);
  assert.ok((await j(r)).error, 'error must be JSON');
});

test('path traversal via sibling-prefix dir is refused with a JSON 4xx', async () => {
  // BASE_DIR is `dir`; a sibling `dir + suffix` string-prefix-matches BASE_DIR but is a different tree.
  const rel = `../${path.basename(dir)}-evil/x.md`;
  const r = await fetch(`${BASE}/api/state?path=${encodeURIComponent(rel)}`);
  assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  assert.match(r.headers.get('content-type') || '', /json/, 'error must be JSON, not an HTML stack trace');
  assert.ok((await j(r)).error, 'error must be JSON');
});

test('host allowlist: disallowed Host is 403, allowed host works', async () => {
  const bad = await rawGet('/api/files', 'evil.example.com');
  assert.equal(bad.status, 403);
  const good = await rawGet('/api/files', `127.0.0.1:${PORT}`);
  assert.equal(good.status, 200);
});

test('accept is guarded against double-apply: second accept 409s, no double mutation', async () => {
  const p = path.join(dir, 'doc.md.review.json');
  const s = await state();
  // seed a unique target line whose anchor survives its own replacement (so a *missing* guard would re-splice)
  await put('/api/save', { path: 'doc.md', content: s.markdown + '\nA DBLX here.\n', baseHash: s.hash });
  const review = JSON.parse(fs.readFileSync(p, 'utf8'));
  review.items.push({ id: 'dbl1', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'DBLX', occurrence: 0 }, replacement: 'DBLX-done' });
  fs.writeFileSync(p, JSON.stringify(review));
  const r1 = await post('/api/accept', { path: 'doc.md', id: 'dbl1' });
  assert.equal(r1.status, 200);
  const r2 = await post('/api/accept', { path: 'doc.md', id: 'dbl1' });
  assert.equal(r2.status, 409);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(md, /DBLX-done/);
  assert.doesNotMatch(md, /DBLX-done-done/, 'replacement must be applied exactly once');
});

test('corrupt sidecar is surfaced, not silently clobbered by a review write', async () => {
  const p = path.join(dir, 'doc.md.review.json');
  const good = fs.readFileSync(p, 'utf8');           // snapshot valid sidecar
  fs.writeFileSync(p, '{ not valid json ');           // corrupt it
  const r = await put('/api/review', { path: 'doc.md',
    review: { schema: 1, items: [{ id: 'x1', kind: 'comment', by: 'alex',
      anchor: { quote: 'Title', occurrence: 0 }, status: 'open', thread: [] }] } });
  assert.notEqual(r.status, 200);                     // refused rather than overwriting a subset
  assert.equal(fs.readFileSync(p, 'utf8'), '{ not valid json ', 'corrupt sidecar left untouched');
  fs.writeFileSync(p, good);                          // restore for any later reads
});

test('review PUT rejects a non-word item id (stored-XSS guard)', async () => {
  const r = await put('/api/review', { path: 'doc.md',
    review: { schema: 1, items: [{ id: '<img src=x onerror=alert(1)>', kind: 'comment',
      anchor: { quote: 'Title', occurrence: 0 }, status: 'open', thread: [] }] } });
  assert.equal(r.status, 400);
});

test('lexer round-trip: token.raw concatenation reconstructs the source (block-splice safety)', () => {
  const { marked } = require('marked');
  for (const src of [DOC, fs.readFileSync(path.join(dir, 'doc.md'), 'utf8')]) {
    const tokens = marked.lexer(src);
    const rebuilt = tokens.map(t => t.raw).join('');
    assert.equal(rebuilt, src, 'lexer raw does not reconstruct source — splicing would corrupt');
  }
});

// ---- client-side serialize round-trip (marked -> turndown) ----
// pageTd rebuilds the SAME TurndownService config the page constructs (escape off, GFM rules, tight-list).
// It's what index.html passes to serialize() and what the jsdom serialize tests below pass to the real
// public/serialize.js — one config, exercised by both the page and the tests.
function pageTd({ gfm = true } = {}) {
  const TurndownService = require('turndown');
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-',
    codeBlockStyle: 'fenced', emDelimiter: '_', hr: '---' });
  td.escape = (s) => s;
  if (gfm) td.use(require('turndown-plugin-gfm').gfm);   // must run BEFORE the li rule, as index.html does
  td.addRule('tightList', {
    filter: 'li',
    replacement: (content, node) => {
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
      const parent = node.parentNode;
      let prefix = '- ';
      if (parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const idx = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + idx : idx + 1) + '. ';
      }
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
    },
  });
  return td;
}

// ---- shared anchor module (public/anchor.js): the SAME code the server requires and the browser
// loads via <script>. Requiring it here proves findNth/occurrenceAt agree with the server behaviour,
// which is what makes the client highlight and /api/accept resolve to the same occurrence. ----
const Anchor = require('./public/anchor.js');

test('shared matcher: soft-line-break quote resolves to the same span, and occurrence round-trips', () => {
  // "beta gamma" exists only across a soft newline — the old raw-byte matcher (no ws normalization)
  // would miss it entirely and orphan the card, while the client (which normalized) found it.
  const raw = 'alpha beta\ngamma delta. alpha beta\ngamma delta.';
  const h0 = Anchor.findNth(raw, 'beta gamma', 0);
  assert.ok(h0, 'soft-line-break quote must match (ws normalized)');
  assert.equal(raw.slice(h0.start, h0.end), 'beta\ngamma', 'span maps back to the exact raw bytes');
  // occurrenceAt is the inverse: a hit at that offset is occurrence 0; the second copy is occurrence 1.
  assert.equal(Anchor.occurrenceAt(raw, 'beta gamma', h0.start), 0);
  const h1 = Anchor.findNth(raw, 'beta gamma', 1);
  assert.ok(h1 && h1.start > h0.start, 'second copy is a distinct, later span');
  assert.equal(Anchor.occurrenceAt(raw, 'beta gamma', h1.start), 1, 'occurrenceAt round-trips findNth');
});

test('shared matcher: word-boundary quote does not anchor inside a longer word (M1)', () => {
  const raw = 'The category. My cat.';
  const hit = Anchor.findNth(raw, 'cat', 0);
  assert.ok(hit, 'must resolve');
  assert.equal(raw.slice(hit.start, hit.end), 'cat');
  assert.ok(hit.start > raw.indexOf('category'), 'anchored the standalone "cat", not the one in "category"');
  // A deliberately mid-word quote has no boundary-clean hit, so it falls back to the substring match.
  const midword = Anchor.findNth(raw, 'ategor', 0);
  assert.ok(midword && raw.slice(midword.start, midword.end) === 'ategor', 'mid-word quote still resolves');
});

test('shared matcher: occurrenceAt distinguishes duplicates within one block (M2)', () => {
  const raw = 'foo and foo';
  assert.equal(Anchor.occurrenceAt(raw, 'foo', 0), 0, 'first foo');
  assert.equal(Anchor.occurrenceAt(raw, 'foo', raw.lastIndexOf('foo')), 1, 'second foo');
});

test('gfm round-trip: table + task list + strikethrough all survive turndown', () => {
  const { marked } = require('marked');
  const md = [
    '| a | b |', '| - | - |', '| 1 | 2 |', '',
    '- [ ] todo one', '- [x] done two', '',
    'Some ~~struck~~ text.', '',
  ].join('\n');
  const back = pageTd().turndown(marked.parse(md));
  assert.match(back, /\|\s*1\s*\|\s*2\s*\|/, 'table row flattened — data loss');
  assert.match(back, /\[ \]/, 'unchecked task box lost');
  assert.match(back, /\[x\]/, 'checked task box lost');
  assert.match(back, /~+struck~+/, 'strikethrough stripped');
  // Guard: core turndown (no plugin) would flatten all three — proves the plugin is what saves them.
  const bare = pageTd({ gfm: false }).turndown(marked.parse(md));
  assert.doesNotMatch(bare, /\|\s*1\s*\|\s*2\s*\|/, 'baseline: bare turndown should flatten the table');
});

test('input-rule transforms serialize to the correct markdown (block round-trip target)', () => {
  // index.html's input rules rewrite a <p> into these elements in the DOM; save runs them back through
  // the SAME turndown config. This asserts each transformed element emits the marker we intend — so
  // typing `## Foo` saves `## Foo`, not `\#\# Foo` or a stray paragraph. (Caret behavior needs a browser.)
  const td = pageTd();
  assert.equal(td.turndown('<h1>Hello world</h1>'), '# Hello world');
  assert.equal(td.turndown('<h2>Foo</h2>'), '## Foo');
  assert.equal(td.turndown('<h3>Bar</h3>'), '### Bar');
  assert.equal(td.turndown('<ul><li>item</li></ul>'), '- item');
  assert.equal(td.turndown('<ol><li>first</li></ol>'), '1. first');
  assert.equal(td.turndown('<ol start="3"><li>third</li></ol>'), '3. third');   // `3. ` honored
  assert.equal(td.turndown('<blockquote><p>quote me</p></blockquote>'), '> quote me');
  assert.equal(td.turndown('<pre><code class="language-js">const x = 1;</code></pre>'), '```js\nconst x = 1;\n```');
  // inline: <strong>/<em>/<code> emit **…**/_…_/`…`
  assert.equal(td.turndown('<p>a <strong>bold</strong> b</p>'), 'a **bold** b');
  assert.equal(td.turndown('<p>a <em>ital</em> b</p>'), 'a _ital_ b');
  assert.equal(td.turndown('<p>a <code>snip</code> b</p>'), 'a `snip` b');
});

test('editing a paragraph adjacent to a table leaves the table intact (whole-doc turndown path)', () => {
  const { marked } = require('marked');
  // Worst case: the OLD destructive fallback re-serialized the ENTIRE doc through turndown on any
  // block-count change. Even down that path, the GFM rules must keep an untouched table byte-safe.
  const edited = [
    '# Title', '',
    'Intro paragraph EDITED with more words merged in.', '',
    '| col1 | col2 |', '| - | - |', '| x | y |', '',
    'Closing paragraph.', '',
  ].join('\n');
  const back = pageTd().turndown(marked.parse(edited));
  assert.match(back, /\|\s*x\s*\|\s*y\s*\|/, 'adjacent-edit flattened the untouched table');
  assert.match(back, /\|\s*col1\s*\|\s*col2\s*\|/, 'table header lost on adjacent edit');
  // Stable: a second pass must not progressively corrupt it.
  const twice = pageTd().turndown(marked.parse(back));
  assert.match(twice, /\|\s*x\s*\|\s*y\s*\|/, 'table degraded on re-serialize');
});

// ---- the REAL serialize() / reindex() / toMd() from public/serialize.js, under a jsdom #doc ----
// The tests above prove the turndown *config* is right; these prove the actual save-path logic in
// public/serialize.js — the tight-diff (untouched blocks emit token.raw verbatim) and the reworked
// non-destructive fallback (block-count change aligns surviving blocks by md0, never re-serializing an
// untouched one). We build a #doc + block model EXACTLY as index.html's renderDoc does, so this is the
// same code the browser runs, not a re-implementation.
const Serialize = require('./public/serialize.js');   // the SAME file index.html loads via <script>

// A multi-block fixture: headings, paragraphs, a GFM table (non-canonical spacing so a re-serialize
// would visibly differ from the raw), a nested list, and a fenced code block. Built as a byte-exact
// array join so the round-trip assertions can compare against these exact source bytes.
const RT_DOC = [
  '# Heading One', '',
  'Intro paragraph with **bold** text.', '',
  '## Heading Two', '',
  'A second paragraph here.', '',
  '- item one', '  - nested a', '  - nested b', '- item two', '',
  '| Name | Value |', '|------|-------|', '| x    | y     |', '',
  '```js', 'const x = 1;', '```', '',
  'Closing paragraph.', '',
].join('\n');
const TABLE_SRC = '| Name | Value |\n|------|-------|\n| x    | y     |';   // non-canonical: turndown would reflow this
const LIST_SRC = '- item one\n  - nested a\n  - nested b\n- item two';
const CODE_SRC = '```js\nconst x = 1;\n```';

// Build a live #doc DOM + block model from a markdown fixture EXACTLY as index.html's renderDoc does:
// lex → one .block div per non-space token (innerHTML = marked.parser of that single token, DOMPurify-
// scrubbed like the page), recording each block's md0 baseline via the real Serialize.toMd. Returns the
// doc element, the blocks array (space tokens included, matching renderDoc), and the shared td+marked —
// exactly the inputs serialize()/reindex() take.
function buildDoc(md) {
  const { marked } = require('marked');
  const { window } = new JSDOM('<!doctype html><div id="doc"></div>');
  const DOMPurify = require('dompurify')(window);
  const doc = window.document.getElementById('doc');
  const td = pageTd();
  const renderMd = (tokens) => DOMPurify.sanitize(marked.parser(tokens));
  const tokens = marked.lexer(md);
  const blocks = []; let off = 0;
  for (const t of tokens) { const start = off; off += t.raw.length; blocks.push({ token: t, start, end: off }); }
  blocks.forEach((b, i) => {
    if (b.token.type === 'space') return;
    const el = window.document.createElement('div');
    el.className = 'block'; el.dataset.i = i;
    el.innerHTML = renderMd([b.token]);
    doc.appendChild(el);
    b.md0 = Serialize.toMd(el, td);
  });
  return { window, doc, blocks, td, marked };
}
const blockByText = (doc, txt) => [...doc.querySelectorAll('.block')].find(el => el.textContent.trim() === txt);

test('serialize full round-trip: an unedited doc serializes byte-identically to the source', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true, 'no block changed → tight path');
  assert.equal(md, RT_DOC, 'untouched doc must round-trip byte-for-byte (token.raw concat, through real serialize())');
});

test('serialize tight path: editing one paragraph changes only that block, every other stays byte-identical', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  const target = blockByText(doc, 'A second paragraph here.');
  assert.ok(target, 'fixture must contain the target paragraph');
  target.querySelector('p').textContent = 'A second paragraph here, now edited.';   // as contenteditable typing would
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true, 'block count unchanged → tight path');
  // The ONLY byte difference across the whole doc is inside the edited block; every other block and the
  // inter-block gaps are emitted from token.raw verbatim. Asserting exact equality proves that.
  assert.equal(md, RT_DOC.replace('A second paragraph here.', 'A second paragraph here, now edited.'));
  // Spell the survivors out for regression clarity (the table's non-canonical spacing proves raw-emission).
  assert.ok(md.includes(TABLE_SRC), 'table survived byte-for-byte');
  assert.ok(md.includes(LIST_SRC), 'nested list survived byte-for-byte');
  assert.ok(md.includes(CODE_SRC), 'fenced code survived byte-for-byte');
  assert.ok(md.includes('now edited.'), 'the edit landed');
});

test('serialize structural fallback is non-destructive: an untouched table + nested list survive a block-count change', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  // Remove a whole block (the closing paragraph) so els.length !== rendered.length → the FALLBACK path.
  // This is the reported data-loss scenario: the old fallback re-ran every block (incl. the untouched
  // table three blocks away) through turndown. Lock the fix — surviving blocks emit their exact bytes.
  blockByText(doc, 'Closing paragraph.').remove();
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, false, 'block count changed → fallback path');
  assert.ok(md.includes(TABLE_SRC), 'untouched table must survive byte-for-byte (the data-loss bug)');
  assert.ok(md.includes(LIST_SRC), 'untouched nested list must survive byte-for-byte');
  assert.ok(md.includes(CODE_SRC), 'untouched fenced code must survive byte-for-byte');
  assert.ok(!md.includes('Closing paragraph.'), 'the removed block is gone');
});

test('reindex refreshes baselines after a tight save so the next diff measures against current state', () => {
  const { doc, blocks, td, marked } = buildDoc(RT_DOC);
  blockByText(doc, 'A second paragraph here.').querySelector('p').textContent = 'A second paragraph here, now edited.';
  const { md } = Serialize.serialize(doc, blocks, td);
  const next = Serialize.reindex(doc, blocks, md, marked, td);
  assert.equal(next.filter(b => b.token.type !== 'space').length,
    [...doc.querySelectorAll('.block')].length, 'reindex keeps one non-space block per element');
  // With baselines refreshed, re-serializing the same (unchanged) DOM is a no-op that reproduces `md`.
  const again = Serialize.serialize(doc, next, td);
  assert.equal(again.md, md, 'after reindex the edited block reads as untouched → emits its new raw');
  assert.equal(again.tight, true);
});

// ---------- P1: turn/session, threaded suggestions, the wait loop ----------

test('review PUT preserves top-level session — last-writer-wins by `at` (no regress of a decision)', async () => {
  const p = path.join(dir, 'doc.md.review.json');
  const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
  cur.session = { state: 'idle', at: '2026-07-19T03:00:00Z', done: true };   // a fresh decision on disk
  fs.writeFileSync(p, JSON.stringify(cur));
  // a STALE client PUT (older session.at) echoes back the whole review — must not regress done:true.
  const r = await put('/api/review', { path: 'doc.md', review: { schema: 1,
    session: { state: 'watching', at: '2026-07-19T02:00:00Z', done: false },
    items: [{ id: 'sess-c', kind: 'comment', by: 'alex', anchor: { quote: 'Title', occurrence: 0 }, status: 'open', thread: [] }] } });
  const b1 = await j(r);
  assert.equal(b1.review.session.done, true, 'older client session cannot regress a newer done');
  assert.equal(b1.review.session.at, '2026-07-19T03:00:00Z');
  // a FRESHER client PUT (newer at) wins.
  const r2 = await put('/api/review', { path: 'doc.md', review: { schema: 1,
    session: { state: 'watching', at: '2026-07-19T04:00:00Z', done: false }, items: [] } });
  const b2 = await j(r2);
  assert.equal(b2.review.session.at, '2026-07-19T04:00:00Z', 'newer session wins');
  assert.equal(b2.review.session.done, false);
});

test('accept of a replyTo suggestion applies the edit AND resolves its parent comment', async () => {
  // Hermetic: its own file so it can't collide with the shared doc's accumulated edits.
  const f = path.join(dir, 'replydoc.md');
  fs.writeFileSync(f, '# R\n\nRESOLVEME target line.\n');
  fs.writeFileSync(f + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'par1', kind: 'comment', by: 'alex', status: 'open', anchor: { quote: 'RESOLVEME target line.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T05:00:00Z', text: 'rewrite this' }] },
    { id: 'sug1', kind: 'suggestion', by: 'claude', status: 'pending', replyTo: 'par1',
      anchor: { quote: 'RESOLVEME target line.', occurrence: 0 }, replacement: 'RESOLVED replacement line.' }] }));
  const r = await post('/api/accept', { path: 'replydoc.md', id: 'sug1' });
  assert.equal(r.status, 200);
  const after = JSON.parse(fs.readFileSync(f + '.review.json', 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug1').status, 'accepted');
  assert.equal(after.items.find(i => i.id === 'par1').status, 'resolved', 'parent comment resolves on accept');
  assert.match(fs.readFileSync(f, 'utf8'), /RESOLVED replacement line\./);
});

test('sidecar wait wakes on a new alex comment and exits 0 with a digest', async () => {
  const wf = path.join(dir, 'waitdoc.md');
  fs.writeFileSync(wf, '# W\n\nSome content here.\n');
  fs.writeFileSync(wf + '.review.json', JSON.stringify({ schema: 1, items: [] }));
  // SIDECAR_PORT points at a dead port so the best-effort presence ping just errors out harmlessly.
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'wc1', kind: 'comment', by: 'alex', anchor: { quote: 'Some content here.', occurrence: 0 }, status: 'open',
      thread: [{ by: 'alex', at: '2026-07-19T06:00:00Z', text: 'MAKE-IT-CONCRETE' }] }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'wait exits 0 once Alex acts');
  assert.match(out, /your turn/);
  assert.match(out, /MAKE-IT-CONCRETE/, 'digest names the new comment');
  assert.match(out, /DONE: false/);
});

test('sidecar wait --timeout exits non-zero when nothing happens', async () => {
  const wf = path.join(dir, 'waitdoc2.md');
  fs.writeFileSync(wf, '# W2\n');
  fs.writeFileSync(wf + '.review.json', JSON.stringify({ schema: 1, items: [] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '1'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 1, 'timeout exits non-zero');
  assert.match(out, /still watching/);
});

// ---------- flag action: a comment carrying `flag: true` ("look here") ----------
// sidecar stores and surfaces the flag; it never interprets the anchored text. These tests assert exactly
// that scope: the flag round-trips, the digest calls it out, and everything else (threading, resolution,
// orphaning) behaves like the ordinary comment it is. (The retired `run` concept was tested here before.)

test('flag item round-trips through review PUT with flag:true intact', async () => {
  const f = path.join(dir, 'flagdoc.md');
  fs.writeFileSync(f, '# Flag\n\nDo the thing on this line.\n');
  const item = { id: 'r1', kind: 'comment', by: 'alex', flag: true, status: 'open',
    anchor: { quote: 'Do the thing on this line.', occurrence: 0 },
    thread: [{ by: 'alex', at: '2026-07-19T07:00:00Z', text: '🚩 Flagged for review.' }] };
  const r = await put('/api/review', { path: 'flagdoc.md', review: { schema: 1, items: [item] } });
  assert.equal(r.status, 200);
  const stored = (await j(r)).review.items.find(i => i.id === 'r1');
  assert.equal(stored.flag, true, 'flag must survive the merge');
  assert.equal(stored.kind, 'comment', 'flag is a comment — no new kind');
  assert.equal(stored.status, 'open');
});

test('sidecar wait digests a flag as a NEW flag line, distinct from a plain comment', async () => {
  const wf = path.join(dir, 'flagwait.md');
  fs.writeFileSync(wf, '# RW\n\nShip the newsletter draft.\n\nSome other prose.\n');
  fs.writeFileSync(wf + '.review.json', JSON.stringify({ schema: 1, items: [] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'rw1', kind: 'comment', by: 'alex', flag: true, status: 'open',
      anchor: { quote: 'Ship the newsletter draft.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T07:10:00Z', text: '🚩 Flagged for review.' }] },
    { id: 'rw2', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Some other prose.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T07:10:00Z', text: 'JUST-DISCUSSING' }] }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0);
  assert.match(out, /- NEW flag @ “Ship the newsletter draft\.”: 🚩 Flagged for review\./, 'a flag gets a NEW flag line');
  assert.match(out, /- NEW comment @ “Some other prose\.”: JUST-DISCUSSING/, 'a plain comment stays a NEW comment line');
});

test('agent reply threads into a flag item like any comment', async () => {
  const f = path.join(dir, 'flagthread.md');
  fs.writeFileSync(f, '# RT\n\nRebuild the index page.\n');
  const anchor = { quote: 'Rebuild the index page.', occurrence: 0 };
  const alexMsg = { by: 'alex', at: '2026-07-19T08:00:00Z', text: '🚩 Flagged for review.' };
  await put('/api/review', { path: 'flagthread.md', review: { schema: 1, items: [
    { id: 'rt1', kind: 'comment', by: 'alex', flag: true, status: 'open', anchor, thread: [alexMsg] }] } });
  // the agent answers in-thread (its own read-modify-write of the sidecar, as AGENTS.md prescribes)
  const p = path.join(dir, 'flagthread.md.review.json');
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  onDisk.items.find(i => i.id === 'rt1').thread.push(
    { by: 'claude', at: '2026-07-19T08:05:00Z', text: 'Done — rebuilt and pushed.' });
  fs.writeFileSync(p, JSON.stringify(onDisk));
  // a stale client PUT (pre-reply copy) must neither drop the answer nor the flag
  const r = await put('/api/review', { path: 'flagthread.md', review: { schema: 1, items: [
    { id: 'rt1', kind: 'comment', by: 'alex', flag: true, status: 'open', anchor, thread: [alexMsg] }] } });
  const rt1 = (await j(r)).review.items.find(i => i.id === 'rt1');
  assert.equal(rt1.flag, true);
  assert.deepEqual(rt1.thread.map(m => m.by), ['alex', 'claude'], 'agent reply survives, in order');
});

test('flag item resolves like a comment (reject settles it, file untouched)', async () => {
  const f = path.join(dir, 'flagresolve.md');
  fs.writeFileSync(f, '# RR\n\nArchive the old posts.\n');
  fs.writeFileSync(f + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'rr1', kind: 'comment', by: 'alex', flag: true, status: 'open',
      anchor: { quote: 'Archive the old posts.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T09:00:00Z', text: '🚩 Flagged for review.' }] }] }));
  const before = fs.readFileSync(f, 'utf8');
  const r = await post('/api/reject', { path: 'flagresolve.md', id: 'rr1' });
  assert.equal(r.status, 200);
  const rr1 = JSON.parse(fs.readFileSync(f + '.review.json', 'utf8')).items.find(i => i.id === 'rr1');
  assert.equal(rr1.status, 'resolved', 'a flag comment resolves, it does not "reject"');
  assert.ok(rr1.decidedAt);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'settling a flag never touches the doc');
});

test('flag item orphans when its anchored text changes', async () => {
  const f = path.join(dir, 'flagorphan.md');
  fs.writeFileSync(f, '# RO\n\nPublish the RUNANCHOR line.\n');
  fs.writeFileSync(f + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'ro1', kind: 'comment', by: 'alex', flag: true, status: 'open',
      anchor: { quote: 'Publish the RUNANCHOR line.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T10:00:00Z', text: '🚩 Flagged for review.' }] }] }));
  const s = await fetch(`${BASE}/api/state?path=flagorphan.md`).then(j);
  assert.equal(s.review.items.find(i => i.id === 'ro1').status, 'open', 'anchored text is present → open');
  await put('/api/save', { path: 'flagorphan.md', content: '# RO\n\nThe line went away.\n', baseHash: s.hash });
  const after = await fetch(`${BASE}/api/state?path=flagorphan.md`).then(j);
  const ro1 = after.review.items.find(i => i.id === 'ro1');
  assert.equal(ro1.status, 'orphaned', 'a flag whose anchor vanished must orphan like any item');
  assert.equal(ro1.anchor.quote, 'Publish the RUNANCHOR line.', 'original quote preserved, never re-pointed');
  assert.equal(ro1.flag, true, 'still a flag while orphaned');
});

test('presence: watching/working surface in /api/state; idle reads as not-here', async () => {
  await post('/api/presence', { path: 'doc.md', state: 'watching' });
  assert.equal((await state()).presence?.state, 'watching');
  await post('/api/presence', { path: 'doc.md', state: 'working' });
  assert.equal((await state()).presence?.state, 'working');
  await post('/api/presence', { path: 'doc.md', state: 'idle' });
  assert.equal((await state()).presence, null, 'idle presence reads as not-here');
});

/* ---------------------------------------------------------------------------
   CLI — `sidecar <verb> <file>` (lib/cli.js)

   These run the real binary against a real temp repo with NO SERVER RUNNING, which is the point:
   the filesystem is the sync layer, and the agent's whole interface has to work without one.
   --------------------------------------------------------------------------- */

const CLI_DOC = `# Plan

We will ship all six features in week one.

Success metrics are not defined yet.

1. **Read** the sidecar.
2. **Merge** by id.
3. **Write** it back.

Repeated line here.

Repeated line here.
`;

function cliDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-cli-'));
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: d });
  return d;
}
const BIN = path.join(__dirname, 'server.js');
const cli = (d, ...args) => execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const cliStdin = (d, input, ...args) => execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', input });
// Returns the error (with .status and .stderr) instead of throwing, for the refusal paths.
function cliFails(d, ...args) {
  try { execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); return null; }
  catch (e) { return e; }
}
const sc = (d) => JSON.parse(fs.readFileSync(path.join(d, 'doc.md.review.json'), 'utf8'));

test('CLI comment: flat input expands to a full item — id, by, at, status, nested anchor', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'No targets yet?');
  const [it] = sc(d).items;
  assert.equal(it.kind, 'comment');
  assert.equal(it.by, 'claude');
  assert.equal(it.status, 'open');
  assert.equal(it.anchor.quote, 'Success metrics');
  assert.equal(it.anchor.occurrence, 0);
  assert.equal(it.thread.length, 1);
  assert.equal(it.thread[0].text, 'No targets yet?');
  // The agent never writes `at` — a guessed timestamp once put a reply above the comment it answered.
  assert.ok(!Number.isNaN(Date.parse(it.thread[0].at)), 'at is a real timestamp');
  assert.match(it.id, /^[\w-]+$/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI suggest: card carries replacement + note, status pending', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.',
       '--replacement', 'Week one ships three.', '--note', 'Overcommit.');
  const [it] = sc(d).items;
  assert.equal(it.kind, 'suggestion');
  assert.equal(it.status, 'pending');
  assert.equal(it.replacement, 'Week one ships three.');
  assert.equal(it.note, 'Overcommit.');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI refuses a quote that matches nothing, and writes NOTHING', () => {
  const d = cliDir();
  const e = cliFails(d, 'comment', 'doc.md', '--quote', 'text that is absent', '--text', 'x');
  assert.ok(e, 'command should fail');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /matched nothing/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.review.json')), 'no sidecar written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI refuses an ambiguous quote and names the occurrence range', () => {
  const d = cliDir();
  const e = cliFails(d, 'comment', 'doc.md', '--quote', 'Repeated line here.', '--text', 'x');
  assert.ok(e);
  assert.match(e.stderr, /ambiguous — 2 matches/);
  assert.match(e.stderr, /--occurrence 0\.\.1/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI --occurrence disambiguates and is recorded', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Repeated line here.', '--occurrence', '1', '--text', 'the second one');
  assert.equal(sc(d).items[0].anchor.occurrence, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI add: batch seeding, kind inferred from the presence of a replacement', () => {
  const d = cliDir();
  cliStdin(d, JSON.stringify([
    { quote: 'Success metrics', text: 'No targets?' },
    { quote: 'We will ship all six features in week one.', replacement: 'Week one ships three.' },
  ]), 'add', 'doc.md');
  const items = sc(d).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'comment');
  assert.equal(items[1].kind, 'suggestion');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI write merges — a human item and their thread reply survive an agent write', () => {
  const d = cliDir();
  // Human's comment lands first (as the browser would write it).
  fs.writeFileSync(path.join(d, 'doc.md.review.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-human', kind: 'comment', by: 'alex', anchor: { quote: 'Success metrics' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'what about these?' }] },
  ] }, null, 2));
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  const items = sc(d).items;
  assert.equal(items.length, 2);
  const human = items.find(i => i.id === 'c-human');
  assert.equal(human.by, 'alex');
  assert.equal(human.thread[0].text, 'what about these?');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI reply appends to a thread without disturbing earlier messages; --resolve settles it', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'first');
  const id = sc(d).items[0].id;
  cli(d, 'reply', 'doc.md', id, 'second');
  assert.deepEqual(sc(d).items[0].thread.map(m => m.text), ['first', 'second']);
  cli(d, 'reply', 'doc.md', id, 'third', '--resolve');
  const it = sc(d).items[0];
  assert.deepEqual(it.thread.map(m => m.text), ['first', 'second', 'third']);
  assert.equal(it.status, 'resolved');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI answer inherits the parent anchor and sets replyTo', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'make this concrete');
  const parent = sc(d).items[0];
  cli(d, 'answer', 'doc.md', parent.id, '--replacement', 'Target: 200 signups.');
  const card = sc(d).items.find(i => i.kind === 'suggestion');
  assert.equal(card.replyTo, parent.id);
  assert.deepEqual(card.anchor, parent.anchor, 'anchor is inherited, not re-specified');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI drop refuses an item owned by someone else, removes its own', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'doc.md.review.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-human', kind: 'comment', by: 'alex', anchor: { quote: 'Success metrics' }, status: 'open', thread: [] },
  ] }, null, 2));
  const e = cliFails(d, 'drop', 'doc.md', 'c-human');
  assert.ok(e, 'should refuse');
  assert.match(e.stderr, /belongs to "alex"/);
  assert.equal(sc(d).items.length, 1, 'nothing removed');

  cli(d, 'comment', 'doc.md', '--quote', 'week one', '--text', 'mine');
  const mine = sc(d).items.find(i => i.by === 'claude');
  cli(d, 'drop', 'doc.md', mine.id);
  assert.deepEqual(sc(d).items.map(i => i.id), ['c-human']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI reanchor repoints an orphan back onto live text', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'q');
  const id = sc(d).items[0].id;
  // Human edits the anchored text away.
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('Success metrics', 'Outcome measures'));
  cli(d, 'show', 'doc.md');                       // show runs annotateOrphans, as /api/state does
  assert.equal(sc(d).items[0].status, 'orphaned');
  cli(d, 'reanchor', 'doc.md', id, '--quote', 'Outcome measures');
  const it = sc(d).items[0];
  assert.equal(it.status, 'open');
  assert.equal(it.anchor.quote, 'Outcome measures');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI show --needs-reply selects only threads whose last word is the human’s', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'mine, awaiting them');
  fs.writeFileSync(path.join(d, 'doc.md.review.json'), JSON.stringify({ schema: 1, items: [
    ...sc(d).items,
    { id: 'c-theirs', kind: 'comment', by: 'alex', anchor: { quote: 'week one' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'answer me' }] },
  ] }, null, 2));
  const out = cli(d, 'show', 'doc.md', '--needs-reply');
  assert.match(out, /c-theirs/);
  assert.ok(!/awaiting them/.test(out), 'the agent’s own unanswered comment is not "needs reply"');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI show reports full state and the done flag', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'q');
  const out = cli(d, 'show', 'doc.md');
  assert.match(out, /1 item/);
  assert.match(out, /DONE: false/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI check --quote pre-flights a candidate and bisects a failure', () => {
  const d = cliDir();
  const ok = cli(d, 'check', 'doc.md', '--quote', 'Success metrics');
  assert.match(ok, /unambiguous/);
  const e = cliFails(d, 'check', 'doc.md', '--quote', 'Success metrics are measured in bananas');
  assert.ok(e);
  assert.match(e.stderr, /longest matching prefix/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI check (bare) lints every anchor and fails when one cannot resolve', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'q');
  assert.match(cli(d, 'check', 'doc.md'), /^ok /m);
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('Success metrics', 'Outcome measures'));
  const e = cliFails(d, 'check', 'doc.md');
  assert.ok(e);
  assert.match(e.stderr, /cannot resolve/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI rejects an unknown flag rather than silently writing a malformed item', () => {
  const d = cliDir();
  const e = cliFails(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacment', 'typo');
  assert.ok(e);
  assert.equal(e.status, 2);
  assert.match(e.stderr, /unknown flag --replacment/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI fails loudly on a path that does not resolve (never silently addresses nothing)', () => {
  const d = cliDir();
  const e = cliFails(d, 'show', 'nope.md');
  assert.ok(e);
  assert.equal(e.status, 2);
  assert.match(e.stderr, /no file at/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('anchor: a quote spanning two list items matches (block markers are not rendered text)', () => {
  const Anchor = require('./public/anchor.js');
  const raw = '1. **Read** the sidecar.\n2. **Merge** by id.';
  assert.equal(Anchor.findAll(raw, 'Read the sidecar. Merge by id.').length, 1);
  assert.equal(Anchor.findAll('## Heading\n\nBody text', 'Heading Body text').length, 1);
  assert.equal(Anchor.findAll('- alpha\n- beta', 'alpha beta').length, 1);
  assert.equal(Anchor.findAll('> quoted\n> second', 'quoted second').length, 1);
  // Precision must not regress: these are not line-start block markers.
  assert.equal(Anchor.findAll('a well-known thing', 'well-known').length, 1);
  assert.equal(Anchor.findAll('see section 2. it says', 'section 2. it says').length, 1);
});

test('orphan reason distinguishes never-matched from text-changed', () => {
  const { annotateOrphans } = require('./lib/review.js');
  const raw = 'Alpha beta gamma.';
  const born_bad = { items: [{ id: 'x', kind: 'comment', status: 'open', anchor: { quote: 'nowhere in here' } }] };
  annotateOrphans(raw, born_bad);
  assert.equal(born_bad.items[0].orphanReason, 'never-matched');

  const was_good = { items: [{ id: 'y', kind: 'comment', status: 'open', anchor: { quote: 'Alpha' } }] };
  annotateOrphans(raw, was_good);                       // resolves → stamps matchedAt
  assert.equal(was_good.items[0].status, 'open');
  annotateOrphans('Delta epsilon.', was_good);          // human edits it away
  assert.equal(was_good.items[0].status, 'orphaned');
  assert.equal(was_good.items[0].orphanReason, 'text-changed');
});

test('CLI and browser writing concurrently do not drop each other', async () => {
  // The CLI merges in-process; the server merges on PUT. Both go through lib/review.js mergeItem,
  // so an interleaved pair must end with both items present.
  fs.writeFileSync(path.join(dir, 'concurrent.md'), 'Alpha line.\n\nBeta line.\n');
  execFileSync('node', [BIN, 'comment', 'concurrent.md', '--quote', 'Alpha line.', '--text', 'from the CLI'],
    { cwd: dir, encoding: 'utf8' });
  await put('/api/review', { path: 'concurrent.md', review: { schema: 1, items: [
    { id: 'c-browser', kind: 'comment', by: 'alex', anchor: { quote: 'Beta line.' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'from the browser' }] },
  ] } });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'concurrent.md.review.json'), 'utf8'));
  const texts = after.items.flatMap(i => (i.thread || []).map(m => m.text));
  assert.ok(texts.includes('from the CLI'), 'CLI item survived the browser PUT');
  assert.ok(texts.includes('from the browser'), 'browser item survived');
});

/* ---------------------------------------------------------------------------
   Splice safety — the gap an audit of 0fda7d2 found.

   Making the matcher block-tolerant (so a quote taken from the rendered document can span list items)
   silently widened what `accept` would SPLICE. A suggestion quoting across two list items resolved to
   a raw span starting inside `**` and swallowing the `2. `, so accepting wrote corrupted markdown that
   the word-diff never showed. Match loosely, splice strictly.
   --------------------------------------------------------------------------- */

test('spliceRisk: rejects spans that cross block structure, allows ordinary ones', () => {
  const { spliceRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const list = '1. **Read** the sidecar.\n2. **Merge** by id.\n';
  const hit = Anchor.findNth(list, 'Read the sidecar. Merge by id.', 0);
  assert.ok(hit, 'the matcher still finds it (comments need that)');
  assert.match(spliceRisk(list, hit.start, hit.end), /crosses a block boundary/);

  // A soft line break inside one paragraph stays splice-safe — that has always been supported.
  const para = 'One sentence that\nwraps softly here.\n';
  const soft = Anchor.findNth(para, 'sentence that wraps softly', 0);
  assert.equal(spliceRisk(para, soft.start, soft.end), null);

  // Balanced inline markup inside the span is fine; a span ending mid-`**` is not.
  const bold = 'Some **bold text** here.\n';
  const whole = Anchor.findNth(bold, '**bold text**', 0);
  assert.equal(spliceRisk(bold, whole.start, whole.end), null);
  assert.match(spliceRisk(bold, bold.indexOf('bold'), bold.indexOf(' here')), /unbalanced/);

  // Crossing a blank line is two blocks.
  const two = 'Alpha para.\n\nBeta para.\n';
  const across = Anchor.findNth(two, 'Alpha para. Beta para.', 0);
  assert.match(spliceRisk(two, across.start, across.end), /blank line/);
});

test('CLI suggest refuses a cross-block span; comment on the same quote is allowed', () => {
  const d = cliDir();
  const e = cliFails(d, 'suggest', 'doc.md', '--quote', 'Read the sidecar. Merge by id.', '--replacement', 'One step.');
  assert.ok(e, 'suggestion should be refused');
  assert.match(e.stderr, /crosses a block boundary/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.review.json')), 'nothing written');
  // The same quote is fine as a comment — comments anchor, they never splice.
  cli(d, 'comment', 'doc.md', '--quote', 'Read the sidecar. Merge by id.', '--text', 'anchoring is fine');
  assert.equal(sc(d).items.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('accept refuses to splice a cross-block span, and the file is untouched', async () => {
  const md = '# T\n\n1. **Read** the sidecar.\n2. **Merge** by id.\n3. Write it back.\n';
  fs.writeFileSync(path.join(dir, 'splice.md'), md);
  // Written with --force so the card exists despite the CLI's own refusal: accept is the last line of
  // defence and has to hold on its own, for items that reached the sidecar by any route.
  execFileSync('node', [BIN, 'add', 'splice.md', '--force'], { cwd: dir, encoding: 'utf8',
    input: JSON.stringify([{ id: 's-cross', quote: 'Read the sidecar. Merge by id.', replacement: 'REPLACED.' }]),
    stdio: ['pipe', 'pipe', 'pipe'] });
  const r = await post('/api/accept', { path: 'splice.md', id: 's-cross' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /refusing to apply/);
  assert.equal(fs.readFileSync(path.join(dir, 'splice.md'), 'utf8'), md, 'file must be byte-identical');
});

test('accept still applies a normal single-block suggestion', async () => {
  fs.writeFileSync(path.join(dir, 'ok.md'), '# T\n\nWe ship all six features.\n');
  execFileSync('node', [BIN, 'suggest', 'ok.md', '--quote', 'We ship all six features.',
    '--replacement', 'We ship three features.'], { cwd: dir, encoding: 'utf8' });
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'ok.md.review.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'ok.md', id });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'ok.md'), 'utf8'), /We ship three features\./);
});

test('CLI requires --quote rather than crashing with a stack trace', () => {
  const d = cliDir();
  for (const verb of ['comment', 'flag']) {
    const e = cliFails(d, verb, 'doc.md', '--text', 'no quote given');
    assert.equal(e.status, 2, `${verb} should exit 2`);
    assert.match(e.stderr, /usage:/);
    assert.ok(!/TypeError|at Object/.test(e.stderr), `${verb} must not dump a stack`);
  }
  const e = cliFails(d, 'suggest', 'doc.md', '--replacement', 'x');
  assert.equal(e.status, 2);
  assert.ok(!/TypeError/.test(e.stderr));
  fs.rmSync(d, { recursive: true, force: true });
});

test('suggest --id revises an existing card, inheriting its anchor', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--replacement', 'first try');
  const before = sc(d).items[0];
  cli(d, 'suggest', 'doc.md', '--id', before.id, '--replacement', 'second try');
  const after = sc(d).items[0];
  assert.equal(sc(d).items.length, 1, 'revises in place, does not add');
  assert.equal(after.replacement, 'second try');
  assert.deepEqual(after.anchor, before.anchor, 'anchor inherited, not blanked');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add cannot author items as the human', () => {
  const d = cliDir();
  cliStdin(d, JSON.stringify([
    { by: 'alex', quote: 'Success metrics', text: 'pretending to be them' },
  ]), 'add', 'doc.md');
  const it = sc(d).items[0];
  assert.equal(it.by, 'claude', 'item author is whoever ran the command');
  assert.equal(it.thread[0].by, 'claude', 'thread message author too');
});
