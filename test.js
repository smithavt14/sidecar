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
const Flow = require('./public/flow.js');             // ditto — the ```flow renderer

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
    // renderDoc's atomic branch, mirrored: a ```flow fence and a raw-HTML block become uneditable
    // islands whose md0 is the ORIGINAL markdown, so they never reach turndown. Kept in step with the
    // page on purpose — a helper that skipped this would test a document shape the browser never builds.
    const isFlow = b.token.type === 'code' && (b.token.lang || '').trim().toLowerCase() === 'flow';
    if (isFlow || b.token.type === 'html') {
      el.innerHTML = isFlow ? Flow.render(b.token.text || '').svg : DOMPurify.sanitize(b.token.raw);
      if (isFlow) el.__flowNodes = Flow.render(b.token.text || '').nodes;
      el.dataset.atomic = '1';
      el.contentEditable = 'false';
      el.__md = b.token.raw.trim();
      b.md0 = el.__md;
      doc.appendChild(el);
      return;
    }
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

test('presence keys by realpath — a ping via a symlinked path surfaces on the real path', async () => {
  // The same file reached two ways (an alias symlink, mirroring /tmp vs /private/tmp on macOS): the
  // ping arrives via the alias, the browser reads via the real name. Without realpath-keying they land
  // in different buckets and the dot silently never lights.
  const alias = path.join(dir, 'aliasdoc.md');
  fs.symlinkSync(path.join(dir, 'doc.md'), alias);
  try {
    const r = await post('/api/presence', { path: 'aliasdoc.md', state: 'watching' });
    assert.equal((await r.json()).ok, true);
    const s = await state();   // reads ?path=doc.md — the real file
    assert.ok(s.presence, 'a ping via the symlinked alias must surface when reading the real path');
    assert.equal(s.presence.state, 'watching');
  } finally {
    await post('/api/presence', { path: 'doc.md', state: 'idle' });   // leave presence clean for later reads
    fs.rmSync(alias, { force: true });
  }
});

test('presence is per-agent: items merge, working outranks a later watching, one agent cannot clear another', async () => {
  try {
    // Agent a1 exits its wait holding two threads.
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'a1', items: ['t1', 't2'] });
    let p = (await state()).presence;
    assert.equal(p.state, 'working');
    assert.deepEqual(p.items.map(x => x.id).sort(), ['t1', 't2']);
    assert.equal(p.items[0].agent, 'a1', 'each mark names the agent that holds it');
    assert.ok(p.until > Date.now(), 'readout carries its staleness horizon');
    // Agent b2's watching heartbeat lands AFTER a1's working ping: the header must not flap and
    // a1's marks must survive — the case the per-file store got wrong by construction.
    await post('/api/presence', { path: 'doc.md', state: 'watching', agent: 'b2', items: [] });
    p = (await state()).presence;
    assert.equal(p.state, 'working', 'working outranks a more recent watching');
    assert.deepEqual(p.items.map(x => x.id).sort(), ['t1', 't2'], "b2's empty heartbeat must not clear a1's marks");
    // a1 re-arms its wait (watching, empty-handed): its own marks clear, header falls back to watching.
    await post('/api/presence', { path: 'doc.md', state: 'watching', agent: 'a1', items: [] });
    p = (await state()).presence;
    assert.equal(p.state, 'watching');
    assert.deepEqual(p.items, [], "the agent's next ping with the item absent clears the mark");
  } finally {
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'a1' });
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'b2' });
  }
});

test('wait exit ping carries the woken item ids — news and replies mark, a decided item does not', async () => {
  const wf = path.join(dir, 'waitpres.md');
  fs.writeFileSync(wf, '# WP\n\nPresence target line.\n');
  fs.writeFileSync(wf + '.review.json', JSON.stringify({ schema: 1, items: [] }));
  // SIDECAR_PORT points at the REAL test server, so the exit ping lands where /api/state can read it.
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'pwaiter' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'pc1', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Presence target line.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-08-12T12:00:00Z', text: 'mark me' }] },
    { id: 'ps1', kind: 'suggestion', by: 'pwaiter', status: 'accepted',
      anchor: { quote: 'Presence target line.', occurrence: 0 }, replacement: 'x' }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'wait exits 0 once Alex acts');
  const s = await j(await fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('waitpres.md')));
  assert.equal(s.presence?.state, 'working');
  assert.deepEqual(s.presence.items.map(x => x.id), ['pc1'],
    'only the new comment marks — the decided suggestion gets no "replying" light');
  assert.equal(s.presence.items[0].agent, 'pwaiter');
});

test('SIDECAR_USER / SIDECAR_AGENT are surfaced in /api/state (default and override)', async () => {
  const boot = (env) => new Promise((res, rej) => {
    const p = spawn('node', [path.join(__dirname, 'server.js'), dir], { env, stdio: 'pipe' });
    p.stdout.on('data', (d) => { if (d.toString().includes('ready')) res(p); });
    p.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server never became ready')), 8000);
  });
  const read = (port) => fetch(`http://127.0.0.1:${port}/api/state?path=doc.md`).then(j);

  // default: no env set → user 'you', agent 'claude'
  const defEnv = { ...process.env }; delete defEnv.SIDECAR_USER; delete defEnv.SIDECAR_AGENT;
  const p1 = await boot({ ...defEnv, SIDECAR_PORT: String(PORT + 11) });
  try {
    const s = await read(PORT + 11);
    assert.equal(s.user, 'you', 'default human name is "you"');
    assert.equal(s.agent, 'claude', 'default agent name is "claude"');
  } finally { p1.kill(); }

  // override: SIDECAR_USER=pat, SIDECAR_AGENT=robo
  const p2 = await boot({ ...process.env, SIDECAR_PORT: String(PORT + 12), SIDECAR_USER: 'pat', SIDECAR_AGENT: 'robo' });
  try {
    const s = await read(PORT + 12);
    assert.equal(s.user, 'pat', 'SIDECAR_USER overrides the human name in /api/state');
    assert.equal(s.agent, 'robo', 'SIDECAR_AGENT is surfaced too');
  } finally { p2.kill(); }
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
// Same, but feeds stdin — for the `add` refusal paths, which take a JSON payload on stdin.
function cliFailsStdin(d, input, ...args) {
  try { execFileSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }); return null; }
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

test('a CLI write and a browser PUT each survive the other (sequential, not racing)', async () => {
  // The CLI merges in-process; the server merges on PUT. Both go through lib/review.js mergeItem, so
  // an interleaved pair ends with both items present. NOTE this is sequential by construction — it
  // proves merge-on-load, NOT concurrency. Both writers are unlocked read-modify-write, so genuinely
  // simultaneous writes can still lose an item; that window is one synchronous tick and predates the
  // CLI. Don't read this test as covering it.
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

/* `2)` opens an ordered list exactly as `2.` does, and CommonMark treats the delimiter as part of the
   list's identity. replacementRisk was widened to `\d{1,9}[.)]` in fda64d8 and spliceRisk was left
   matching `\d+\.`, so a span that swallowed a `2)` marker read as safe and accept would have written
   the same destroyed list the `2.` case exists to prevent. */
test('spliceRisk: a span crossing a `2)` ordered-list marker is refused', () => {
  const { spliceRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');

  const paren = '1) **Read** the sidecar.\n2) **Merge** by id.\n';
  const hit = Anchor.findNth(paren, '1) **Read** the sidecar. 2) **Merge** by id.', 0);
  assert.ok(hit, 'the matcher still finds it');
  const risk = spliceRisk(paren, hit.start, hit.end);
  assert.match(risk, /crosses a block boundary/);
  assert.match(risk, /"2\)"/, 'and names the marker it found');

  // Mixed delimiters reach the same span from the other side: the matcher strips the `1. ` it already
  // knows, and the `2)` rides along inside the quote.
  const mixed = '1. Read the sidecar.\n2) Merge by id.\n';
  const m = Anchor.findNth(mixed, 'Read the sidecar. 2) Merge by id.', 0);
  assert.ok(m);
  assert.match(spliceRisk(mixed, m.start, m.end), /crosses a block boundary/);

  // Ten digits is past CommonMark's ordered-marker limit, so `\d{1,9}` leaves real prose alone and
  // the widened pattern refuses nothing it did not already refuse.
  const num = 'Order line\n1234567890) shipped.\n';
  assert.equal(spliceRisk(num, 0, num.length - 1), null);
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
    input: JSON.stringify([{ quote: 'Read the sidecar. Merge by id.', replacement: 'REPLACED.' }]),
    stdio: ['pipe', 'pipe', 'pipe'] });
  const scId = JSON.parse(fs.readFileSync(path.join(dir, 'splice.md.review.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'splice.md', id: scId });
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

test('add refuses `by` outright — it cannot author items as the human', () => {
  const d = cliDir();
  const e = cliFailsStdin(d, JSON.stringify([
    { by: 'alex', quote: 'Success metrics', text: 'pretending to be them' },
  ]), 'add', 'doc.md');
  assert.ok(e, 'add with a `by` key is refused');
  assert.match(e.stderr, /"by"/);
  assert.match(e.stderr, /whoever ran the command/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.review.json')), 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

/* Both halves of the splice problem, found by a second audit pass: spliceRisk validated the bytes
   being REMOVED and only caught doubled markers, so single-character emphasis slipped through — and
   nothing at all validated the bytes being INSERTED. */

test('spliceRisk catches single-character marker runs without refusing arithmetic', () => {
  const { spliceRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const risk = (raw, q) => { const h = Anchor.findNth(raw, q, 0); return h && spliceRisk(raw, h.start, h.end); };

  assert.match(risk('*ital* text here', 'ital text here'), /dangling marker/);
  assert.match(risk('_under_ text here', 'under text here'), /dangling marker/);
  assert.match(risk('~~struck~~ text', 'struck text'), /dangling marker/);

  // Must NOT refuse: replacing the interior of a marked run, arithmetic, a whole marked span.
  assert.equal(risk('a **b** c', 'b'), null, 'replacing inside a bold run is fine');
  assert.equal(risk('2 * 3 equals 6', '2 * 3'), null, 'an unpaired * is multiplication, not emphasis');
  assert.equal(risk('with **bold** text', '**bold** text'), null);
  assert.equal(risk('snake_case here', 'snake_case here'), null);
});

test('replacementRisk refuses structure injected mid-block, allows a whole-block rewrite', () => {
  const { replacementRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const risk = (raw, q, rep) => { const h = Anchor.findNth(raw, q, 0); return replacementRisk(raw, h.start, h.end, rep); };

  const list = 'Intro para.\n\n- item one\n- item two\n';
  assert.match(risk(list, 'item one', 'one\n\n## Injected\n\nmore'), /list item|split/);

  const para = 'Alpha paragraph here.\n\nBeta.\n';
  assert.equal(risk(para, 'Alpha paragraph here.', 'One.\n\nTwo.'), null,
    'a whole paragraph may become two — this is the documented heredoc case');
  assert.match(risk(para, 'paragraph', 'x\n\n- a\n- b'), /part of a line/);
  assert.match(risk(para, 'Alpha paragraph here.', 'has **one opener'), /unbalanced/);
});

/* The one block-structured replacement a list can take safely, and the reason the rule above grew a
   second branch: "add a bullet here" is the most common suggestion an agent writes about a list, and
   an item-for-items splice at the same level leaves the same list behind. Everything else stays
   refused, so these pin both sides of that line. */
test('replacementRisk allows list items spliced over a whole list item, and refuses the rest', () => {
  const { replacementRisk } = require('./lib/review.js');
  const Anchor = require('./public/anchor.js');
  const risk = (raw, q, rep) => { const h = Anchor.findNth(raw, q, 0); return replacementRisk(raw, h.start, h.end, rep); };

  const list = 'Intro para.\n\n- alpha item\n- beta item\n- gamma item\n';
  assert.equal(risk(list, '- beta item', '- new item\n- beta item'), null, 'insert a bullet before');
  assert.equal(risk(list, '- gamma item', '- gamma item\n- new item'), null, 'append after the last item');
  assert.equal(risk(list, '- beta item', '- beta item\n- new item\n  wrapped onto a second line'), null);
  assert.equal(risk(list, '- beta item', '- beta item\n  - nested under it'), null);

  // The quote has to cover the marker. Without it the span is part of a line, the old marker stays
  // put, and the first new item lands behind it.
  assert.match(risk(list, 'beta item', '- new item\n- beta item'), /part of a line/);
  // A different bullet character opens a SECOND list in CommonMark, and a different indent moves the
  // item to another level, so both are refused instead of guessed at.
  assert.match(risk(list, '- beta item', '* new item\n- beta item'), /same indentation/);
  assert.match(risk(list, '- beta item', '  - deeper item\n- beta item'), /own marker/);
  assert.match(risk(list, '- beta item', '- beta item\n\n## Heading'), /blank line/);
  assert.match(risk(list, '- beta item', '- beta item\n- new item\nloose paragraph'), /not a list item/);

  // Ordered lists: the first marker is kept verbatim, since CommonMark takes the list's start number
  // from the first item alone. Later numbers may be anything, and `1)` is a different list from `1.`.
  const ord = '1. first\n2. second\n3. third\n';
  assert.equal(risk(ord, '2. second', '2. second\n3. inserted'), null);
  assert.equal(risk(ord, '2. second', '2. second\n9. renumbering does not reach the render'), null);
  assert.match(risk(ord, '2. second', '5. second\n6. inserted'), /own marker/);
  assert.match(risk(ord, '2. second', '2. second\n3) inserted'), /not a list item/);

  // A continuation line left outside the span would reparent onto whichever item the replacement
  // ends with, so the span has to cover the whole item.
  const wrap = '- one item\n  wraps to here\n- two\n';
  assert.match(risk(wrap, '- one item', '- one item\n- new item'), /continues it/);
  assert.equal(risk(wrap, '- one item wraps to here', '- one item\n  wraps to here\n- new item'), null);

  // Blockquotes stay refused: every injected line would need its own `>` prefix to stay in the quote,
  // and one line of a quote is not a whole block the way a list item is.
  assert.match(risk('> quoted line\n', '> quoted line', '> quoted line\n> more'), /blockquote/);
});

test('accept splices a new bullet into a list at the same level', async () => {
  const md = '# T\n\nIntro.\n\n- alpha item\n- beta item\n';
  fs.writeFileSync(path.join(dir, 'bullet.md'), md);
  // No --force: this one passes the write-time check too, which is half the point.
  execFileSync('node', [BIN, 'add', 'bullet.md'], { cwd: dir, encoding: 'utf8',
    input: JSON.stringify([{ quote: '- beta item', replacement: '- inserted item\n- beta item' }]),
    stdio: ['pipe', 'pipe', 'pipe'] });
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'bullet.md.review.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'bullet.md', id });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'bullet.md'), 'utf8'),
    '# T\n\nIntro.\n\n- alpha item\n- inserted item\n- beta item\n');
});

test('accept refuses a replacement that would inject a heading into a list item', async () => {
  const md = '# T\n\nIntro.\n\n- item one\n- item two\n';
  fs.writeFileSync(path.join(dir, 'inject.md'), md);
  execFileSync('node', [BIN, 'add', 'inject.md', '--force'], { cwd: dir, encoding: 'utf8',
    input: JSON.stringify([{ quote: 'item one', replacement: 'one\n\n## Injected\n\nmore' }]),
    stdio: ['pipe', 'pipe', 'pipe'] });
  const injId = JSON.parse(fs.readFileSync(path.join(dir, 'inject.md.review.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'inject.md', id: injId });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'inject.md'), 'utf8'), md, 'file untouched');
});

test('CLI suggest refuses the same replacement at write time', () => {
  const d = cliDir();
  // A PART of a line — replacing it with block structure would split the paragraph around it.
  const e = cliFails(d, 'suggest', 'doc.md', '--quote', 'Success metrics',
    '--replacement', 'Metrics.\n\n## New Section\n\nBody.');
  assert.ok(e);
  assert.match(e.stderr, /block structure/);
  // The whole line, on the other hand, may legitimately become several blocks.
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.',
    '--replacement', 'Metrics.\n\n## Targets\n\n200 signups by March.');
  assert.equal(sc(d).items.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI suggest writes a new list item, and still refuses a mismatched one', () => {
  const d = cliDir();
  // The heredoc case from the skill: a whole ordered item becomes itself plus a new step.
  cliStdin(d, '1. **Read** the sidecar.\n2. **Check** the anchor.', 'suggest', 'doc.md',
    '--quote', '1. **Read** the sidecar.', '--replacement', '-');
  assert.equal(sc(d).items.length, 1);
  assert.equal(sc(d).items[0].kind, 'suggestion');
  // Same shape, wrong marker style: refused at write time rather than at accept time.
  const e = cliFailsStdin(d, '- **Merge** by id.\n- **New step.** Added here.', 'suggest', 'doc.md',
    '--quote', '2. **Merge** by id.', '--replacement', '-');
  assert.ok(e);
  assert.match(e.stderr, /own marker/);
  assert.equal(sc(d).items.length, 1, 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI refuses non-markdown files', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'code.js'), 'const x = 1;\n# not a heading\n- not a list\n');
  const e = cliFails(d, 'show', 'code.js');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /reviews markdown/);
  // .markdown and friends are still accepted.
  fs.writeFileSync(path.join(d, 'other.markdown'), '# Doc\n\nText here.\n');
  cli(d, 'comment', 'other.markdown', '--quote', 'Text here.', '--text', 'ok');
  assert.ok(fs.existsSync(path.join(d, 'other.markdown.review.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('a partial update never erases the status of the item it merges into', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'first');
  const id = sc(d).items[0].id;
  cli(d, 'reply', 'doc.md', id, 'a plain reply, no --resolve');
  assert.equal(sc(d).items[0].status, 'open', 'reply must not blank the status');
  assert.equal(sc(d).items[0].thread.length, 2);
  // …and `show` has to survive whatever is on disk regardless.
  assert.match(cli(d, 'show', 'doc.md'), /OPEN/);

  // Same at the merge layer, directly: incoming carries no opinion about status.
  const { mergeItem } = require('./lib/review.js');
  const merged = mergeItem(
    { id: 'x', kind: 'comment', status: 'resolved', decidedAt: '2026-01-01T00:00:00Z', thread: [] },
    { id: 'x', thread: [{ by: 'claude', at: '2026-01-02T00:00:00Z', text: 'late reply' }] });
  assert.equal(merged.status, 'resolved', 'a partial update must not regress a decided status');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   Matcher pinning — the block-tolerant matcher has secondary match surfaces the 2026-07-23 audit
   found (prose+code, table cells, spaced rules). The decision record chose to PIN these with tests
   rather than make the matcher fence-aware — adding fence-state tracking to normalize(), which also
   maintains the offset map accept splices against, is complexity in the single most safety-critical
   function to fix a cosmetic ambiguity count. Behaviour that is accidental AND untested is how a
   matcher silently changes under you. These lock HEAD's behaviour so a future edit has to face it.
   Pure Anchor.findAll / spliceRisk units — no server, no matcher change.
   --------------------------------------------------------------------------- */

test('matcher pin: a quote spans prose into an indented code block, and spliceRisk refuses that splice', () => {
  const Anchor = require('./public/anchor.js');
  const { spliceRisk } = require('./lib/review.js');
  // Indented code block after a prose line: the 4-space indent is whitespace, collapsed like any run,
  // so the tolerant pass matches across it. Match loosely — but the span crosses the blank line, so a
  // suggestion over it is refused before accept can splice structure away.
  const raw = 'Prose start.\n\n    not a list, code\n';
  const hits = Anchor.findAll(raw, 'Prose start. not a list, code');
  assert.equal(hits.length, 1, 'prose+indented-code matches (pinned)');
  const hit = Anchor.findNth(raw, 'Prose start. not a list, code', 0);
  assert.match(spliceRisk(raw, hit.start, hit.end), /blank line/, 'and a splice over it is refused');
});

test('matcher pin: a quote does NOT span prose into a FENCED code block', () => {
  const Anchor = require('./public/anchor.js');
  // HEAD behaviour, run before pinning: the ``` fence lines strip to nothing on the tolerant pass, but
  // the two collapsed whitespace runs around them leave a DOUBLE space in the haystack that the
  // single-spaced needle can't match. Fence-crossing quotes miss — the same "accident" as the spaced
  // rule below. Pinned so the accident becomes a contract; a fence-aware matcher was rejected.
  const raw = 'Prose line.\n\n```\ncode line\n```\n';
  assert.equal(Anchor.findAll(raw, 'Prose line. code line').length, 0, 'no cross-fence match (pinned)');
});

test('matcher pin: `- -` matches the delimiter cells of a table row', () => {
  const Anchor = require('./public/anchor.js');
  // The tolerant pass is fence/table-unaware, so `| - | - |` exposes two `- ` "matches" the human
  // can neither see nor select. Verified count, not assumed: two hits, one per delimiter cell.
  const row = '| - | - |';
  assert.equal(Anchor.findAll(row, '- -').length, 2, 'two delimiter-cell hits (verified)');
  const table = '| a | b |\n| - | - |\n| c | d |\n';
  assert.equal(Anchor.findAll(table, '- -').length, 2, 'same inside a full table');
});

test('matcher pin: a quote does NOT match across a spaced horizontal rule `- - -`', () => {
  const Anchor = require('./public/anchor.js');
  // Audit 1: the stacked block-marker loop strips `- - -` down to a single leftover `-`, so text on
  // either side of the rule stays separated by that `-` and a cross-rule quote misses. Called an
  // "accident" in the audit; the decision record pins it as a contract.
  const raw = 'Alpha text\n\n- - -\n\nBeta text\n';
  assert.equal(Anchor.findAll(raw, 'Alpha text Beta text').length, 0, 'no cross-rule match (pinned)');
});

test('matcher pin: a comment can still anchor to text inside a fenced code block', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'fence.md'), '# Doc\n\nIntro.\n\n```js\nconst x = 1;\n```\n');
  // Match-loosely stays half intact: the code content is selectable text, so a COMMENT (which only
  // anchors, never splices) resolves and writes. This is what the "restrict, don't rewrite the matcher"
  // call preserves — highlighting a fence is fine; only splicing across one is refused.
  cli(d, 'comment', 'fence.md', '--quote', 'const x = 1;', '--text', 'anchoring into a fence is allowed');
  const it = JSON.parse(fs.readFileSync(path.join(d, 'fence.md.review.json'), 'utf8')).items[0];
  assert.equal(it.kind, 'comment');
  assert.equal(it.anchor.quote, 'const x = 1;');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   Safety guards — the 2026-07-23 decision record's "the one that matters": accept/reject are absent
   from the CLI on purpose (the human decides), but three commands routed around it — `add` passing a
   status/thread wholesale, and `resolve` / `reply --resolve` settling a suggestion. Each forged a
   decision the human never made. These close all three and prove the happy paths are unchanged.
   --------------------------------------------------------------------------- */

test('add refuses a fabricated decision (status + thread) and writes nothing', () => {
  const d = cliDir();
  // The decision record's probe, generalised: an agent tries to seed a card already "accepted", with a
  // human-looking thread. Both keys are the human's; add refuses by name and leaves no sidecar.
  const e = cliFailsStdin(d, JSON.stringify([
    { quote: 'Success metrics', text: 'looks settled', status: 'accepted',
      thread: [{ by: 'alex', at: '2026-01-01T00:00:00Z', text: 'forged approval' }] },
  ]), 'add', 'doc.md');
  assert.ok(e, 'refused');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /status/);
  assert.match(e.stderr, /thread/);
  assert.match(e.stderr, /belong to the human/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.review.json')), 'sidecar untouched — nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add refuses the decision-record heredoc verbatim (id + status:"accepted")', () => {
  const d = cliDir();
  // The exact payload from the audit disposition. It forges an id AND a decision; both are refused.
  const e = cliFailsStdin(d,
    '[{"id":"s-fake","quote":"Alpha line here.","replacement":"Beta.","status":"accepted"}]',
    'add', 'doc.md');
  assert.ok(e, 'refused');
  assert.match(e.stderr, /"id"/);
  assert.match(e.stderr, /"status"/);
  assert.match(e.stderr, /suggest --id/, 'points the agent at the real revise path');
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.review.json')), 'sidecar untouched');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add refuses `anchor` passthrough, naming the fields to use instead', () => {
  const d = cliDir();
  const e = cliFailsStdin(d, JSON.stringify([
    { anchor: { quote: 'Success metrics', occurrence: 0 }, text: 'hi' },
  ]), 'add', 'doc.md');
  assert.ok(e);
  assert.match(e.stderr, /"anchor"/);
  assert.match(e.stderr, /quote/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('add --force does NOT bypass the key allow-list (it is a boundary, not a warning)', () => {
  const d = cliDir();
  const e = cliFailsStdin(d, JSON.stringify([{ quote: 'Success metrics', text: 'x', status: 'accepted' }]),
    'add', 'doc.md', '--force');
  assert.ok(e, 'still refused with --force');
  assert.match(e.stderr, /status/);
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.review.json')), 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('resolve refuses a suggestion, pointing at the browser and drop; still resolves a comment', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--replacement', 'Target: 200 signups.');
  const sug = sc(d).items[0];
  const e = cliFails(d, 'resolve', 'doc.md', sug.id);
  assert.ok(e, 'suggestion resolve refused');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /suggestion/);
  assert.match(e.stderr, /drop/);
  assert.equal(sc(d).items[0].status, 'pending', 'the card was not settled');

  // A comment resolve is unchanged.
  cli(d, 'comment', 'doc.md', '--quote', 'week one', '--text', 'closing this');
  const com = sc(d).items.find(i => i.kind === 'comment');
  cli(d, 'resolve', 'doc.md', com.id);
  assert.equal(sc(d).items.find(i => i.id === com.id).status, 'resolved');
  fs.rmSync(d, { recursive: true, force: true });
});

test('reply --resolve refuses a suggestion; a plain reply on it stays legal', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--replacement', 'Target: 200 signups.');
  const id = sc(d).items[0].id;
  const e = cliFails(d, 'reply', 'doc.md', id, 'settling it', '--resolve');
  assert.ok(e, 'reply --resolve on a suggestion refused');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /suggestion/);
  assert.equal(sc(d).items[0].status, 'pending', 'not settled');
  assert.equal((sc(d).items[0].thread || []).length, 0, 'the refused message was not appended either');

  // A plain reply (a message, no status) is allowed on a suggestion.
  cli(d, 'reply', 'doc.md', id, 'one more thought');
  assert.equal(sc(d).items[0].status, 'pending');
  assert.equal(sc(d).items[0].thread[0].text, 'one more thought');
  fs.rmSync(d, { recursive: true, force: true });
});

test('add happy paths unchanged: replyTo, flag, and kind inference all pass through', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'parent comment');
  const parent = sc(d).items[0];
  cliStdin(d, JSON.stringify([
    { quote: 'week one', text: 'a flagged concern', flag: true },
    { quote: 'Success metrics are not defined yet.', replacement: 'Target: 200 signups.', replyTo: parent.id },
  ]), 'add', 'doc.md');
  const items = sc(d).items;
  const flagged = items.find(i => i.flag);
  assert.ok(flagged, 'flag passes through');
  assert.equal(flagged.kind, 'comment', 'no replacement → comment');
  const answer = items.find(i => i.replyTo === parent.id);
  assert.ok(answer, 'replyTo passes through');
  assert.equal(answer.kind, 'suggestion', 'replacement present → suggestion');
  assert.equal(answer.by, 'claude');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   P2 — the persistent last-seen cursor: `sidecar digest` and `wait` over it
   (lib/digest.js). Same real-binary + temp-fixture pattern as the CLI block.
   --------------------------------------------------------------------------- */

// env-passing variant of cli() — the cursor is keyed by SIDECAR_AGENT.
const cliE = (d, env, ...args) => execFileSync('node', [BIN, ...args],
  { cwd: d, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
// Patch the on-disk review the way the browser/server would (add a human item, a reply, a decision).
const patchReview = (d, fn) => { const p = path.join(d, 'doc.md.review.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8')); fn(r); fs.writeFileSync(p, JSON.stringify(r, null, 2)); };
const seen = (d) => { const p = path.join(d, 'doc.md.review.seen.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
// Run `sidecar wait` as a real background process; `onReady` fires once the watcher is up so a test
// can trigger an fs event. No server on SIDECAR_PORT here — presence pings just fail fast (400ms).
function spawnWait(d, { agent = 'claude', timeout = 10, onReady, readyDelay = 800 } = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [BIN, 'wait', 'doc.md', '--timeout', String(timeout)],
      { cwd: d, env: { ...process.env, SIDECAR_AGENT: agent, SIDECAR_PORT: '4993' } });
    let out = ''; p.stdout.on('data', c => (out += c));
    p.on('exit', (code) => resolve({ code, out }));
    if (onReady) setTimeout(() => onReady(p), readyDelay);
  });
}

test('digest: no cursor → flagged full summary, cursor written; second digest says nothing new', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  const first = cli(d, 'digest', 'doc.md');
  assert.match(first, /no last-seen marker/, 'first look is flagged as a full replay');
  assert.match(first, /NEW suggestion @ .*Week one ships three|NEW suggestion @/, 'the seeded card shows');
  assert.ok(seen(d).claude, 'cursor written under the agent key');
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new since/, 'second look is empty');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: comment + reply + accept stacked between two looks → ONE digest reports all three', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');                       // establish the cursor
  // Human, off-screen: accepts the suggestion (doc spliced + status), replies to the comment, adds a new one.
  fs.writeFileSync(path.join(d, 'doc.md'),
    fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('We will ship all six features in week one.', 'Week one ships three.'));
  patchReview(d, (r) => {
    const sug = r.items.find(i => i.kind === 'suggestion'); sug.status = 'accepted'; sug.decidedAt = '2026-07-23T00:00:00Z';
    const com = r.items.find(i => i.kind === 'comment'); com.by = 'alex';
    com.thread.push({ by: 'alex', at: '2026-07-23T00:00:01Z', text: 'yes, three concrete ones' });
    r.items.push({ id: 'c-new-human', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Repeated line here.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-23T00:00:02Z', text: 'is this duplicated on purpose?' }] });
  });
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /ACCEPTED/, 'the accept');
  assert.match(out, /REPLY .*yes, three concrete ones/, 'the reply, in full');
  assert.match(out, /NEW comment .*is this duplicated on purpose\?/, 'the new comment, in full');
  fs.rmSync(d, { recursive: true, force: true });
});

/* The gap that made suggestion threads unsafe to ship. A card the agent creates AFTER its last look is
   outside the cursor, and the "not news to me, I wrote it" branch used to skip the whole item, taking
   any message someone else had already put on it down with it. `suggest` then `wait` is the normal
   order, so Alex's first reply on a fresh suggestion landed in that gap and `wait` slept to its timeout.
   Reachable on a comment too; threaded suggestion cards just make it the common path. */
test('digest: a reply on the agent’s OWN new card surfaces as a REPLY', () => {
  const d = cliDir();
  cli(d, 'digest', 'doc.md');                       // cursor established while the review is empty
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  const sug = sc(d).items[0].id;
  cli(d, 'comment', 'doc.md', '--quote', 'week one', '--text', 'is this the right scope?');
  const com = sc(d).items.find(i => i.kind === 'comment').id;
  cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', sug, 'why drop that word?');
  cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', com, 'scope is fine, ship it');
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /REPLY .*why drop that word\?/, 'the reply on the agent’s own suggestion');
  assert.match(out, /REPLY .*scope is fine, ship it/, 'and on its own comment');
  fs.rmSync(d, { recursive: true, force: true });
});

// The guard on that fix: it keys on WHO wrote the message, never on "this card has a thread". An agent
// reporting its own replies back to itself would make every `reply` wake its own `wait`.
test('digest: the agent’s own fresh card stays silent when only the agent has written on it', () => {
  const d = cliDir();
  cli(d, 'digest', 'doc.md');
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'reply', 'doc.md', sc(d).items[0].id, 'a second thought of my own');
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new since/, 'nothing here is addressed to me');
  fs.rmSync(d, { recursive: true, force: true });
});

// A full replay has no cursor, so the card itself is news and its last message is the text shown. The
// reply must not ALSO be listed separately, or the first look double-reports every discussed card.
test('digest: a discussed agent card reports once on a full replay, as NEW', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', sc(d).items[0].id, 'say more about this');
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /no last-seen marker/, 'this is the full-replay path');
  assert.match(out, /NEW suggestion .*say more about this/, 'reported as the new card');
  assert.equal(out.match(/say more about this/g).length, 1, 'reported exactly once, not as NEW and REPLY');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest --peek reports the delta but does NOT advance the cursor', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'digest', 'doc.md');                       // cursor at pending
  patchReview(d, (r) => { const s = r.items[0]; s.status = 'rejected'; s.decidedAt = '2026-07-23T00:00:00Z'; });
  const before = JSON.stringify(seen(d));
  assert.match(cli(d, 'digest', 'doc.md', '--peek'), /REJECTED/, 'peek still reports the change');
  assert.equal(JSON.stringify(seen(d)), before, 'peek left the cursor untouched');
  assert.match(cli(d, 'digest', 'doc.md', '--peek'), /REJECTED/, 'so a second peek reports it again');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest --json emits the structured delta and round-trips', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  const parsed = JSON.parse(cli(d, 'digest', 'doc.md', '--json'));
  assert.ok(parsed.snapshot && parsed.snapshot.items, 'carries the snapshot to advance to');
  assert.equal(parsed.noMarker, true, 'first look, no marker');
  assert.ok(Array.isArray(parsed.news), 'structured sections present');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: two SIDECAR_AGENT values hold independent cursors', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cliE(d, { SIDECAR_AGENT: 'claude' }, 'digest', 'doc.md');   // advances claude only
  const s = seen(d);
  assert.ok(s.claude && !s.gpt, 'only claude has a cursor so far');
  assert.match(cliE(d, { SIDECAR_AGENT: 'gpt' }, 'digest', 'doc.md'), /no last-seen marker/, 'gpt still sees a full replay');
  assert.match(cliE(d, { SIDECAR_AGENT: 'claude' }, 'digest', 'doc.md'), /nothing new/, 'claude is caught up');
  assert.ok(seen(d).claude && seen(d).gpt, 'both cursors coexist in one file');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: corrupt or deleted seen file → no crash, treated as a full replay', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  fs.writeFileSync(path.join(d, 'doc.md.review.seen.json'), '{ this is not json');
  const out = cli(d, 'digest', 'doc.md');            // must not throw
  assert.match(out, /no last-seen marker/, 'corrupt cursor degrades to full replay');
  fs.rmSync(path.join(d, 'doc.md.review.seen.json'));
  assert.match(cli(d, 'digest', 'doc.md'), /no last-seen marker/, 'a deleted cursor replays too');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: reject + human reply carries the reason text IN FULL', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  cli(d, 'digest', 'doc.md');
  const reason = 'no — leadership already committed to six externally, keep it';
  patchReview(d, (r) => { const s = r.items[0]; s.status = 'rejected'; s.decidedAt = '2026-07-23T00:00:00Z';
    s.thread = [{ by: 'alex', at: '2026-07-23T00:00:01Z', text: reason }]; });
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /REJECTED/);
  assert.ok(out.includes(reason), 'the full rejection reason is present, unclipped');
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait: a pre-existing unseen backlog exits immediately and advances the cursor', async () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  cli(d, 'digest', 'doc.md');                        // cursor at threadLen 0
  patchReview(d, (r) => { r.items[0].thread = [{ by: 'alex', at: '2026-07-23T00:00:00Z', text: 'why only three?' }]; });
  const t0 = Date.now();
  const { code, out } = await spawnWait(d, { timeout: 30 });   // no onReady — must exit on its own
  assert.ok(Date.now() - t0 < 5000, 'returned well before the 30s timeout');
  assert.equal(code, 0, 'digest-emitting exit');
  assert.match(out, /REPLY .*why only three\?/, 'reports the backlog it had not seen');
  assert.equal(seen(d).claude.items[Object.keys(seen(d).claude.items)[0]].threadLen, 1, 'cursor advanced past the reply');
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait: a timeout exit does NOT advance the cursor', async () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');                        // cursor == current state
  const before = JSON.stringify(seen(d));
  const { code, out } = await spawnWait(d, { timeout: 1 });   // nothing happens → times out
  assert.equal(code, 1, 'timeout exit code');
  assert.match(out, /still watching/);
  assert.equal(JSON.stringify(seen(d)), before, 'a timeout must not move the cursor');
  fs.rmSync(d, { recursive: true, force: true });
});

// The end of the loop the digest fix exists to close: the agent suggests, arms `wait`, and Alex asks a
// question on the card instead of deciding it. Before the fix this slept to the timeout (exit 1) with
// the reply sitting on disk, leaving the agent silent on a direct question.
test('wait: wakes on a reply to a suggestion the agent made after its last look', async () => {
  const d = cliDir();
  cli(d, 'digest', 'doc.md');                        // cursor established before the card exists
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  const id = sc(d).items[0].id;
  const { code, out } = await spawnWait(d, { timeout: 10, onReady: () =>
    cliE(d, { SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', id, 'talk me through this one first') });
  assert.equal(code, 0, 'woke and emitted, rather than timing out');
  assert.match(out, /REPLY .*talk me through this one first/, 'the question is in the digest');
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait: an accept prints the digest exactly once (double-print regression)', async () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'We will ship all six features in week one.', '--replacement', 'Week one ships three.');
  // No cursor → baseline is current state → wait sleeps until a real change.
  const { code, out } = await spawnWait(d, { timeout: 10, onReady: () => {
    // An accept touches BOTH files (doc splice + status write) → two chokidar events in quick succession.
    fs.writeFileSync(path.join(d, 'doc.md'),
      fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('We will ship all six features in week one.', 'Week one ships three.'));
    patchReview(d, (r) => { r.items[0].status = 'accepted'; r.items[0].decidedAt = '2026-07-23T00:00:00Z'; });
  } });
  assert.equal(code, 0);
  assert.equal((out.match(/## sidecar — your turn/g) || []).length, 1, 'exactly one digest header');
  assert.equal((out.match(/ACCEPTED/g) || []).length, 1, 'exactly one ACCEPTED line');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   Doc baseline — the digest's own copy of the document (lib/digest.js basePath).
   The doc half of the digest diffs against the agent's last look, not git HEAD:
   untracked docs, non-git dirs, and mid-review commits must all produce real
   hunks, and nothing may be re-sent across looks.
   --------------------------------------------------------------------------- */

const basefile = (d, agent = 'claude', doc = 'doc.md') => path.join(d, doc + '.review.seen.base.' + agent);
// The fixture without git — sidecar's serverless contract says this must work identically.
function cliDirNoGit() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-cli-'));
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  return d;
}

test('baseline: written on digest advance, not on --peek, not on a wait timeout', async () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md', '--peek');
  assert.ok(!fs.existsSync(basefile(d)), 'peek advances neither cursor nor baseline');
  cli(d, 'digest', 'doc.md');
  assert.equal(fs.readFileSync(basefile(d), 'utf8'), CLI_DOC, 'advance writes the doc text as-of-this-look');
  const before = fs.readFileSync(basefile(d), 'utf8');
  const { code } = await spawnWait(d, { timeout: 1 });          // nothing happens → times out
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(basefile(d), 'utf8'), before, 'a timeout must not move the baseline');
  fs.rmSync(d, { recursive: true, force: true });
});

test('baseline: two SIDECAR_AGENT values hold independent baselines', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cliE(d, { SIDECAR_AGENT: 'claude' }, 'digest', 'doc.md');
  assert.ok(fs.existsSync(basefile(d, 'claude')) && !fs.existsSync(basefile(d, 'gpt')), 'only claude has a baseline so far');
  cliE(d, { SIDECAR_AGENT: 'gpt' }, 'digest', 'doc.md');
  assert.ok(fs.existsSync(basefile(d, 'gpt')), 'both baselines coexist as separate files');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: a doc edit produces hunks in an UNTRACKED file (the empty-digest hole)', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'new.md'), CLI_DOC);            // never committed — git diff sees nothing
  cli(d, 'comment', 'new.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'new.md');                                   // cursor + baseline
  fs.writeFileSync(path.join(d, 'new.md'), CLI_DOC.replace('Success metrics are not defined yet.', 'Success metrics: 200 signups.'));
  const out = cli(d, 'digest', 'new.md');
  assert.match(out, /### doc changes \(since your last look\)/, 'the diff section renders');
  assert.match(out, /-Success metrics are not defined yet\./, 'the removed line');
  assert.match(out, /\+Success metrics: 200 signups\./, 'the added line');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: same, in a directory that is not a git repo at all', () => {
  const d = cliDirNoGit();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('# Plan', '# The Plan'));
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /-# Plan/, 'hunks with no git anywhere');
  assert.match(out, /\+# The Plan/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: hunks are since the LAST LOOK — an earlier, already-reported edit is not re-sent', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  fs.writeFileSync(path.join(d, 'doc.md'),                       // edit A, near the top
    fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('We will ship all six features in week one.', 'Week one ships three.'));
  assert.match(cli(d, 'digest', 'doc.md'), /\+Week one ships three\./, 'edit A reported once');
  fs.writeFileSync(path.join(d, 'doc.md'),                       // edit B, far from A
    fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('3. **Write** it back.', '3. **Write** it back, atomically.'));
  const out = cli(d, 'digest', 'doc.md');
  assert.match(out, /\+3\. \*\*Write\*\* it back, atomically\./, 'edit B reported');
  assert.ok(!out.includes('Week one ships three'), 'edit A does NOT ride along again');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: a mid-review commit no longer blanks the diff channel', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm checkpoint', { cwd: d });
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('# Plan', '# The Plan'));
  const out = cli(d, 'digest', 'doc.md');                        // git diff vs HEAD would show this too — but
  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm edit', { cwd: d });
  const out2Setup = fs.readFileSync(path.join(d, 'doc.md'), 'utf8');   // now HEAD == worktree: git diff is EMPTY
  fs.writeFileSync(path.join(d, 'doc.md'), out2Setup.replace('Repeated line here.\n\nRepeated line here.', 'One line here.'));
  const out2 = cli(d, 'digest', 'doc.md');
  assert.match(out, /\+# The Plan/, 'hunks after a checkpoint commit');
  assert.match(out2, /\+One line here\./, 'hunks even when the worktree is clean at HEAD');
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest: missing or stale baseline with a live cursor → flagged, no crash, self-heals', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  fs.writeFileSync(basefile(d), 'some other version entirely');  // hash no longer matches cursor.docHash
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC.replace('# Plan', '# The Plan'));
  const out = cli(d, 'digest', 'doc.md');                        // must not throw, must not diff the wrong text
  assert.match(out, /doc changed \(no baseline/, 'stale baseline degrades loudly');
  assert.ok(!out.includes('some other version'), 'and never diffs against the wrong version');
  assert.equal(fs.readFileSync(basefile(d), 'utf8'), fs.readFileSync(path.join(d, 'doc.md'), 'utf8'),
    'the advance rewrote the baseline');
  fs.writeFileSync(path.join(d, 'doc.md'), fs.readFileSync(path.join(d, 'doc.md'), 'utf8').replace('# The Plan', '# The Real Plan'));
  assert.match(cli(d, 'digest', 'doc.md'), /\+# The Real Plan/, 'next look diffs normally again');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------------------------
   VISUALS — ```flow diagrams, raw-HTML islands, and the /assets image route.

   The load-bearing property is that a rendered block never reaches turndown: turndown cannot round-
   trip an <svg> (it comes back as the bare label text) so an editable diagram would be destroyed by
   the first stray keystroke. Atomic blocks make that path unreachable rather than unlikely, and the
   tests below pin it on BOTH serialize paths — the tight one and the block-count-changed fallback
   that produced the original data-loss bug.
   --------------------------------------------------------------------------------------------- */

const FLOW_SRC = '```flow\nSign up --> Verify email\nVerify email --> {Valid?}\n{Valid?} -->|yes| Done\n{Valid?} -->|no| Verify email\n```';
const HTML_SRC = '<div style="display:flex">\n  <span>before</span>\n  <span>after</span>\n</div>';
const VIS_DOC = [
  '# Visuals', '',
  'Intro paragraph mentioning Done in prose.', '',
  FLOW_SRC, '',
  'Middle paragraph.', '',
  HTML_SRC, '',
  'Closing paragraph.', '',
].join('\n');

test('flow parse: nodes, edges, labels, decisions and direction', () => {
  const m = Flow.parse('LR\n%% a comment\nA --> B\nB -->|yes| {C?}\n{C?} --> A');
  assert.equal(m.dir, 'LR', 'a bare LR line sets direction');
  assert.deepEqual(m.nodes.map(n => n.label), ['A', 'B', 'C?'], '%% comments are skipped, nodes dedupe by label');
  assert.equal(m.nodes.find(n => n.label === 'C?').decision, true, '{…} marks a decision');
  assert.equal(m.edges.length, 3);
  assert.equal(m.edges[1].label, 'yes', 'the |label| rides the arrow it follows');
  assert.deepEqual(m.errors, []);
});

test('flow parse: a chained line is several edges, and a node offset points at its own label', () => {
  const src = 'Draft --> Review --> Ship';
  const m = Flow.parse(src);
  assert.equal(m.edges.length, 2, 'A --> B --> C is two edges');
  // `at` is what makes a node comment anchor to ITS mention rather than to some earlier line that
  // happens to share the word — so it has to index the label exactly.
  for (const n of m.nodes) assert.equal(src.substr(n.at, n.label.length), n.label, `offset for ${n.label}`);
});

test('flow parse: a malformed line is reported, not silently dropped', () => {
  const m = Flow.parse('A --> \nB --> C');
  assert.deepEqual(m.errors, ['A -->'], 'the unreadable line is surfaced');
  assert.ok(m.nodes.some(n => n.label === 'C'), 'the readable lines still parse');
});

test('flow layout: a cycle does not inflate ranks, and the back edge is routed around', () => {
  const m = Flow.layout(Flow.parse('A --> B\nB --> C\nC --> A'));
  // Ranking THROUGH a cycle walks every node down a level per pass, leaving a tall ladder with empty
  // rows; the empty rows then read as holes and Math.max over a hole is NaN — a blank diagram.
  const ys = [...new Set(m.nodes.map(n => n.y))];
  assert.equal(ys.length, 3, 'three nodes, three rows — no ladder');
  assert.ok(Number.isFinite(m.width) && Number.isFinite(m.height), 'no NaN in the canvas size');
  assert.equal(m.edges.filter(e => e.back).length, 1, 'exactly the cycle-closing edge is a back edge');
  assert.ok(m.loop > 0, 'the canvas reserves room for the loop, or it clips');
});

test('flow render: an empty fence renders without a negative canvas', () => {
  const m = Flow.layout(Flow.parse(''));
  assert.equal(m.width, 0); assert.equal(m.height, 0);
  const { svg } = Flow.render('');
  assert.ok(!/NaN|undefined/.test(svg), 'no NaN/undefined leaks into the SVG');
});

test('flow render: labels are escaped and data-node carries an index, never flow source', () => {
  const { svg } = Flow.render('<script>x</script> --> B');
  assert.ok(!svg.includes('<script>'), 'a label is escaped, never live markup');
  assert.ok(svg.includes('&lt;script&gt;'));
  // DOMPurify's SAFE_FOR_XML strips any attribute whose value contains `-->`, which is exactly the
  // arrow syntax — so an attribute carrying raw flow source would silently vanish.
  assert.ok(/data-node="\d+"/.test(svg), 'data-node is an index');
  assert.ok(!/data-\w+="[^"]*--&gt;/.test(svg) && !/data-\w+="[^"]*-->/.test(svg), 'no attribute carries an arrow');
});

test('atomic blocks: a flow fence and an HTML island survive an edit elsewhere, byte-for-byte', () => {
  const { doc, blocks, td } = buildDoc(VIS_DOC);
  blockByText(doc, 'Middle paragraph.').querySelector('p').textContent = 'Middle paragraph, edited.';
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true, 'block count unchanged → tight path');
  assert.equal(md, VIS_DOC.replace('Middle paragraph.', 'Middle paragraph, edited.'));
  assert.ok(md.includes(FLOW_SRC), 'the flow fence survived byte-for-byte');
  assert.ok(md.includes(HTML_SRC), 'the HTML island survived byte-for-byte');
});

test('atomic blocks survive the block-count-changed fallback path', () => {
  const { doc, blocks, td } = buildDoc(VIS_DOC);
  blockByText(doc, 'Closing paragraph.').remove();
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, false, 'block count changed → fallback path');
  assert.ok(md.includes(FLOW_SRC), 'flow fence survived the fallback (turndown would flatten it to labels)');
  assert.ok(md.includes(HTML_SRC), 'HTML island survived the fallback');
  assert.ok(!md.includes('Closing paragraph.'), 'the removed block is gone');
});

test('atomic blocks are not editable, so the turndown path is unreachable for them', () => {
  const { doc } = buildDoc(VIS_DOC);
  const atomic = [...doc.querySelectorAll('.block[data-atomic]')];
  assert.equal(atomic.length, 2, 'the flow fence and the HTML block are both atomic');
  for (const el of atomic) assert.equal(el.contentEditable, 'false');
});

test('toMd on an atomic block with no source THROWS rather than flattening it', () => {
  const { doc, td } = buildDoc(VIS_DOC);
  const el = doc.querySelector('.block[data-atomic]');
  delete el.__md;
  // A silent turndown fallback here IS the data-loss bug: the diagram would come back as its bare
  // label text and the fence would be gone from the file, with nothing logged.
  assert.throws(() => Serialize.toMd(el, td), /missing its __md/);
});

test('a comment can anchor to a diagram node label inside a flow fence', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-flow-'));
  fs.writeFileSync(path.join(d, 'f.md'), VIS_DOC);
  // A node label appears once per EDGE that names it, so from the CLI a node comment is ambiguous by
  // construction and the existing guard refuses it without --occurrence. That guard is right — this
  // pins the shape agents actually have to use.
  assert.throws(() => cli(d, 'comment', 'f.md', '--quote', 'Verify email', '--text', 'x'),
    /ambiguous — 3 matches/, 'a bare node label is refused, not silently anchored to the first mention');
  cli(d, 'comment', 'f.md', '--quote', 'Verify email', '--occurrence', '0', '--text', 'is this step needed?');
  const it = JSON.parse(fs.readFileSync(path.join(d, 'f.md.review.json'), 'utf8')).items[0];
  assert.equal(it.status, 'open', 'a node label anchors like any other quote — not orphaned');
  const hit = Anchor.findNth(VIS_DOC, it.anchor.quote, it.anchor.occurrence || 0);
  assert.ok(hit, 'the anchor resolves in the document');
  assert.ok(VIS_DOC.slice(hit.start, hit.end) === 'Verify email');
  fs.rmSync(d, { recursive: true, force: true });
});

test('assets: a relative image beside the document is served with a locked-down type', async () => {
  fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
  const r = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent('./pic.svg')}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /image\/svg\+xml/);
  // An SVG is a document, and this origin carries the file read/write API — so nothing it references
  // may load, and the type may not be sniffed into something executable.
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('assets refuses traversal, absolute paths, URLs and non-images', async () => {
  const cases = [
    ['../../../../etc/hosts', 'traversal to a non-image'],
    ['../../../../tmp/evil.png', 'traversal to an image extension outside the root'],
    ['/etc/hosts', 'an absolute path'],
    ['https://example.com/a.png', 'a remote URL'],
    ['./doc.md', 'a non-image inside the root'],
  ];
  for (const [src, why] of cases) {
    const r = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent(src)}`);
    assert.ok(r.status >= 400 && r.status < 500, `${why} must be refused, got ${r.status}`);
    assert.match(r.headers.get('content-type') || '', /json/, `${why}: error must be JSON`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   IMAGES IN COMMENTS — a pasted screenshot becomes a file in `<doc>.review.assets/`
   and a markdown link in the comment body. The review JSON never holds bytes, and
   the reference is the same doc-relative form /assets already serves.
   ──────────────────────────────────────────────────────────────────────────── */
// A real 1×1 PNG. The upload sniffs magic bytes, so a fake buffer wouldn't get through — which is
// the point of having it here rather than asserting against a stub.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const postBytes = (url, buf, type = 'application/octet-stream') =>
  fetchRetry(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': type }, body: buf });

test('asset upload writes a content-hashed file beside the review and returns doc-relative markdown', async () => {
  const r = await postBytes('/api/asset?doc=doc.md', PNG_1x1);
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.match(out.src, /^doc\.md\.review\.assets\/[0-9a-f]{12}\.png$/);
  assert.equal(out.markdown, `![](${out.src})`);
  assert.ok(fs.existsSync(path.join(dir, out.src)), 'the bytes landed on disk');
  assert.deepEqual(fs.readFileSync(path.join(dir, out.src)), PNG_1x1, 'byte-identical, not re-encoded');
  // The whole design rests on this: the reference a comment stores is exactly what /assets resolves,
  // so an attachment needs no serving code of its own. If this 404s, images render as broken icons.
  const served = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent(out.src)}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') || '', /image\/png/);
});

test('the same image twice is one file — content-addressed, so re-pasting does not litter', async () => {
  const a = await (await postBytes('/api/asset?doc=doc.md', PNG_1x1)).json();
  const b = await (await postBytes('/api/asset?doc=doc.md', PNG_1x1)).json();
  assert.equal(a.src, b.src);
  const files = fs.readdirSync(path.join(dir, 'doc.md.review.assets'));
  assert.equal(files.filter(f => f.endsWith('.png')).length, 1);
  assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0, 'no temp file left behind');
});

test('asset upload refuses non-images by their BYTES, not their claimed type', async () => {
  // Content-Type says PNG and it is HTML. The extension decides how /assets serves it, so a file that
  // lies about itself must never get one — sniffing is what keeps the two honest.
  const r = await postBytes('/api/asset?doc=doc.md', Buffer.from('<html><script>alert(1)</script>'), 'image/png');
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not an image/);
});

test('asset upload refuses an unknown document — an attachment is not a write primitive', async () => {
  // Without the existence check this would create `<anything>.review.assets/` anywhere under the root.
  const r = await postBytes('/api/asset?doc=nope.md', PNG_1x1);
  assert.equal(r.status, 404);
  assert.ok(!fs.existsSync(path.join(dir, 'nope.md.review.assets')), 'no directory created for a doc that is not there');
  const esc = await postBytes(`/api/asset?doc=${encodeURIComponent('../../../../tmp/evil.md')}`, PNG_1x1);
  assert.equal(esc.status, 403);
});

test('an image in a comment body survives the review round-trip as a path, never as bytes', async () => {
  const up = await (await postBytes('/api/asset?doc=doc.md', PNG_1x1)).json();
  const s = await state();
  s.review.items.push({ id: 'cimg1', kind: 'comment', by: 'you', anchor: { quote: 'Closing paragraph.' },
    status: 'open', thread: [{ by: 'you', at: new Date().toISOString(), text: `look:\n\n${up.markdown}` }] });
  await put('/api/review', { path: 'doc.md', review: s.review });
  const raw = fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8');
  assert.match(raw, /doc\.md\.review\.assets\//);
  assert.doesNotMatch(raw, /base64|data:image/, 'the sidecar stays a small text file');
});

test('CLI --image copies the file in and appends a markdown link to the comment', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'shot.png'), PNG_1x1);
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'see this', '--image', 'shot.png');
  const review = JSON.parse(fs.readFileSync(path.join(d, 'doc.md.review.json'), 'utf8'));
  const body = review.items[0].thread[0].text;
  assert.match(body, /^see this\n\n!\[\]\(doc\.md\.review\.assets\/[0-9a-f]{12}\.png\)$/);
  const rel = body.match(/\(([^)]+)\)/)[1];
  // Copied, not referenced: the agent's screenshot usually sits in a scratch dir that gets cleaned up,
  // and a review that renders only until then is a review that silently rots.
  assert.deepEqual(fs.readFileSync(path.join(d, rel)), PNG_1x1);
  fs.rmSync(path.join(d, 'shot.png'));
  assert.ok(fs.existsSync(path.join(d, rel)), 'the attachment outlives the source file');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI --image is repeatable, and refuses a path that is not there', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'a.png'), PNG_1x1);
  fs.writeFileSync(path.join(d, 'b.gif'), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]));
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'two', '--image', 'a.png', '--image', 'b.gif');
  const review = JSON.parse(fs.readFileSync(path.join(d, 'doc.md.review.json'), 'utf8'));
  const links = [...review.items[0].thread[0].text.matchAll(/!\[\]\(([^)]+)\)/g)].map(m => m[1]);
  assert.equal(links.length, 2);
  assert.match(links[0], /\.png$/); assert.match(links[1], /\.gif$/);

  const e = cliFails(d, 'reply', 'doc.md', review.items[0].id, 'here', '--image', 'ghost.png');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /no image at/);
  fs.rmSync(d, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   `sidecar skill` / `sidecar help` — how an agent that has the package finds
   out what the package can do. npx unpacks into ~/.npm/_npx/<hash>/, which no
   agent harness scans, so shipping SKILL.md is only half of delivering it.
   ──────────────────────────────────────────────────────────────────────────── */

test('CLI skill: prints SKILL.md verbatim, so the protocol matches the code that is running', () => {
  const d = cliDir();
  const out = cli(d, 'skill');
  assert.equal(out, fs.readFileSync(path.join(__dirname, 'skills', 'sidecar', 'SKILL.md'), 'utf8'));
  assert.match(out, /^---\nname: sidecar\n/, 'frontmatter intact — the output is installable as a skill');
  fs.rmSync(d, { recursive: true, force: true });
});

test('CLI help: --help, -h and help all reach the banner, and it names both routes to the skill', () => {
  const d = cliDir();
  const out = cli(d, 'help');
  assert.equal(cli(d, '--help'), out);
  assert.equal(cli(d, '-h'), out);
  assert.match(out, /npx skills add smithavt14\/sidecar/, 'the install-where-the-agent-looks route');
  assert.match(out, /sidecar skill/, 'the no-install route');
  // Every verb the dispatcher knows should be discoverable from the banner, so a new one cannot be
  // added without documenting it. `help` is excluded: a usage screen listing itself is noise.
  const { COMMANDS } = require('./lib/cli.js');
  for (const c of COMMANDS.filter(c => c !== 'help'))
    assert.ok(out.includes(c), `help omits the ${c} verb`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('the published tarball carries SKILL.md — `files` dropping skills/ would silently break `sidecar skill`', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills/'), 'package.json files must ship skills/');
  const { SKILL_PATH } = require('./lib/cli.js');
  assert.ok(fs.existsSync(SKILL_PATH), 'the path the CLI reads must exist in the package layout');
});

test('--version prints the package version and exits, instead of trying to serve "--version" as a dir', () => {
  const d = cliDir();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.equal(cli(d, '--version').trim(), pkg.version);
  assert.equal(cli(d, '-v').trim(), pkg.version);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an unknown --flag is a typo, not a directory to serve — refuse instead of booting a server', () => {
  const d = cliDir();
  const e = cliFails(d, '--bogus');
  assert.ok(e, 'must exit non-zero');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /unknown option "--bogus"/);
  // The bug this guards: falling through meant `sidecar --version` booted a server on a taken port
  // and died with an unhandled 'error' stack dump.
  assert.doesNotMatch(e.stderr, /EADDRINUSE|Unhandled 'error'/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('/api/state ships codeDir + version, so doctor can tell a stale server from a different install', async () => {
  // doctor compared its own code stamp against the server's blind. For anyone who installed from npm
  // those are different installations by construction, so it reported STALE at every such user forever.
  const d = cliDir();
  const port = PORT + 13;
  const srv = await new Promise((res, rej) => {
    const p = spawn('node', [BIN, d], { env: { ...process.env, SIDECAR_PORT: String(port) }, stdio: 'pipe' });
    p.stdout.on('data', (b) => { if (b.toString().includes('ready')) res(p); });
    p.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server never became ready')), 8000);
  });
  try {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/state?path=doc.md`)).json();
    assert.equal(typeof s.codeDir, 'string');
    assert.equal(path.resolve(s.codeDir), path.resolve(__dirname), 'codeDir is the server installation');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.equal(s.version, pkg.version);
  } finally {
    srv.kill();
    fs.rmSync(d, { recursive: true, force: true });
  }
});
