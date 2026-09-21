/* sidecar test suite — spins the real server against a temp fixture dir and hits the real API.
   Run: npm test */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

// mirror the server's content hash (sha1 hex, first 12) so tests can assert the returned hash
// equals the sha of the exact bytes on disk.
const sha_of = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// The agent's default name is read off the harness (lib/agent.js), and this suite is run from inside
// one. Scrubbed here so every spawned command that names no agent is 'claude' whoever runs the tests.
for (const k of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'SIDECAR_AGENT']) delete process.env[k];

const PORT = 4991;
const BASE = `http://127.0.0.1:${PORT}`;
let dir, proc, xdgHome;

// Every server this file spawns inherits process.env, and one booted against a root with no `.sidecar`
// resolves its themes directory to $XDG_CONFIG_HOME — creating it, because the watcher needs something
// to watch. Pointed at a real home that is somebody's actual config directory, so the suite gets its
// own and the children inherit that instead. Set before any of them starts.
xdgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-xdg-suite-'));
process.env.XDG_CONFIG_HOME = xdgHome;

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
  // A root that keeps its own .sidecar state gets its themes inside it (see THEMES_DIR in server.js),
  // which is the branch worth testing: it is the one where a theme file is also a document.
  fs.mkdirSync(path.join(dir, '.sidecar'), { recursive: true });
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: dir });
  proc = spawn('node', [path.join(__dirname, 'server.js'), dir],
    { env: { ...process.env, SIDECAR_PORT: PORT }, stdio: 'pipe' });
  await new Promise((res, rej) => {
    proc.stdout.on('data', (d) => { if (d.toString().includes('ready')) res(); });
    proc.on('exit', () => rej(new Error('server died')));
    setTimeout(() => rej(new Error('server never became ready')), 8000);
  });
});
after(() => {
  proc.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(xdgHome, { recursive: true, force: true });
});

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
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'),
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
  const p = path.join(dir, 'doc.md.sidecar.json');
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
  const p = path.join(dir, 'doc.md.sidecar.json');
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
  const p = path.join(dir, 'doc.md.sidecar.json');
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
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug1', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'Closing paragraph.', occurrence: 0 }, replacement: 'Closing paragraph, improved.' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug1' });
  assert.equal(r.status, 200);
  const md = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(md, /Closing paragraph, improved\./);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug1').status, 'accepted');
});

test('accept with occurrence targets the right duplicate', async () => {
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug2', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'Repeated line here.', occurrence: 1 }, replacement: 'Second copy, replaced.' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
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
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug3', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'bold text', occurrence: 0 }, replacement: '**bold** prose' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));

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
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r2 = await post('/api/accept', { path: 'doc.md', id: 'sug3b' });
  assert.equal(r2.status, 200);
  const after = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  assert.match(after, /with \*\*bold\*\* prose and/);
  assert.ok(!/\*\*\*\*/.test(after), 'no doubled markers');
});

test('accept on a vanished anchor 409s and orphans the card, file untouched', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug4', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'THIS TEXT DOES NOT EXIST ANYWHERE', occurrence: 0 }, replacement: 'x' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug4' });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), before);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug4').status, 'orphaned');
});

test('orphan detection is idempotent — repeated reads do not rewrite the sidecar (no reload storms)', async () => {
  await state(); // may legitimately write once (annotate pass)
  const p = path.join(dir, 'doc.md.sidecar.json');
  const m1 = fs.statSync(p).mtimeMs;
  await state(); await state(); await state();
  const m2 = fs.statSync(p).mtimeMs;
  assert.equal(m1, m2, 'sidecar rewritten on read with no changes');
});

test('reject settles without touching the file', async () => {
  const before = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8');
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8'));
  review.items.push({ id: 'sug5', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'item two', occurrence: 0 }, replacement: 'item 2' });
  fs.writeFileSync(path.join(dir, 'doc.md.sidecar.json'), JSON.stringify(review));
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
  const p = path.join(dir, 'doc.md.sidecar.json');
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
  const p = path.join(dir, 'doc.md.sidecar.json');
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

// ---- a table's column widths never reach the file ----
// A width the reader drags is an inline style on the header cell (public/tablecols.js). The document
// is contenteditable and saves through turndown, so this is the one thing that has to stay true: a
// document with resized columns serializes to the bytes it was loaded from, down the tight path and
// the structural one, and an edit beside the table still leaves the table alone.
const TableCols = require('./public/tablecols.js');   // the SAME file index.html loads via <script>
test('a document with resized columns round-trips through serialize unchanged', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  const tables = [...doc.querySelectorAll('table')];
  assert.equal(tables.length, 1);
  TableCols.apply(tables, { 0: { 0: 240, 1: 96 } });
  const ths = [...tables[0].querySelectorAll('th')];
  assert.equal(ths[0].style.width, '240px', 'the width is on the header cell');
  assert.equal(ths[0].style.minWidth, '240px', 'and so is the floor the container cannot take back');
  assert.equal(ths[1].style.width, '96px');
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true, 'a width is not an edit: every block still matches its baseline');
  assert.equal(md, RT_DOC, 'byte-identical, so the width is nowhere in the file');
  // The structural path too: a paragraph goes, the block count changes, and the resized table still
  // emits its exact original bytes.
  blockByText(doc, 'A second paragraph here.').remove();
  const out = Serialize.serialize(doc, blocks, td);
  assert.equal(out.tight, false);
  assert.ok(out.md.includes(TABLE_SRC), 'the table is its original bytes, non-canonical spacing and all');
  assert.doesNotMatch(out.md, /width|style/, 'nothing about a width is in the markdown');
  // Releasing a column takes both properties off.
  TableCols.apply(tables, {});
  assert.equal(ths[0].getAttribute('style') || '', '');
});

test('editing a paragraph beside a resized table changes only the paragraph', () => {
  const { doc, blocks, td } = buildDoc(RT_DOC);
  TableCols.apply([...doc.querySelectorAll('table')], { 0: { 1: 300 } });
  blockByText(doc, 'Intro paragraph with bold text.').innerHTML = '<p>Intro edited.</p>';
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true);
  assert.equal(md, RT_DOC.replace('Intro paragraph with **bold** text.', 'Intro edited.'));
  // And the re-baseline after that save reads the same table markdown with the width still on it.
  const next = Serialize.reindex(doc, blocks, md, require('marked').marked, td);
  const tableBlock = next.find(b => b.token.type === 'table');
  assert.ok(tableBlock && tableBlock.md0 && !/width/.test(tableBlock.md0));
});

// ---- a pending suggestion previewed IN the document never reaches the file ----
// The proposal is drawn at its anchor now, inside the mark, which puts un-accepted text inside a
// contenteditable that serializes to markdown. These are the tests that say it cannot escape: a document
// carrying a preview serializes byte-identically to the same document without one, in every view, for an
// edit, for a rewrite, and for a span crossing two blocks.
const Sugview = require('./public/sugview.js');   // the SAME file index.html loads via <script>

// The DOM shape index.html's wrapAnchor + buildPreview produce, built here over a jsdom #doc: the
// original text nodes wrapped in `[sugview="old"]` inside the mark, and the proposal in a separate
// `[sugview="new"]` node placed as a SIBLING after the last mark, hoisted clear of any inline
// formatting the span started inside. The attribute is the contract public/serialize.js strips on, so a
// change to either side fails these rather than writing a proposal into somebody's file.
const INLINE_WRAP = 'strong,b,em,i,a,code,s,del,ins,u,sub,sup,small,abbr,span,mark';
function hoistPoint(doc, mark) {
  const block = mark.closest('.block') || doc;
  let node = mark;
  while (node.parentElement && node.parentElement !== block && node.parentElement.matches(INLINE_WRAP)) {
    if (node !== node.parentElement.lastChild) return null;
    node = node.parentElement;
  }
  return node;
}
function addPreview(win, doc, quote, replacement, { view = 'new', id = 's1' } = {}) {
  const walker = doc.ownerDocument.createTreeWalker(doc, win.NodeFilter.SHOW_TEXT);
  const nodes = []; let full = '';
  while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: full.length }); full += walker.currentNode.textContent; }
  const hit = Anchor.findNth(full, quote, 0);
  assert.ok(hit, 'the fixture must contain the quote being suggested on: ' + quote);
  const marks = [];
  for (const { node, start: ns } of nodes) {
    const ne = ns + node.textContent.length;
    if (ne <= hit.start || ns >= hit.end) continue;
    const s = Math.max(0, hit.start - ns), e = Math.min(node.textContent.length, hit.end - ns);
    const slice = node.textContent.slice(s, e);
    if (!slice.trim() && slice.includes('\n')) continue;
    const r = doc.ownerDocument.createRange(); r.setStart(node, s); r.setEnd(node, e);
    const mark = doc.ownerDocument.createElement('mark');
    mark.className = 'anchor'; mark.dataset.id = id; mark.setAttribute('contenteditable', 'false');
    r.surroundContents(mark); marks.push(mark);
  }
  const kind = Sugview.classify(quote, replacement);
  const at = hoistPoint(doc, marks[marks.length - 1]);
  if (!at) return { marks, kind, nu: null };
  for (const m of marks) {
    const old = doc.ownerDocument.createElement('span');
    old.className = 'sug-old';
    old.setAttribute('sugview', 'old');
    while (m.firstChild) old.appendChild(m.firstChild);
    m.appendChild(old);
    m.dataset.sug = id; m.dataset.sugKind = kind;
    m.classList.add('sug-view-' + (kind === 'edit' ? 'edit' : view));
  }
  const nu = doc.ownerDocument.createElement('span');
  nu.className = 'sug-new sug-view-' + (kind === 'edit' ? 'edit' : view);
  nu.setAttribute('sugview', 'new');
  nu.dataset.sug = id;
  nu.setAttribute('contenteditable', 'false');
  nu.innerHTML = kind === 'edit'
    ? '<del>' + quote + '</del><ins>' + replacement + '</ins>'
    : replacement;
  at.parentNode.insertBefore(nu, at.nextSibling);
  return { marks, kind, nu };
}

const PREVIEW_DOC = [
  '# Heading One', '',
  'The quick brown fox jumps over the lazy dog. It was a fine morning.', '',
  'A second paragraph here.', '',
  '| Name | Value |', '|------|-------|', '| x    | y     |', '',
  'Closing paragraph.', '',
].join('\n');

test('a previewed edit serializes to the same bytes as a document with no preview', () => {
  const { window, doc, blocks, td } = buildDoc(PREVIEW_DOC);
  const before = Serialize.serialize(doc, blocks, td);
  assert.equal(before.md, PREVIEW_DOC);
  const { kind } = addPreview(window, doc, 'the lazy dog', 'the sleeping dog');
  assert.equal(kind, 'edit', 'two words out of three is a small change');
  assert.ok(doc.querySelector('[sugview="new"]'), 'the proposal really is in the DOM');
  const after = Serialize.serialize(doc, blocks, td);
  assert.equal(after.tight, true, 'injecting a preview must not read as an edit to the block');
  assert.equal(after.md, PREVIEW_DOC, 'byte-identical: the proposal is nowhere in the file');
  assert.ok(!after.md.includes('sleeping'), 'and the proposed words are not in it');
});

test('a previewed rewrite serializes unchanged in both of its views', () => {
  const quote = 'The quick brown fox jumps over the lazy dog. It was a fine morning.';
  const replacement = 'A grey heron waited at the river edge. Nothing moved for an hour.';
  for (const view of ['new', 'original']) {
    const { window, doc, blocks, td } = buildDoc(PREVIEW_DOC);
    const { kind } = addPreview(window, doc, quote, replacement, { view });
    assert.equal(kind, 'rewrite', 'a two-sentence replacement of a two-sentence quote is a rewrite');
    const { md, tight } = Serialize.serialize(doc, blocks, td);
    assert.equal(tight, true, view + ': still the tight path');
    assert.equal(md, PREVIEW_DOC, view + ': byte-identical to the source');
    assert.ok(!md.includes('heron'), view + ': the proposal is not in the file');
    assert.ok(md.includes(TABLE_SRC), view + ': the untouched table is still its own bytes');
  }
});

test('a preview on a span crossing two blocks leaves both blocks byte-identical', () => {
  const { window, doc, blocks, td } = buildDoc(PREVIEW_DOC);
  // One quote, two paragraphs: wrapAnchor produces a mark per block, the proposal goes in the first,
  // and every one of them has to unwrap back to exactly the text it was holding.
  const quote = 'It was a fine morning. A second paragraph here.';
  const { marks } = addPreview(window, doc, quote, 'It rained all day. The second paragraph is gone.');
  assert.ok(marks.length >= 2, 'the span really did cross a block boundary');
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true);
  assert.equal(md, PREVIEW_DOC, 'both blocks emit their original bytes');
});

test('a preview survives an edit elsewhere: only the edited block changes', () => {
  const { window, doc, blocks, td } = buildDoc(PREVIEW_DOC);
  addPreview(window, doc, 'the lazy dog', 'the sleeping dog');
  // Type in an unrelated paragraph, which is what a debounced save actually serializes.
  blockByText(doc, 'Closing paragraph.').querySelector('p').textContent = 'Closing paragraph, edited.';
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true);
  assert.equal(md, PREVIEW_DOC.replace('Closing paragraph.', 'Closing paragraph, edited.'));
  assert.ok(!md.includes('sleeping'), 'the un-accepted proposal stayed out of the save');
});

test('reindex over a previewed document keeps the baselines the preview-free ones', () => {
  const { window, doc, blocks, td, marked } = buildDoc(PREVIEW_DOC);
  addPreview(window, doc, 'the lazy dog', 'the sleeping dog');
  const { md } = Serialize.serialize(doc, blocks, td);
  const next = Serialize.reindex(doc, blocks, md, marked, td);
  const para = next.find(b => b.md0 && b.md0.includes('quick brown fox'));
  assert.ok(para, 'the previewed paragraph is still one block');
  assert.ok(!para.md0.includes('sleeping'), 'its baseline is the file text, not the proposal');
  assert.equal(Serialize.serialize(doc, next, td).md, md, 'so the next save is still a no-op');
});

// ---- public/sugview.js: edit or rewrite, and the line the rail prints ----
test('a few words changed is an edit; more than half the words is a rewrite', () => {
  assert.equal(Sugview.classify('the quick brown fox jumps over the lazy dog',
    'the quick brown fox leaps over the lazy dog'), 'edit', 'one word in nine');
  assert.equal(Sugview.classify('the quick brown fox jumps over the lazy dog',
    'a slow grey heron waited beside the still river'), 'rewrite', 'almost nothing survives');
  assert.equal(Sugview.classify('we shipped it', 'we shipped it on Tuesday'), 'edit',
    'an addition that keeps the sentence is an edit');
});

test('a change crossing a sentence boundary is a rewrite however few words moved', () => {
  // Two words, but they sit either side of the full stop: shown as tracked changes it reads as noise
  // across two sentences rather than as one correction.
  assert.equal(Sugview.classify('We shipped it. Nobody noticed at all. The end.',
    'We shipped it today. Somebody noticed at all. The end.'), 'rewrite');
  assert.equal(Sugview.classify('We shipped it. Nobody noticed at all.',
    'We shipped it. Nobody noticed at first.'), 'edit', 'inside one sentence, it stays an edit');
});

test('a diffWords parts array counts the same as the module\'s own word diff', () => {
  const Diff = require('diff');
  const quote = 'the quick brown fox jumps over the lazy dog';
  const rep = 'a slow grey heron waited beside the still river';
  assert.equal(Sugview.classify(quote, rep, Diff.diffWords(quote, rep)),
    Sugview.classify(quote, rep), 'the two ways in agree');
});

test('the rail summary names the change for an edit and the size of it for a rewrite', () => {
  assert.equal(Sugview.summary('the quick brown fox', 'the quick red fox'), 'brown → red');
  assert.equal(Sugview.summary('We shipped it. Nobody noticed.',
    'We released it on Tuesday. Everybody complained loudly.'), 'Rewrites 2 sentences');
  assert.equal(Sugview.summary('One long sentence that is entirely replaced here',
    'A completely different clause standing in its place'), 'Rewrites 1 sentence');
  assert.ok(Sugview.summary('a'.repeat(200) + ' tail', 'b'.repeat(200) + ' tail').length < 90,
    'a long one is clipped rather than wrapping the card');
});

test('sentenceCount counts a trailing fragment and never returns zero for real text', () => {
  assert.equal(Sugview.sentenceCount('One. Two. Three.'), 3);
  assert.equal(Sugview.sentenceCount('One. Two. And a trailing fragment'), 3);
  assert.equal(Sugview.sentenceCount('no terminator here'), 1);
  assert.equal(Sugview.sentenceCount('   '), 0);
});

// The document's OWN inline HTML may say anything, including the words this feature marks its nodes
// with. `sugview` is a bare attribute rather than a `data-` one precisely so it cannot: DOMPurify drops
// an unknown bare attribute from everything the render path touches and keeps `data-*` and `class`, so
// only code that built a node itself, after sanitizing, can put `sugview` on one.
const AUTHOR_HTML_DOC = [
  '# Heading One', '',
  'Before <span data-sugview="new">keep me</span> after.', '',
  'And <span class="sug-old">this one too</span> please.', '',
  'The quick brown fox jumps over the lazy dog.', '',
].join('\n');

test("an author's own data-sugview and sug-old spans survive serialization untouched", () => {
  const { window, doc, blocks, td } = buildDoc(AUTHOR_HTML_DOC);
  assert.ok(doc.querySelector('[data-sugview]'), 'DOMPurify kept the author\'s data- attribute');
  assert.ok(doc.querySelector('.sug-old'), "and the author's class");
  assert.equal(Serialize.serialize(doc, blocks, td).md, AUTHOR_HTML_DOC,
    'an untouched document with those spans round-trips byte for byte');
  // …and it still does with a real preview live somewhere else in the same document.
  addPreview(window, doc, 'the lazy dog', 'the sleeping dog');
  const { md } = Serialize.serialize(doc, blocks, td);
  assert.equal(md, AUTHOR_HTML_DOC, 'the preview is gone and the author\'s words are all still here');
  assert.ok(md.includes('<span data-sugview="new">keep me</span>'), 'including the one that looks like ours');
  assert.ok(md.includes('<span class="sug-old">this one too</span>'), 'and the one wearing our class');
});

test('DOMPurify strips a bare sugview attribute, which is what makes it ours alone', () => {
  const { window } = new JSDOM('<!doctype html><div id="doc"></div>');
  const DOMPurify = require('dompurify')(window);
  assert.doesNotMatch(DOMPurify.sanitize('a <span sugview="new">b</span> c'), /sugview/,
    'nothing that goes through the render path can carry it');
  assert.match(DOMPurify.sanitize('a <span data-sugview="new">b</span> c'), /data-sugview/,
    'while the data- spelling survives, which is exactly why it cannot be the marker');
});

// ---- a span that starts inside inline formatting ----
// The first mark of such a span sits inside the <strong> or the <a>, and a proposal appended there
// previews bold, or as a link, when accept would save neither. It is hoisted to a sibling instead.
const FORMAT_DOC = [
  '# Heading One', '',
  '**Bold lead** rest of the sentence.', '',
  'See [the docs](https://example.org/a) for more detail.', '',
  'A closing paragraph.', '',
].join('\n');

test('a proposal on a span starting inside strong is not drawn bold, and saves nothing', () => {
  const { window, doc, blocks, td } = buildDoc(FORMAT_DOC);
  const { marks, nu } = addPreview(window, doc, '**Bold lead** rest of the sentence.',
    'Plain replacement with no emphasis at all.');
  assert.ok(marks.some(m => m.closest('strong')), 'the span really does start inside the bold run');
  assert.ok(nu, 'the proposal was placed');
  assert.equal(nu.closest('strong'), null, 'and it is NOT inside it, so it previews as plain text');
  assert.equal(nu.closest('a'), null);
  const { md, tight } = Serialize.serialize(doc, blocks, td);
  assert.equal(tight, true);
  assert.equal(md, FORMAT_DOC, 'byte-identical: the bold run is intact and the proposal is absent');
  assert.ok(md.includes('**Bold lead** rest'), 'the author\'s <strong> was never split in two');
});

test('a proposal on a span starting inside a link is not drawn as a link, and saves nothing', () => {
  const { window, doc, blocks, td } = buildDoc(FORMAT_DOC);
  const { marks, nu } = addPreview(window, doc, 'See [the docs](https://example.org/a) for more detail.',
    'Read the handbook for more detail.');
  assert.ok(marks.some(m => m.closest('a')), 'the span really does cover the link');
  assert.equal(nu.closest('a'), null, 'the proposal is outside it, so it is not clickable and not blue');
  const { md } = Serialize.serialize(doc, blocks, td);
  assert.equal(md, FORMAT_DOC, 'byte-identical, link and all');
  assert.ok(md.includes('[the docs](https://example.org/a)'), 'the link survived whole');
});

// ---- the token diff: a markdown delimiter never straddles two fragments ----
test('an edit inside inline markdown keeps every fragment renderable on its own', () => {
  // `**bold** text` against `**strong** text` is the reported case: a word diff splits at the word
  // boundary INSIDE the delimiters, so one fragment is `**` and the paragraph shows asterisks.
  for (const [q, r] of [
    ['**bold** text', '**strong** text'],
    ['The **north gate** is locked', 'The **north gate** stays locked'],
    ['Read the `plan.md` file now', 'Read the `plan.md` file today'],
    ['See [the docs](https://a.b) for more', 'See [the guide](https://a.b) for more'],
    ['A ~~struck~~ word here', 'A ~~struck~~ word there'],
  ]) {
    const parts = Sugview.diffTokens(q, r);
    assert.ok(Sugview.splittable(parts), `every fragment of ${q} is balanced`);
    for (const p of parts) assert.ok(Sugview.balanced(p.value), `fragment ${JSON.stringify(p.value)}`);
    assert.equal(parts.filter(p => !p.added).map(p => p.value).join(''), q, 'the removals reconstruct the quote');
    assert.equal(parts.filter(p => !p.removed).map(p => p.value).join(''), r, 'and the additions the replacement');
  }
});

test('a whole markdown construct moves as one token and is never cut in half', () => {
  assert.deepEqual(Sugview.tokenize('**bold** text'), ['**bold**', ' ', 'text']);
  assert.deepEqual(Sugview.tokenize('a `code span` b'), ['a', ' ', '`code span`', ' ', 'b']);
  assert.deepEqual(Sugview.tokenize('x [a b](http://c) y'), ['x', ' ', '[a b](http://c)', ' ', 'y']);
  assert.ok(!Sugview.balanced('**'), 'a lone delimiter is not renderable');
  assert.ok(Sugview.balanced('**bold**'), 'a closed one is');
});

test('a change the fragments cannot carry is classified as a rewrite instead', () => {
  // Nested emphasis the tokenizer does not recognise, and an unbalanced marker an author left behind:
  // the guard catches both and the change is drawn as a rewrite, which renders each side whole and so
  // can never split a delimiter.
  for (const [q, r] of [
    ['*an emphasis with **bold** inside it*', '*an emphasis with **strong** inside it*'],
    ['a **bold text here', 'a **strong text here'],
  ]) {
    assert.ok(!Sugview.splittable(Sugview.diffTokens(q, r)), `some fragment of ${q} is unbalanced`);
    assert.equal(Sugview.classify(q, r), 'rewrite', 'so it is not drawn as tracked changes');
  }
  // A delimiter pair around a space is not emphasis and marked prints it literally, so an even count of
  // asterisks is not the question. This is what the first version of the guard got wrong.
  assert.ok(!Sugview.balanced('*an aside *'), 'two asterisks, and still two literal asterisks');
  assert.ok(Sugview.balanced('*an aside*'), 'closed properly, so it renders');
  // And the everyday case is untouched: plain prose with one word changed is still an edit.
  assert.equal(Sugview.classify('the quick brown fox', 'the quick red fox'), 'edit');
  assert.equal(Sugview.classify('**bold** text', '**strong** text'), 'edit',
    'a bold-to-bold change is small, and now safe, so it stays an edit');
});

test('the page loads sugview.js and keeps the preview out of every path that reads the document', () => {
  // Read here rather than from the PAGE constant further down the file: this test sits beside the
  // serialization ones it belongs with, and a fixture that has to be declared above its first use
  // would move it away from them.
  const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const STYLE = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
  assert.match(PAGE, /<script src="\/sugview\.js">/, 'the same file the tests require');
  // The serializer takes the proposal off and unwraps the original, in that order. Both selectors are
  // the contract; a rename on one side without the other writes a proposal into somebody's file.
  const ser = fs.readFileSync(path.join(__dirname, 'public/serialize.js'), 'utf8');
  assert.ok(ser.indexOf(`querySelectorAll('[sugview="new"]')`) < ser.indexOf(`querySelectorAll('[sugview="old"]')`),
    'the proposal goes before the wrapper around the original is unwrapped');
  assert.match(ser, /\[sugview="old"\]'\)\.forEach\(s => s\.replaceWith\(\.\.\.s\.childNodes\)\)/,
    'the original is unwrapped, never removed');
  // The comments name `data-sugview` and `.sug-old` to say why they are NOT what it selects on; the
  // code must not, since both are spellings a document can carry.
  assert.doesNotMatch(ser.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ''), /data-sugview|['"]\.sug-old/,
    'neither selector can be forged by a document, so neither reads data- or a class');
  // Every walk over the document's text skips the proposal, or an anchor later in the paragraph is
  // counted past words that are not in the file.
  assert.match(PAGE, /acceptNode: \(n\) => \(n\.parentElement && n\.parentElement\.closest\('\[data-atomic\],\[sugview="new"\]'\)\)/,
    'docText skips it');
  assert.match(PAGE, /function blockTextWalker\(el\) \{[\s\S]*?\[sugview="new"\]/, 'and so does the block walk');
  assert.match(PAGE, /Anchor\.occurrenceAt\(blockText\(el\), quote, selOffset\)/,
    'occurrenceFor counts over the preview-free text');
  // The proposal is a sibling of the mark, hoisted clear of inline formatting, and uneditable on its
  // own account rather than by inheriting from a mark it no longer sits in.
  assert.match(PAGE, /nu\.contentEditable = 'false';/, 'the proposal is not a place the caret can go');
  assert.match(PAGE, /at\.parentNode\.insertBefore\(nu, at\.nextSibling\)/, 'it is placed as a sibling');
  assert.match(PAGE, /if \(node !== node\.parentElement\.lastChild\) return null;/,
    'hoistPoint gives up rather than splitting an author\'s element in two');
  // One span, one proposal: the first pending answer drives it and the rest keep their diff.
  assert.match(PAGE, /function drivesPreview\(sug\)/, 'the rule is one function');
  assert.match(PAGE, /!drivesPreview\(sug\) \|\| previewFailed\.has\(sug\.id\)/,
    'and the card asks it before dropping its diff');
  assert.match(STYLE, /body\.reading \.sug-new \{ display:none; \}/,
    'reading mode shows the document, not the proposal');
  assert.match(STYLE, /body\.reading #sugbar \{ display:none !important; \}/, 'and no bar over it');
  assert.ok(PAGE.indexOf('<div id="sugbar">') > PAGE.indexOf('</main>'),
    'the bar lives outside #doc, which serializes');
});

// ---- the list keys (public/listkeys.js) under the same jsdom #doc, serialized by the same save path ----
// The three rules a bare contenteditable does not have: Enter on an empty item, Backspace at the start
// of one, Tab and Shift+Tab. Every case below asserts BOTH halves — the DOM the transform leaves and the
// markdown the page's own turndown writes out of it — because a transform that reads right on screen and
// serializes wrong is the only kind of bug here that reaches the file.
const ListKeys = require('./public/listkeys.js');   // the SAME file index.html loads via <script>

// A list fixture built by the same buildDoc the serialize tests use, plus two conveniences: find an item
// by its OWN text (a parent item's textContent swallows its children's), and run the real save path.
function listDoc(md) {
  const built = buildDoc(md);
  const item = (text) => [...built.doc.querySelectorAll('li')].find((li) => {
    let own = '';
    for (const n of li.childNodes) if (!['UL', 'OL'].includes(n.nodeName)) own += n.textContent || '';
    return own.trim() === text;
  });
  return { ...built, item,
    // Whitespace between tags is marked's pretty-printing and means nothing to a list, so the shape
    // assertions read the structure rather than the indentation it arrived with.
    html: () => built.doc.querySelector('.block').innerHTML.replace(/\s*\n\s*/g, '').trim(),
    save: () => Serialize.serialize(built.doc, built.blocks, built.td).md };
}

test('lift: a top-level item becomes a paragraph and the list splits around it', () => {
  const d = listDoc('- a\n- b\n- c\n');
  const p = ListKeys.lift(d.item('b'));
  assert.equal(p.nodeName, 'P', 'the caret lands in the new paragraph');
  assert.equal(d.html(), '<ul><li>a</li></ul><p>b</p><ul><li>c</li></ul>');
  assert.equal(d.save(), '- a\n\nb\n\n- c\n', 'the item that was b is now prose between two lists');
});

test('lift: an ordered list keeps its numbering across the split, via start', () => {
  const d = listDoc('1. a\n2. b\n3. c\n');
  ListKeys.lift(d.item('b'));
  assert.equal(d.doc.querySelectorAll('ol')[1].getAttribute('start'), '3', 'c is still the third item');
  assert.equal(d.save(), '1. a\n\nb\n\n3. c\n', 'a keystroke must not renumber the list under it');
  // A list that already started somewhere else counts from there.
  const e = listDoc('3. a\n4. b\n5. c\n');
  ListKeys.lift(e.item('b'));
  assert.equal(e.save(), '3. a\n\nb\n\n5. c\n');
});

test('lift: the first and the last item each leave one list behind, not two', () => {
  const first = listDoc('- a\n- b\n');
  ListKeys.lift(first.item('a'));
  assert.equal(first.html(), '<p>a</p><ul><li>b</li></ul>', 'the emptied head list is removed');
  assert.equal(first.save(), 'a\n\n- b\n');
  const last = listDoc('- a\n- b\n');
  ListKeys.lift(last.item('b'));
  assert.equal(last.html(), '<ul><li>a</li></ul><p>b</p>', 'no empty tail list is created');
  assert.equal(last.save(), '- a\n\nb\n');
  const only = listDoc('- a\n');
  ListKeys.lift(only.item('a'));
  assert.equal(only.html(), '<p>a</p>');
  assert.equal(only.save(), 'a\n');
});

test('lift: a nested item outdents one level rather than leaving the list', () => {
  const d = listDoc('- a\n  - b\n');
  const li = d.item('b');
  assert.equal(ListKeys.lift(li), li, 'the caret stays in the item it was in');
  assert.equal(d.html(), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(d.save(), '- a\n- b\n');
});

test("lift: the item's own sublist comes with it and joins the tail at the shallower depth", () => {
  const d = listDoc('- a\n  - b\n- c\n');
  ListKeys.lift(d.item('a'));
  assert.equal(d.html(), '<p>a</p><ul><li>b</li><li>c</li></ul>', 'one list, not two adjacent ones');
  assert.equal(d.save(), 'a\n\n- b\n- c\n');
  // The same, ordered: the tail's start walks back so c keeps the number it had.
  const e = listDoc('1. a\n   1. b\n2. c\n');
  ListKeys.lift(e.item('a'));
  assert.equal(e.save(), 'a\n\n1. b\n2. c\n');
  // A bullet sublist under a numbered tail cannot join it, so it stands on its own.
  const f = listDoc('1. a\n   - b\n2. c\n');
  ListKeys.lift(f.item('a'));
  assert.equal(f.html(), '<p>a</p><ul><li>b</li></ul><ol start="2"><li>c</li></ol>');
});

test('lift: a task-list item drops its checkbox on the way to being a paragraph', () => {
  const d = listDoc('- [ ] todo\n- [x] done\n');
  const p = ListKeys.lift(d.item('todo'));
  assert.equal(p.querySelector('input'), null, 'a paragraph has no marker to carry a box');
  assert.equal(p.textContent, 'todo', 'and no leading space where the box was');
  assert.match(d.save(), /^todo\n\n- \[x\]/, 'the box would otherwise serialize as a literal [ ] in the prose');
  assert.match(d.save(), /\[x\]/, 'the item that was not lifted keeps its box');
});

test('lift: an ordered list that starts at 0 keeps counting from 0', () => {
  // CommonMark lets a list begin at zero and marked renders <ol start="0">, so a start has to be read
  // as present-or-absent rather than truthy: `Number(start || 1) || 1` reads that 0 as a 1 and the
  // tail comes back renumbered by a keystroke.
  const d = listDoc('0. a\n1. b\n2. c\n');
  ListKeys.lift(d.item('b'));
  assert.equal(d.doc.querySelectorAll('ol')[1].getAttribute('start'), '2', 'c is still the third item');
  assert.equal(d.save(), '0. a\n\nb\n\n2. c\n');
  const first = listDoc('0. a\n1. b\n2. c\n');
  ListKeys.lift(first.item('a'));
  assert.equal(first.save(), 'a\n\n1. b\n2. c\n', 'b was the 1 and stays the 1');
});

test('lift: a promoted sublist joins the tail only where the numbering runs straight through', () => {
  // The sublist comes up to the tail's depth, and joining renumbers whichever list gives way. Join
  // when the sublist's own start plus its item count is the tail's start, and leave them apart when it
  // is not: b is the 5 the author wrote, and one list holding both would make it the 1.
  const apart = listDoc('1. a\n   5. b\n2. c\n');
  ListKeys.lift(apart.item('a'));
  assert.equal(apart.html(), '<p>a</p><ol start="5"><li>b</li></ol><ol start="2"><li>c</li></ol>');
  assert.equal(apart.save(), 'a\n\n5. b\n\n2. c\n', 'each list keeps the numbers it had');
  // Contiguous, and zero-based: 0 + one item is the tail's 1, so the two become one list from 0.
  const zero = listDoc('0. a\n   0. b\n1. c\n');
  ListKeys.lift(zero.item('a'));
  assert.equal(zero.html(), '<p>a</p><ol start="0"><li>b</li><li>c</li></ol>');
  assert.equal(zero.save(), 'a\n\n0. b\n1. c\n');
});

test('lift: the task-list marker goes and a checkbox the author wrote stays', () => {
  // The marker box is the item's first node, or the first node of its <p> in a loose list. Everything
  // else is prose the author typed, and a lift that swept the item for input[type=checkbox] deleted a
  // control the document really contained. (What turndown then writes for inline HTML in a rewritten
  // block is the serializer's own long-standing behaviour and is no business of the lift.)
  const authored = listDoc('- X <input type="checkbox"> keep\n- b\n');
  const p = ListKeys.lift(authored.doc.querySelector('li'));
  assert.equal(p.querySelectorAll('input').length, 1, 'the control the author wrote survives');
  assert.equal(p.textContent, 'X  keep');
  // Both boxes in one item: the marker's, and one in the prose after it.
  const both = listDoc('- [ ] todo <input type="checkbox"> extra\n- b\n');
  const q = ListKeys.lift(both.doc.querySelector('li'));
  assert.equal(q.querySelectorAll('input').length, 1, 'exactly one box went');
  assert.equal(q.firstChild.textContent, 'todo ', 'and it was the leading one, space and all');
  // A loose list wraps the item in a <p>, and the marker sits first inside that.
  const loose = listDoc('- [ ] todo\n\n- [x] done\n');
  const r = ListKeys.lift(loose.doc.querySelector('li'));
  assert.equal(r.querySelector('input'), null);
  assert.equal(r.textContent.trim(), 'todo');
});

test('isEmptyItem: an item is empty on its own text, whatever it carries below it', () => {
  const d = listDoc('- a\n  - b\n- c\n');
  assert.equal(ListKeys.isEmptyItem(d.item('c')), false);
  const parent = d.item('a');
  parent.firstChild.textContent = '';
  assert.equal(ListKeys.isEmptyItem(parent), true, 'an item with children but no text of its own is empty');
  const z = listDoc('- x\n');
  const only = z.item('x');
  only.firstChild.textContent = '​';
  assert.equal(ListKeys.isEmptyItem(only), true, 'the inline rule caret escape is not content');
});

test('isEmptyItem: an item holding a picture is not empty', () => {
  // An image carries no text, so a text-only test reads `- ![alt](x.png)` as an empty item and Enter
  // lifts the picture out of the list the author put it in.
  const d = listDoc('- ![alt](x.png)\n- b\n');
  const img = d.doc.querySelector('li');
  assert.ok(img.querySelector('img'), 'the fixture really holds an image');
  assert.equal(ListKeys.isEmptyItem(img), false);
  // Wrapped a level down, as a loose list renders it.
  const loose = listDoc('- ![alt](x.png)\n\n- b\n');
  assert.equal(ListKeys.isEmptyItem(loose.doc.querySelector('li')), false, 'inside the item\'s <p> too');
  // The media belongs to the item only when it is the item's own. A sublist of pictures leaves the
  // parent as empty as any other sublist does.
  const below = listDoc('- parent\n  - ![alt](x.png)\n');
  const parent = below.item('parent');
  parent.firstChild.textContent = '';
  assert.equal(ListKeys.isEmptyItem(parent), true, 'an item holding only a sublist is still empty');
  // The task marker's checkbox is markup, not content: an unlabelled todo is an empty item.
  const todo = listDoc('- [ ] todo\n- b\n');
  const box = todo.doc.querySelector('li');
  box.childNodes[1].textContent = '';
  assert.ok(box.querySelector('input'), 'the box is still there');
  assert.equal(ListKeys.isEmptyItem(box), true);
});

test('atItemStart: nothing in front of the caret, or a task marker\'s separator space', () => {
  // `- [ ] todo` renders as a checkbox and the text node " todo", so the caret where the reader sees
  // the start of the line has one space behind it. That space is the marker's. A space the author
  // wrote is content, and trimming every kind of whitespace mistook one for the other.
  const task = listDoc('- [ ] todo\n- [x] done\n');
  const li = task.doc.querySelector('li');
  const label = li.childNodes[1];
  assert.equal(label.textContent, ' todo', 'the box, then a text node the space belongs to');
  const probe = li.ownerDocument.createRange();
  probe.selectNodeContents(li);
  probe.setEnd(label, 1);                              // the caret immediately before the t
  assert.equal(probe.toString(), ' ', 'one character behind the caret, and it is whitespace');
  assert.equal(ListKeys.atItemStart(li, probe.toString()), true, 'Backspace here lifts the item');
  probe.setEnd(label, 3);
  assert.equal(ListKeys.atItemStart(li, probe.toString()), false, 'further into the label it does not');

  // A code span opening with a space, in an item with no marker at all.
  const code = listDoc('- ` foo`\n- b\n');
  const span = code.doc.querySelector('li code').firstChild;
  assert.equal(span.textContent, ' foo');
  const r = code.doc.querySelector('li').ownerDocument.createRange();
  r.selectNodeContents(code.doc.querySelector('li'));
  r.setEnd(span, 1);                                   // the caret after the space, inside the code
  assert.equal(r.toString(), ' ', 'whitespace in front of the caret, same as the task item');
  assert.equal(ListKeys.atItemStart(code.doc.querySelector('li'), r.toString()), false,
    'a space the author wrote is a character Backspace deletes');
  assert.equal(ListKeys.atItemStart(code.doc.querySelector('li'), ''), true, 'the real start still lifts');

  // A picture in front of the caret. The Range's text is empty, so the text alone would call this the
  // start and lift the whole item; the Range itself carries the image.
  const pic = listDoc('- ![x](x.png)todo\n');
  const pli = pic.doc.querySelector('li');
  const ptext = [...pli.childNodes].find((n) => n.nodeType === 3 && n.textContent === 'todo');
  const pr = pli.ownerDocument.createRange();
  pr.selectNodeContents(pli); pr.setEnd(ptext, 0);    // the caret before the t, the image behind it
  assert.equal(pr.toString(), '', 'no text in front of the caret');
  assert.equal(ListKeys.atItemStart(pli, pr), false, 'Backspace here deletes at the image, not the item');
  pr.setEnd(pli, 0);
  assert.equal(ListKeys.atItemStart(pli, pr), true, 'in front of the image is the real start');
  // A line break is visible too, and a bold item's start is still its start.
  const br = listDoc('- x<br>todo\n');
  const bli = br.doc.querySelector('li');
  const btext = [...bli.childNodes].find((n) => n.nodeType === 3 && n.textContent === 'todo');
  const br0 = bli.ownerDocument.createRange(); br0.selectNodeContents(bli); br0.setEnd(btext, 0);
  assert.equal(ListKeys.atItemStart(bli, br0), false, 'the break in front of the caret is content');
  const bold = listDoc('- **bold** item\n');
  const bl = bold.doc.querySelector('li'), st = bl.querySelector('strong');
  const bs = bl.ownerDocument.createRange(); bs.selectNodeContents(bl); bs.setEnd(st.firstChild, 0);
  assert.equal(ListKeys.atItemStart(bl, bs), true, 'a wrapper opened at the caret is not content');
});

test('ownOffset / caretTarget: the caret is counted over the item\'s own text, both ways', () => {
  // A loose item with a sublist between its two paragraphs: `- a` / `  - b` / blank / `  continued`.
  // The item's own text is "a" and "continued"; "b" belongs to the item below. A caret measured
  // against the whole item counts "b" as well, and Tab then placed it that many characters along.
  const d = listDoc('- a\n  - b\n\n  continued\n');
  const li = d.doc.querySelector('li');
  const cont = [...li.querySelectorAll('p')].find((p) => p.textContent === 'continued').firstChild;
  assert.equal(li.querySelector('li').textContent, 'b', 'the fixture really nests an item between them');
  const off = ListKeys.ownOffset(li, cont, 3);         // the caret after "con"
  const back = ListKeys.caretTarget(li, off);
  assert.equal(back.node, cont, 'it round-trips to the node the caret was in');
  assert.equal(back.offset, 3, 'at the character it was on');
  // The whole-item measurement the Tab branch used to take counts the sublist's text as well, so the
  // caret came back that many characters further along.
  const whole = li.ownerDocument.createRange();
  whole.selectNodeContents(li); whole.setEnd(cont, 3);
  const sub = li.querySelector('ul').textContent;
  assert.ok(sub.includes('b'), 'the sublist holds text of its own');
  assert.equal(whole.toString().length - off, sub.length, 'and that is the whole difference');
  assert.notEqual(ListKeys.caretTarget(li, whole.toString().length).offset, 3,
    'which is why the old measurement did not round-trip');

  // Text before the sublist: the caret lands in that node, not in the child.
  const head = ListKeys.caretTarget(li, 1);
  assert.equal(head.node.textContent, 'a');
  assert.equal(head.offset, 1);
  assert.equal(ListKeys.ownOffset(li, head.node, 1), 1, 'and reads back as the same offset');
});

test('caretTarget: an item with no own text is given a node to hold the caret', () => {
  // A range at (li, 0) sits in front of the sublist, and every engine normalizes that into the
  // sublist's first item, so the next letter typed edits the child.
  const d = listDoc('- parent\n  - child\n');
  const li = d.doc.querySelector('li');
  li.firstChild.textContent = '';                      // the item the browser leaves behind
  const t = ListKeys.caretTarget(li, 0);
  assert.equal(t.node.nodeType, 3, 'a text node, not the item');
  assert.equal(t.node.parentNode, li, 'the item\'s own, not the child\'s');
  assert.equal(li.querySelector('li').contains(t.node), false, 'nowhere near the item below');
  // The node has to hold a character. Chrome verified 2026-09-14: a caret in an EMPTY own text node in
  // front of the sublist normalizes into the child exactly as a range at (li, 0) does, and the letter
  // typed after an Enter that outdented the item landed in the child.
  assert.equal(t.node.length, 1, 'an empty text node is no host either');
  assert.equal(t.node.textContent, '\u200b', 'the same host the inline rules use');
  assert.equal(ListKeys.isEmptyItem(li), true, 'and the host is not content');
  // The host is added, never written over what is there: a code span holding one space keeps it.
  const sp = listDoc('- ` `\n');
  const sli = sp.doc.querySelector('li');
  const before = sli.querySelector('code').textContent;
  ListKeys.caretTarget(sli, 0);
  assert.equal(sli.querySelector('code').textContent, before, 'the authored space survives');

  // An item that has no own text node at all is given one, since a range at (li, 0) sits in front of
  // the sublist and normalizes into it.
  const e = listDoc('- parent\n  - child\n');
  const bare = e.doc.querySelector('li');
  [...bare.childNodes].filter((n) => n.nodeType === 3).forEach((n) => n.remove());
  const seeded = ListKeys.caretTarget(bare, 0);
  assert.equal(seeded.node.textContent, '​', 'the zero-width space the inline rules already use');
  assert.equal(seeded.node.parentNode, bare);
  assert.equal(seeded.offset, seeded.node.length);
  assert.equal(ListKeys.isEmptyItem(bare), true, 'and the item still reads as empty through it');
  assert.equal(e.save().includes('​'), false, 'the seeded space never reaches the file');
});

test('ownOffset: an element anchor, and a caret the browser left in a nested item', () => {
  const d = listDoc('- a\n  - b\n\n  continued\n');
  const li = d.doc.querySelector('li');
  const kids = [...li.childNodes].filter((n) => n.nodeType === 1);
  const ownText = [...li.childNodes]
    .filter((n) => !['UL', 'OL'].includes(n.nodeName)).map((n) => n.textContent).join('');
  // An element anchor is an index into the children, not a character offset.
  assert.equal(ListKeys.ownOffset(li, li, 0), 0, 'in front of everything');
  assert.equal(ListKeys.ownOffset(li, li, li.childNodes.length), ownText.length, 'every own character');
  assert.equal(kids[0].nodeName, 'P');
  assert.equal(ListKeys.ownOffset(li, kids[0], 1), 1, 'past the first paragraph, which holds "a"');
  // A caret the browser left inside the sublist counts none of that sublist's text toward this item.
  const child = li.querySelector('li').firstChild;
  assert.equal(child.textContent, 'b');
  assert.equal(ListKeys.ownOffset(li, child, 1), ListKeys.ownOffset(li, child, 0),
    'nothing inside a nested item counts toward the item holding it');
});

test('outdent: the following siblings become children of the item that moved up', () => {
  const d = listDoc('- a\n  - b\n  - c\n  - d\n');
  assert.equal(ListKeys.outdent(d.item('b')).nodeName, 'LI');
  assert.equal(d.html(), '<ul><li>a</li><li>b<ul><li>c</li><li>d</li></ul></li></ul>',
    'c and d sat below b and still do');
  assert.equal(d.save(), '- a\n- b\n  - c\n  - d\n');
});

test('outdent: a top-level item has nowhere to go and the document is left alone', () => {
  const d = listDoc('- a\n- b\n');
  assert.equal(ListKeys.outdent(d.item('b')), null, 'null is the caller\'s signal that nothing changed');
  assert.equal(d.save(), '- a\n- b\n');
});

test('indent: the item moves into the previous item\'s sublist, or into a fresh one of the same type', () => {
  const fresh = listDoc('- a\n- b\n- c\n');
  assert.equal(ListKeys.indent(fresh.item('b')).nodeName, 'LI');
  assert.equal(fresh.html(), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(fresh.save(), '- a\n  - b\n- c\n');
  const existing = listDoc('- a\n  - x\n- b\n');
  ListKeys.indent(existing.item('b'));
  assert.equal(existing.html(), '<ul><li>a<ul><li>x</li><li>b</li></ul></li></ul>', 'joins the sublist already there');
  assert.equal(existing.save(), '- a\n  - x\n  - b\n');
  const ordered = listDoc('1. a\n2. b\n');
  ListKeys.indent(ordered.item('b'));
  assert.equal(ordered.doc.querySelector('li ol') && ordered.doc.querySelector('li ul'), null);
  assert.ok(ordered.doc.querySelector('li > ol'), 'a numbered list nests a numbered one');
});

test('indent: the first item of a list has nothing to nest under', () => {
  const d = listDoc('- a\n- b\n');
  assert.equal(ListKeys.indent(d.item('a')), null);
  assert.equal(d.save(), '- a\n- b\n', 'the document is untouched');
  // Nor does the first item of a SUBLIST indent again inside it.
  const nested = listDoc('- a\n  - b\n  - c\n');
  assert.equal(ListKeys.indent(nested.item('b')), null);
  assert.equal(nested.save(), '- a\n  - b\n  - c\n');
});

test('indent: an item carries its own sublist down with it', () => {
  const d = listDoc('- a\n- b\n  - b1\n');
  ListKeys.indent(d.item('b'));
  assert.equal(d.html(), '<ul><li>a<ul><li>b<ul><li>b1</li></ul></li></ul></li></ul>');
  assert.equal(d.save(), '- a\n  - b\n    - b1\n');
});

test('itemAt: the item holding the caret, and nothing inside an atomic block', () => {
  const d = listDoc('- a\n  - b\n');
  const text = d.item('b').firstChild;
  assert.equal(ListKeys.itemAt(text, d.doc), d.item('b'), 'the NEAREST item, not the one wrapping it');
  assert.equal(ListKeys.itemAt(d.doc, d.doc), null, 'the document itself is in no item');
  assert.equal(ListKeys.itemAt(null, d.doc), null);
  // A raw-HTML island carries its own source markdown and is not editable: a list drawn inside one is a
  // picture of a list, so the keys have to fall through to the browser exactly as every input rule does.
  const atomic = listDoc('<ul><li>raw</li></ul>\n');
  const inside = atomic.doc.querySelector('.block[data-atomic] li');
  assert.ok(inside, 'the fixture really is an atomic block');
  assert.equal(ListKeys.itemAt(inside, atomic.doc), null);
});

test('the rail measures again when a picture in a message finishes loading', () => {
  // clampMessages and dockCards both measure heights, and a screenshot in a reply has none until it
  // loads. `load` does not bubble, so the listener has to be a capturing one on the rail.
  const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert.match(page, /\$\('side'\)\.addEventListener\('load', \(e\) => \{[^\n]*tagName === 'IMG'[^\n]*scheduleDock\(\)[^\n]*\}, true\);/,
    'a capturing load listener on the rail that reschedules the dock for an image');
});

test('index.html loads listkeys.js and wires the three keys to it', () => {
  const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert.match(page, /<script src="\/listkeys\.js"><\/script>/, 'the module the rules live in is loaded');
  const at = page.indexOf('// Lists: Enter on an empty item');
  assert.ok(at > 0, 'the list handler is still findable');
  const handler = page.slice(at, page.indexOf('async function saveDoc', at));
  assert.match(handler, /!\['Enter', 'Backspace', 'Tab'\]\.includes\(e\.key\)/, 'all three keys');
  assert.match(handler, /ListKeys\.indent\(li\)/, 'Tab indents');
  assert.match(handler, /ListKeys\.outdent\(li\)/, 'Shift+Tab outdents');
  assert.match(handler, /ListKeys\.lift\(li\)/, 'Enter and Backspace both lift');
  assert.match(handler, /ListKeys\.isEmptyItem\(li\)/, 'Enter only on an empty item');
  // Guards, the same ones every other handler in the editor carries.
  assert.match(handler, /e\.isComposing \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey/);
  assert.match(handler, /!s\.isCollapsed/, 'a range selection is never intercepted');
  assert.match(handler, /dirty = true; setStatus\('editing…'\); scheduleSave\(\); scheduleDock\(\);/,
    'a list move changes the height of the blocks below it, and preventDefault fires no input event, ' +
    'so the handler redocks the rail the way the input listener does');
  // The table/code Backspace guard must still fire for a paragraph after a table, so exactly one of the
  // two handlers may act on one keystroke: the older one stands down while the caret is in an item.
  assert.match(page, /if \(ListKeys\.itemAt\(s\.anchorNode, \$\('doc'\)\)\) return;/,
    'the table guard defers to the list handler');
  assert.match(page, /\['TABLE', 'PRE'\]\.includes/, 'and is otherwise unchanged');
});

test('the list handler places the caret in the item itself, never in a list below it', () => {
  // setCaretOffset walks every text node under the element it is given. An item whose own text is
  // empty and whose sublist holds the only text in it would take the caret into the child, so the
  // next letter typed edits the child. The arithmetic that avoids that is ListKeys.ownOffset and
  // ListKeys.caretTarget, tested above; what the page holds is the reading and the placing.
  const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const at = page.indexOf('// Lists: Enter on an empty item');
  const handler = page.slice(at, page.indexOf('async function saveDoc', at));
  assert.match(handler, /ListKeys\.ownOffset\(li, s\.anchorNode, s\.anchorOffset\)/,
    'the Tab branch measures the caret over the item\'s own text');
  assert.doesNotMatch(handler, /caretOffsetIn\(li\)/, 'the whole-item measurement counts the sublist');
  assert.match(handler, /setItemCaret\(landed, off\)/, 'the Tab branch places it');
  assert.match(handler, /setItemCaret\(landed, 0\)/, 'and so does the lift branch');
  assert.doesNotMatch(handler, /setCaretOffset\(landed/, 'the walk-everything setter is not used here');
  assert.match(handler, /ListKeys\.atItemStart\(li, probe\)/,
    'and Backspace asks the module what the start of an item is');
  const fnAt = page.indexOf('function setItemCaret');
  assert.ok(fnAt > 0, 'the setter is still findable');
  const fn = page.slice(fnAt, page.indexOf('\n}', fnAt));
  assert.match(fn, /ListKeys\.caretTarget\(el, off\)/, 'a thin call over the tested arithmetic');

  // The shape the bug needs: an empty item between a parent and a child, where the only text under the
  // item that Enter lifts belongs to the item below it. Markdown cannot write an empty item (a bare
  // `-` under a line is a setext heading), so it is emptied here the way the browser empties one.
  const d = listDoc('- parent\n  - x\n  - child\n');
  const empty = d.item('x');
  empty.firstChild.textContent = '';
  assert.equal(ListKeys.isEmptyItem(empty), true, 'the fixture really has an empty item');
  const landed = ListKeys.lift(empty);
  assert.equal(landed.nodeName, 'LI', 'a nested item outdents rather than leaving the list');
  assert.equal(landed.textContent.trim(), 'child', 'and child is the only text under it');
  const own = [...landed.childNodes].filter((n) => !['UL', 'OL'].includes(n.nodeName));
  assert.equal(own.map((n) => n.textContent).join('').trim(), '', 'none of which is the item\'s own');
  // And the caret goes to the item, not into child.
  const target = ListKeys.caretTarget(landed, 0);
  assert.equal(target.node.parentNode, landed, 'the node the handler ranges to is the item\'s own');
});

// ---------- P1: turn/session, threaded suggestions, the wait loop ----------

test('review PUT preserves top-level session — last-writer-wins by `at` (no regress of a decision)', async () => {
  const p = path.join(dir, 'doc.md.sidecar.json');
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
  fs.writeFileSync(f + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'par1', kind: 'comment', by: 'alex', status: 'open', anchor: { quote: 'RESOLVEME target line.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T05:00:00Z', text: 'rewrite this' }] },
    { id: 'sug1', kind: 'suggestion', by: 'claude', status: 'pending', replyTo: 'par1',
      anchor: { quote: 'RESOLVEME target line.', occurrence: 0 }, replacement: 'RESOLVED replacement line.' }] }));
  const r = await post('/api/accept', { path: 'replydoc.md', id: 'sug1' });
  assert.equal(r.status, 200);
  const after = JSON.parse(fs.readFileSync(f + '.sidecar.json', 'utf8'));
  assert.equal(after.items.find(i => i.id === 'sug1').status, 'accepted');
  assert.equal(after.items.find(i => i.id === 'par1').status, 'resolved', 'parent comment resolves on accept');
  assert.match(fs.readFileSync(f, 'utf8'), /RESOLVED replacement line\./);
});

test('sidecar wait wakes on a new alex comment and exits 0 with a digest', async () => {
  const wf = path.join(dir, 'waitdoc.md');
  fs.writeFileSync(wf, '# W\n\nSome content here.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  // SIDECAR_PORT points at a dead port so the best-effort presence ping just errors out harmlessly.
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
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
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
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
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (d) => out += d.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
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
  const p = path.join(dir, 'flagthread.md.sidecar.json');
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
  fs.writeFileSync(f + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'rr1', kind: 'comment', by: 'alex', flag: true, status: 'open',
      anchor: { quote: 'Archive the old posts.', occurrence: 0 },
      thread: [{ by: 'alex', at: '2026-07-19T09:00:00Z', text: '🚩 Flagged for review.' }] }] }));
  const before = fs.readFileSync(f, 'utf8');
  const r = await post('/api/reject', { path: 'flagresolve.md', id: 'rr1' });
  assert.equal(r.status, 200);
  const rr1 = JSON.parse(fs.readFileSync(f + '.sidecar.json', 'utf8')).items.find(i => i.id === 'rr1');
  assert.equal(rr1.status, 'resolved', 'a flag comment resolves, it does not "reject"');
  assert.ok(rr1.decidedAt);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'settling a flag never touches the doc');
});

test('flag item orphans when its anchored text changes', async () => {
  const f = path.join(dir, 'flagorphan.md');
  fs.writeFileSync(f, '# RO\n\nPublish the RUNANCHOR line.\n');
  fs.writeFileSync(f + '.sidecar.json', JSON.stringify({ schema: 1, items: [
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
    assert.deepEqual(p.items, [], "the agent's next ping with an explicit empty list clears the mark");
  } finally {
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'a1' });
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'b2' });
  }
});

test('presence: an ABSENT items field keeps the marks and refreshes the clock; an empty array clears', async () => {
  // The distinction the CLI re-ping rides on. A working record has no heartbeat, so a five-minute reply
  // used to outlive its own marks; a write verb pings with no `items` at all, which must read as "still
  // here, leave my threads alone" rather than as the clear an empty list means.
  try {
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w1', items: ['t9'] });
    const first = (await state()).presence.until;
    await new Promise((r) => setTimeout(r, 20));   // so a refreshed `at` is visibly later
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w1' });   // items ABSENT
    let p = (await state()).presence;
    assert.deepEqual(p.items.map(x => x.id), ['t9'], 'an absent items field keeps what the agent already holds');
    assert.ok(p.until > first, 'and pushes the staleness horizon out, which is the whole point');
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w1', items: [] });
    p = (await state()).presence;
    assert.deepEqual(p.items, [], 'an explicit empty array is still the authoritative clear');
    // First contact with no items field creates the record empty-handed rather than failing.
    await post('/api/presence', { path: 'doc.md', state: 'working', agent: 'w2' });
    p = (await state()).presence;
    assert.equal(p.state, 'working');
    assert.deepEqual(p.items, [], 'a first ping with no items field holds nothing');
  } finally {
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'w1' });
    await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'w2' });
  }
});

test('a CLI write verb re-pings presence: the clock moves, the marks it did not set survive', async () => {
  const f = path.join(dir, 'clipres.md');
  fs.writeFileSync(f, '# CP\n\nThe line the agent will comment on.\n');
  const read = () => fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('clipres.md')).then(j);
  try {
    // Stand in for the wait exit: this agent came out of its wait holding two threads.
    await post('/api/presence', { path: 'clipres.md', state: 'working', agent: 'cliwriter', items: ['h1', 'h2'] });
    const first = (await read()).presence.until;
    await new Promise((r) => setTimeout(r, 20));
    // SIDECAR_PORT points at the REAL test server, so the write verb's ping lands where /api/state reads.
    execFileSync('node', [path.join(__dirname, 'server.js'), 'comment', 'clipres.md',
      '--quote', 'The line the agent will comment on.', '--text', 'still composing'],
      { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'cliwriter' } });
    const p = (await read()).presence;
    assert.equal(p.state, 'working', 'the write says the agent is still on this document');
    assert.ok(p.until > first, 'a write verb pushes the working window out');
    assert.deepEqual(p.items.map(x => x.id).sort(), ['h1', 'h2'],
      'the threads still in hand keep their marks — the write verb never declares items');
  } finally {
    await post('/api/presence', { path: 'clipres.md', state: 'idle', agent: 'cliwriter' });
    fs.rmSync(f + '.sidecar.json', { force: true });
    fs.rmSync(f, { force: true });
  }
});

test('wait exit ping carries the woken item ids — news and replies mark, a decided item does not', async () => {
  const wf = path.join(dir, 'waitpres.md');
  fs.writeFileSync(wf, '# WP\n\nPresence target line.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  // SIDECAR_PORT points at the REAL test server, so the exit ping lands where /api/state can read it.
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'pwaiter' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
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

// A rejection carrying a reason is the one decided status that gets an answer: the reason says what to
// try instead, so the agent goes off to compose a retry and the card should say so. The board showed
// nothing through that whole window until the decided category started marking.
test('wait exit ping marks a rejection that carries a reason', async () => {
  const wf = path.join(dir, 'waitreject.md');
  fs.writeFileSync(wf, '# WR\n\nReject target line.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'rs1', kind: 'suggestion', by: 'rwaiter', status: 'pending',
      anchor: { quote: 'Reject target line.', occurrence: 0 }, replacement: 'Rewritten target line.' }] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'rwaiter' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'rs1', kind: 'suggestion', by: 'rwaiter', status: 'rejected', decidedAt: '2026-08-13T00:00:00Z',
      anchor: { quote: 'Reject target line.', occurrence: 0 }, replacement: 'Rewritten target line.',
      thread: [{ by: 'alex', at: '2026-08-13T00:00:01Z', text: 'wrong tense, try the imperative' }] }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'wait exits 0 on the decision');
  const s = await j(await fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('waitreject.md')));
  assert.equal(s.presence?.state, 'working');
  assert.deepEqual(s.presence.items.map(x => x.id), ['rs1'],
    'a reasoned rejection marks the card, because a retry is coming');
});

// The other half of the rule. "Just no" usually ends the thread, so a light promising a reply would be
// lying, and a lying status light is worse than a dark one.
test('wait exit ping leaves a bare rejection dark', async () => {
  const wf = path.join(dir, 'waitbare.md');
  fs.writeFileSync(wf, '# WB\n\nBare target line.\n');
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'bs1', kind: 'suggestion', by: 'bwaiter', status: 'pending',
      anchor: { quote: 'Bare target line.', occurrence: 0 }, replacement: 'Rewritten bare line.' }] }));
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', wf, '--timeout', '10'],
    { env: { ...process.env, SIDECAR_PORT: String(PORT), SIDECAR_AGENT: 'bwaiter' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));
  fs.writeFileSync(wf + '.sidecar.json', JSON.stringify({ schema: 1, items: [
    { id: 'bs1', kind: 'suggestion', by: 'bwaiter', status: 'rejected', decidedAt: '2026-08-13T00:00:00Z',
      anchor: { quote: 'Bare target line.', occurrence: 0 }, replacement: 'Rewritten bare line.' }] }));
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'the rejection still wakes the wait');
  const s = await j(await fetchRetry(BASE + '/api/state?path=' + encodeURIComponent('waitbare.md')));
  assert.equal(s.presence?.state, 'working');
  assert.deepEqual(s.presence.items, [], 'a rejection with no reason marks nothing');
});

test('the agent is named by SIDECAR_AGENT, then by its harness, and is claude last', () => {
  const { agentName } = require('./lib/agent.js');
  assert.equal(agentName({}), 'claude', 'a harness nobody has verified is what it always was');
  assert.equal(agentName({ CLAUDECODE: '1' }), 'claude');
  assert.equal(agentName({ CODEX_THREAD_ID: 'x' }), 'codex', 'Codex sets this in every shell it runs');
  assert.equal(agentName({ CODEX_SESSION_ID: 'x' }), 'codex');
  assert.equal(agentName({ CODEX_THREAD_ID: 'x', CLAUDECODE: '1' }), 'codex',
    'a Codex launched from inside Claude Code inherits CLAUDECODE and is still Codex');
  assert.equal(agentName({ SIDECAR_AGENT: 'cursor', CODEX_THREAD_ID: 'x' }), 'cursor', 'the explicit name always wins');
  assert.equal(agentName({ SIDECAR_AGENT: '  ' }), 'claude', 'a blank name is no name');
  // One resolver, four readers.
  for (const f of ['server.js', 'lib/cli.js', 'lib/wait.js', 'lib/presence.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.match(src, /agent\.js'\)\.agentName\(\)/, f + ' asks lib/agent.js');
    assert.doesNotMatch(src, /SIDECAR_AGENT \|\| 'claude'/, f + ' carries no default of its own');
  }
});

test('presence names the agent that pinged, not the one the server was started by', async () => {
  await post('/api/presence', { path: 'doc.md', state: 'watching', agent: 'codex' });
  const s = await fetchRetry(`${BASE}/api/state?path=doc.md`).then(j);
  assert.equal(s.presence.agent, 'codex', 'the header prints this name');
  await post('/api/presence', { path: 'doc.md', state: 'idle', agent: 'codex' });
  assert.match(PAGE, /const name = esc\(\(live && state\.presence\.agent\) \|\| state\.agent\);/, 'and the page reads it');
  assert.doesNotMatch(PAGE, /'claude is (here|working)/, 'with no name written into the readout');
  // The header is the space between two panels, so the readout folds on the HEADER's width, not the window's.
  assert.match(PAGE, /header \{ container-type:inline-size; \}\s*@container \(max-width: 620px\) \{[\s\S]*?\.hwrap \.presence \{ position:static;/,
    'a narrow bar takes the readout into the flow as a dot, where it cannot print over the controls');
});

test('an agent is any name on the list, and a second human is not one', () => {
  const { agentNames } = require('./lib/agent.js');
  assert.deepEqual(agentNames({}), ['claude', 'codex'], 'the detectable ones, always');
  assert.deepEqual(agentNames({ SIDECAR_AGENT: 'robo', SIDECAR_AGENTS: 'cursor, aider' }), ['robo', 'claude', 'codex', 'cursor', 'aider']);
  const who = { agents: agentNames({}) };
  assert.equal(Turn.isAgent('claude', who), true);
  assert.equal(Turn.isAgent('codex', who), true, 'a second agent in the same review');
  assert.equal(Turn.isAgent('alex', who), false);
  assert.equal(Turn.isAgent('pat', who), false, 'a document travels between people; a second human stays a human');
  assert.equal(Turn.isAgent('', who), false);
  assert.equal(Turn.isAgent('claude', 'claude'), true, 'a bare name still means that one agent');
  assert.equal(Turn.isAgent('codex', 'claude'), false);
  // The badge counts a thread codex spoke last on as waiting on the human, on a server claude started.
  const review = { items: [{ id: 'c1', kind: 'comment', by: 'codex', status: 'open', anchor: { quote: 'x' },
    thread: [{ by: 'codex', at: '2026-09-18T10:00:00Z', text: 'a question' }] }] };
  assert.equal(Turn.of(review, who).turn, 1);
  assert.equal(Turn.of(review, 'claude').turn, 0, 'which the single-name rule missed');
  assert.match(PAGE, /function whoCls\(by\) \{ return \(state && Turn\.isAgent\(by, who\(\)\)\)/, 'the card colours ask the same question');
});

test('an agent renamed by detection inherits the cursor it kept under its old name', () => {
  const { legacyName, agentNames } = require('./lib/agent.js');
  assert.equal(legacyName({ CODEX_THREAD_ID: 'x' }), 'claude', 'a detected Codex used to be claude');
  assert.equal(legacyName({}), null, 'claude was always claude');
  assert.equal(legacyName({ SIDECAR_AGENT: 'codex', CODEX_THREAD_ID: 'x' }), null, 'a named agent always had its name');
  assert.deepEqual(agentNames({ SIDECAR_AGENT: 'robo', SIDECAR_USER: 'claude' }), ['robo', 'codex'],
    'and a human called claude is not on the list of agents');

  // The upgrade: a human reply lands while the cursor is filed under 'claude', then Codex is detected.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-legacy-'));
  fs.writeFileSync(path.join(d, 'doc.md'), '# doc\n\nA sentence to anchor to.\n');
  const run = (env, ...args) => spawnSync(process.execPath, [path.join(__dirname, 'server.js'), ...args],
    { cwd: d, env: { ...process.env, SIDECAR_PORT: '4993', ...env }, encoding: 'utf8' });
  run({}, 'comment', 'doc.md', '--quote', 'A sentence', '--text', 'a question');       // as 'claude'
  run({}, 'digest', 'doc.md');                                                          // cursor saved under 'claude'
  const id = JSON.parse(fs.readFileSync(path.join(d, 'doc.md.sidecar.json'), 'utf8')).items[0].id;
  run({ SIDECAR_AGENT: 'alex' }, 'reply', 'doc.md', id, 'the unseen answer');
  const first = run({ CODEX_THREAD_ID: 'x' }, 'digest', 'doc.md');
  assert.match(first.stdout, /the unseen answer/, 'the first look as codex reports what claude never saw');
  const dropped = run({ CODEX_THREAD_ID: 'x' }, 'drop', 'doc.md', id);
  assert.equal(dropped.status, 0, 'and the card it wrote under the old name is still its own to drop: ' + dropped.stderr);
  assert.match(dropped.stderr, /next: sidecar wait/, 'drop bypasses applyItems and still says to re-arm');
});

test('the wait reminder quotes a path that is not one shell word', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc nudge '));
  fs.writeFileSync(path.join(d, 'doc.md'), '# doc\n\nA sentence to anchor to.\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'server.js'), 'comment', 'doc.md', '--quote', 'A sentence', '--text', 'hello'],
    { cwd: d, env: { ...process.env, SIDECAR_AGENT: 'quoted', SIDECAR_PORT: '4993' }, encoding: 'utf8' });
  assert.match(r.stderr, /next: sidecar wait '[^']*sc nudge [^']*doc\.md'/, 'a space in a folder name stays inside one word');
});

test('a write with no watcher armed says what to run next, on stderr', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-nudge-'));
  fs.writeFileSync(path.join(d, 'doc.md'), '# doc\n\nA sentence to anchor to.\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'server.js'), 'comment', 'doc.md', '--quote', 'A sentence', '--text', 'hello'],
    { cwd: d, env: { ...process.env, SIDECAR_AGENT: 'nudged', SIDECAR_PORT: '4993' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /next: sidecar wait .*doc\.md/, 'the step agents skip, said when it is skipped');
  assert.doesNotMatch(r.stdout, /next: sidecar wait/, 'and stdout is the report it always was');
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
const sc = (d) => JSON.parse(fs.readFileSync(path.join(d, 'doc.md.sidecar.json'), 'utf8'));

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
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'no sidecar written');
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
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
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

test('CLI: a theme file is a document, so a comment left on one in the browser can be answered', () => {
  // The server opens `<root>/.sidecar/themes/*.json` as a document; the CLI rejected every `.json`, so a
  // human could comment on a theme in the browser and the agent could not read the thread, let alone
  // reply to it. One predicate answers for both sides now (lib/cli.js isThemeFile).
  const d = cliDir();
  const themes = path.join(d, '.sidecar', 'themes');
  fs.mkdirSync(themes, { recursive: true });
  const file = path.join(themes, 'midnight.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'midnight', scheme: 'dark',
    tokens: { '--bg': '#0b0c14', '--fg': '#e8e8e0' } }, null, 2) + '\n');
  cli(d, 'comment', file, '--quote', '#0b0c14', '--text', 'Too blue for a ground?');
  const review = () => JSON.parse(fs.readFileSync(file + '.sidecar.json', 'utf8'));
  assert.equal(review().items.length, 1, 'the comment lands in a sidecar beside the theme');
  const id = review().items[0].id;
  assert.match(cli(d, 'show', file), /Too blue for a ground\?/, 'and show reads it');
  cli(d, 'reply', file, id, 'Warmed it up.', '--resolve');
  assert.deepEqual(review().items[0].thread.map(m => m.text), ['Too blue for a ground?', 'Warmed it up.']);
  assert.equal(review().items[0].status, 'resolved');
  // A `.json` anywhere else is refused exactly as it was, which is the reason the exception is a path
  // rather than an extension: adding `.json` to the allowlist makes every sidecar a document.
  fs.writeFileSync(path.join(d, 'notatheme.json'), '{}');
  const plain = cliFails(d, 'show', path.join(d, 'notatheme.json'));
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /markdown and html assets/);
  // And so is a sidecar's own state sitting inside the themes directory.
  fs.writeFileSync(path.join(themes, 'stray.md.sidecar.json'), '{"schema":1,"items":[]}');
  assert.equal(cliFails(d, 'show', path.join(themes, 'stray.md.sidecar.json')).status, 2);
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
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
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
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
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
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'concurrent.md.sidecar.json'), 'utf8'));
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
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'nothing written');
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
  const scId = JSON.parse(fs.readFileSync(path.join(dir, 'splice.md.sidecar.json'), 'utf8')).items[0].id;
  const r = await post('/api/accept', { path: 'splice.md', id: scId });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /refusing to apply/);
  assert.equal(fs.readFileSync(path.join(dir, 'splice.md'), 'utf8'), md, 'file must be byte-identical');
});

test('accept still applies a normal single-block suggestion', async () => {
  fs.writeFileSync(path.join(dir, 'ok.md'), '# T\n\nWe ship all six features.\n');
  execFileSync('node', [BIN, 'suggest', 'ok.md', '--quote', 'We ship all six features.',
    '--replacement', 'We ship three features.'], { cwd: dir, encoding: 'utf8' });
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'ok.md.sidecar.json'), 'utf8')).items[0].id;
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
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'nothing written');
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
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'bullet.md.sidecar.json'), 'utf8')).items[0].id;
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
  const injId = JSON.parse(fs.readFileSync(path.join(dir, 'inject.md.sidecar.json'), 'utf8')).items[0].id;
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
  assert.ok(fs.existsSync(path.join(d, 'other.markdown.sidecar.json')));
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
  const it = JSON.parse(fs.readFileSync(path.join(d, 'fence.md.sidecar.json'), 'utf8')).items[0];
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
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'sidecar untouched — nothing written');
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
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'sidecar untouched');
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
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')), 'nothing written');
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

// SIDECAR_PORT points at a dead port so doctor takes its no-server path and never reaches whatever the
// developer happens to be running on the default one.
// SIDECAR_REGISTRY=off keeps these tests off the network; the registry check has its own tests below.
const doctorIn = (d, ...args) => execFileSync('node', [BIN, 'doctor', ...args],
  { cwd: d, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SIDECAR_PORT: '4990', SIDECAR_REGISTRY: 'off' } });

/* ---------------------------------------------------------------------------
   doctor asks the registry whether this install is current. Nothing in the package
   updates itself, so this line is where a stale global install or npx cache finds out.
   A local http server stands in for registry.npmjs.org.
--------------------------------------------------------------------------- */
const LOCAL_VERSION = require('./package.json').version;
const bump = (v) => { const p = v.split('.').map(Number); p[1] += 1; return p.join('.'); };
async function withRegistry(reply, fn) {
  const srv = http.createServer((req, res) => {
    if (typeof reply === 'number') { res.writeHead(reply); return res.end(); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(url); } finally { srv.close(); }
}
// Async, because the fake registry lives in this process and a sync exec would starve it.
const doctorWithRegistry = (d, url) => new Promise((resolve, reject) => {
  const child = spawn('node', [BIN, 'doctor'],
    { cwd: d, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIDECAR_PORT: '4990', SIDECAR_REGISTRY: url } });
  let out = ''; child.stdout.on('data', (b) => { out += b; });
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`doctor exited ${code}\n${out}`))));
});

test('doctor says a newer version is on the registry, and the one command that installs it', async () => {
  const d = cliDirNoGit();
  const out = await withRegistry({ version: bump(LOCAL_VERSION) }, (url) => doctorWithRegistry(d, url));
  assert.match(out, new RegExp(`registry:\\s+v${bump(LOCAL_VERSION).replace(/\./g, '\\.')} available`));
  assert.match(out, /npm i -g @spktr\/sidecar@latest/, 'names the upgrade command');
  assert.match(out, /this cli:\s+v/, 'the local version line is still printed first');
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor says current when the registry matches, and never suggests an upgrade', async () => {
  const d = cliDirNoGit();
  const out = await withRegistry({ version: LOCAL_VERSION }, (url) => doctorWithRegistry(d, url));
  assert.match(out, /registry:\s+v\S+\s+✓ current/);
  assert.doesNotMatch(out, /@latest/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor says the registry is unreachable rather than guessing, and still finishes', async () => {
  const d = cliDirNoGit();
  const dead = await withRegistry({}, (url) => url);          // the port is closed once withRegistry returns
  const out = await doctorWithRegistry(d, dead);
  assert.match(out, /registry:\s+unreachable/);
  assert.doesNotMatch(out, /@latest/, 'no verdict, no upgrade nag');
  assert.match(out, /server:\s+NOT RUNNING/, 'the rest of doctor still ran');
  const off = doctorIn(d);
  assert.match(off, /registry:\s+check skipped/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor warns when the digest state files are not gitignored, and goes quiet once they are', () => {
  const d = cliDir();   // a git repo with no .gitignore, which is the state a host repo starts in
  assert.match(doctorIn(d, 'doc.md'), /\*\.sidecar\.seen\*/, 'the warning names the exact pattern to add');
  assert.match(doctorIn(d, 'doc.md'), /\.gitignore/, 'and says where it goes');
  fs.writeFileSync(path.join(d, '.gitignore'), '*.sidecar.seen*\n');
  assert.doesNotMatch(doctorIn(d, 'doc.md'), /\.seen/, 'ignored → nothing extra to say');
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor says nothing about gitignore outside a git work tree', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-nogit-'));
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  assert.doesNotMatch(doctorIn(d, 'doc.md'), /\.seen/, 'no repo, nothing to ignore');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   The .review.* → .sidecar.* rename (1.7.0). A load migrates; doctor reports
   what a load has not reached yet.
   --------------------------------------------------------------------------- */

// stdout AND stderr: the rename notice goes to stderr on purpose, so it can never land in the middle
// of `show --json`.
const cliBoth = (d, ...args) => {
  const r = spawnSync('node', [BIN, ...args], { cwd: d, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, status: r.status };
};

// A complete pre-1.7 sibling set: the review, the cursor, one agent's doc baseline, an asset dir.
function legacySet(d, doc = 'doc.md') {
  const at = path.join(d, doc);
  fs.writeFileSync(at + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'legacy1', kind: 'comment', by: 'you', status: 'open',
      anchor: { quote: 'Success metrics are not defined yet.' },
      thread: [{ by: 'you', at: '2026-08-01T10:00:00Z', text: 'from before the rename' }] }] }));
  fs.writeFileSync(at + '.review.seen.json', JSON.stringify({ claude: { docHash: 'abc', items: {}, at: '2026-08-01T10:00:00Z' } }));
  fs.writeFileSync(at + '.review.seen.base.claude', CLI_DOC);
  fs.mkdirSync(at + '.review.assets', { recursive: true });
  fs.writeFileSync(path.join(at + '.review.assets', 'ab12cd34ef56.png'), 'not really a png');
}

test('a load renames the whole pre-1.7 sibling set, items and all, and says so once', () => {
  const d = cliDir();
  legacySet(d);
  const { out, err } = cliBoth(d, 'show', 'doc.md');
  for (const suffix of ['.sidecar.json', '.sidecar.seen.json', '.sidecar.seen.base.claude',
                        '.sidecar.assets', '.sidecar.assets/ab12cd34ef56.png'])
    assert.ok(fs.existsSync(path.join(d, 'doc.md' + suffix)), `${suffix} moved across`);
  const left = fs.readdirSync(d).filter(n => n.includes('.review.'));
  assert.deepEqual(left, [], 'nothing keeps the old name');
  assert.match(out, /legacy1/, 'the review still reads, through its new name');
  assert.equal(err.trim().split('\n').length, 1, 'one line about the rename, not one per file');
  assert.match(err, /\.sidecar\./);
  fs.rmSync(d, { recursive: true, force: true });
});

test('both names present: the new one wins, the old one is left alone and warned about', () => {
  const d = cliDir();
  legacySet(d);
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'current1', kind: 'comment', by: 'you', status: 'open',
      anchor: { quote: 'Success metrics are not defined yet.' },
      thread: [{ by: 'you', at: '2026-08-13T10:00:00Z', text: 'after the rename' }] }] }));
  const { out, err } = cliBoth(d, 'show', 'doc.md');
  assert.match(out, /current1/, 'the .sidecar.json is what gets read');
  assert.doesNotMatch(out, /legacy1/, 'the two item sets are never merged');
  assert.match(err, /both/i, 'and the ambiguity is said out loud');
  assert.ok(fs.existsSync(path.join(d, 'doc.md.review.json')), 'the old file is left for a human to decide about');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the server migrates on load as well — the rename sits in the shared load path', async () => {
  const f = path.join(dir, 'renamed.md');
  fs.writeFileSync(f, DOC);
  fs.writeFileSync(f + '.review.json', JSON.stringify({ schema: 1, items: [
    { id: 'srv1', kind: 'comment', by: 'you', status: 'open', anchor: { quote: 'Closing paragraph.' }, thread: [] }] }));
  const s = await fetchRetry(`${BASE}/api/state?path=renamed.md`).then(j);
  assert.deepEqual(s.review.items.map(i => i.id), ['srv1'], 'the review arrives, read from its new name');
  assert.ok(fs.existsSync(f + '.sidecar.json'));
  assert.ok(!fs.existsSync(f + '.review.json'));
});

// Rolling a current sibling set back to the old names, which is what a pre-1.7 install left behind.
const unrename = (d) => { for (const n of fs.readdirSync(d).filter(n => n.includes('.sidecar.')))
  fs.renameSync(path.join(d, n), path.join(d, n.replace('.sidecar.', '.review.'))); };

test('the migrated cursor is still a cursor — no spurious full replay after the rename', () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');
  unrename(d);
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new/, 'the cursor came across with the review');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a wait armed on pre-1.7 names still surfaces the backlog its cursor was holding', async () => {
  const d = cliDir();
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'targets?');
  cli(d, 'digest', 'doc.md');   // the cursor knows about that card, and about nothing after it
  patchReview(d, (r) => r.items.push({ id: 'human1', kind: 'comment', by: 'you', status: 'open',
    anchor: { quote: 'Repeated line here.', occurrence: 0 },
    thread: [{ by: 'you', at: '2026-08-13T10:00:00Z', text: 'and this one?' }] }));
  unrename(d);
  // The load is what renames, so it has to run before the cursor is read: an unrenamed cursor reads as
  // no cursor, the baseline falls back to current state, and this card sleeps until the timeout.
  const { code, out } = await spawnWait(d, { timeout: 3 });
  assert.equal(code, 0, 'it wakes on the backlog instead of sleeping through it');
  assert.match(out, /and this one\?/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor reports files still on the .review.* names, and the command that renames them', () => {
  const d = cliDir();
  legacySet(d);
  const out = doctorIn(d, 'doc.md');
  assert.match(out, /still on the pre-1\.7 \.review\.\* names/);
  assert.match(out, /doc\.md\.review\.json/, 'it names what it found');
  assert.match(out, /sidecar show/, 'and how to fix it');
  fs.rmSync(d, { recursive: true, force: true });
});

test('doctor treats a *.review.seen* gitignore pattern as stale, covered or not', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, '.gitignore'), '*.review.seen*\n');
  const before = doctorIn(d, 'doc.md');
  assert.match(before, /\*\.sidecar\.seen\*/, 'the pattern that would actually cover the state');
  assert.match(before, /\.gitignore:1:\*\.review\.seen\*.*pre-1\.7/, 'and the line holding the dead one');
  fs.writeFileSync(path.join(d, '.gitignore'), '*.sidecar.seen*\n*.review.seen*\n');
  const after = doctorIn(d, 'doc.md');
  assert.match(after, /dead \.gitignore line/, 'covered, and the old line is still worth deleting');
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
const patchReview = (d, fn) => { const p = path.join(d, 'doc.md.sidecar.json');
  const r = JSON.parse(fs.readFileSync(p, 'utf8')); fn(r); fs.writeFileSync(p, JSON.stringify(r, null, 2)); };
const seen = (d) => { const p = path.join(d, 'doc.md.sidecar.seen.json');
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
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.seen.json'), '{ this is not json');
  const out = cli(d, 'digest', 'doc.md');            // must not throw
  assert.match(out, /no last-seen marker/, 'corrupt cursor degrades to full replay');
  fs.rmSync(path.join(d, 'doc.md.sidecar.seen.json'));
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

/* The removed list had no authorship check, so `sidecar drop` on the agent's own card came back at that
   same agent as REMOVED and woke its own `wait` one turn later (reproduced 2026-08-13). The news path
   had filtered on authorship since the start; removals never did. */
test('digest: the agent dropping its own card wakes nothing', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'digest', 'doc.md');                        // cursor holds the card, authored by claude
  cli(d, 'drop', 'doc.md', sc(d).items[0].id);
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new since/, 'I withdrew it, so it is not news to me');
  fs.rmSync(d, { recursive: true, force: true });
});

// The guard on that fix: it scopes by author, never by "a removal is boring". Someone else's card
// disappearing is a real change to the review and has to keep reporting.
test('digest: a card someone else authored still reports when it is removed', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'doc.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-human', kind: 'comment', by: 'alex', status: 'open',
      anchor: { quote: 'Success metrics', occurrence: 0 }, thread: [] }] }, null, 2));
  cli(d, 'digest', 'doc.md');                        // cursor records it as alex's
  patchReview(d, (r) => { r.items = r.items.filter(i => i.id !== 'c-human'); });
  assert.match(cli(d, 'digest', 'doc.md'), /REMOVED c-human/, "the human's card vanishing is still news");
  fs.rmSync(d, { recursive: true, force: true });
});

// A cursor written before `by` existed cannot say who owned the card. It reports rather than staying
// silent, so the change fails noisy: one stale wake, and the next cursor advance heals it. No migration.
test('digest: a legacy cursor entry with no author still reports the removal', () => {
  const d = cliDir();
  cli(d, 'suggest', 'doc.md', '--quote', 'Success metrics', '--replacement', 'Success metrics (defined below)');
  cli(d, 'digest', 'doc.md');
  const id = sc(d).items[0].id;
  const sp = path.join(d, 'doc.md.sidecar.seen.json');
  const all = JSON.parse(fs.readFileSync(sp, 'utf8'));
  delete all.claude.items[id].by;                    // as an older sidecar would have written it
  fs.writeFileSync(sp, JSON.stringify(all, null, 2));
  cli(d, 'drop', 'doc.md', id);                      // the agent's OWN card, but the cursor cannot know
  assert.match(cli(d, 'digest', 'doc.md'), new RegExp('REMOVED ' + id), 'an unattributable removal reports');
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

test('wait: an accept prints once per wake and reports its decision exactly once', async () => {
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
  // The watcher is a separate process: it can read between the document and review writes.
  // An early document-only wake is valid; the persisted cursor must still deliver the decision
  // on the next look. Requiring both writes in one wake raced on Linux CI.
  const catchup = cli(d, 'digest', 'doc.md');
  assert.equal(((out + catchup).match(/ACCEPTED/g) || []).length, 1, 'exactly one ACCEPTED line across both looks');
  assert.match(cli(d, 'digest', 'doc.md'), /nothing new/, 'both writes have been consumed');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------
   Doc baseline — the digest's own copy of the document (lib/digest.js basePath).
   The doc half of the digest diffs against the agent's last look, not git HEAD:
   untracked docs, non-git dirs, and mid-review commits must all produce real
   hunks, and nothing may be re-sent across looks.
   --------------------------------------------------------------------------- */

const basefile = (d, agent = 'claude', doc = 'doc.md') => path.join(d, doc + '.sidecar.seen.base.' + agent);
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

test('flow render: the canvas states its own width, which is what the page sizes it by', () => {
  // index.html's sizeFlow sets a min-width from this, so the diagram stops shrinking before its labels
  // stop being readable and the box scrolls instead (.fl-scroll). It reads the width attribute and
  // falls back to the viewBox, so both have to be there and both have to say the same thing.
  const { svg } = Flow.render('LR\nSign up --> Verify email --> Pick a plan --> Start the trial');
  const w = Number((svg.match(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/) || [])[1]);
  const vb = (svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/) || []).slice(1).map(Number);
  assert.ok(w > 0, 'a numeric width');
  assert.equal(vb[0], w, 'and the viewBox agrees with it');
  assert.ok(w > 500, 'a four-node chain across is wider than a phone, which is the case this exists for');
});

// ---------- the directory panel's ordering (public/navsort.js) ----------
// The SAME file index.html loads via <script>, so what the panel draws is what these assert.
const Nav = require('./public/navsort.js');
const docsOf = (names) => names.map((n, i) => ({ rel: 'p/' + n, name: n, mtime: 1000 + i }));
const namesOf = (list) => list.map(d => d.name);

test('spine sort: summary first, brief second, the rest alphabetical', () => {
  const out = Nav.sort(docsOf(['market-research.md', 'brief.md', 'zeta.md', 'summary.md', 'business-case.md']), 'spine');
  assert.deepEqual(namesOf(out), ['summary.md', 'brief.md', 'business-case.md', 'market-research.md', 'zeta.md']);
});

test('spine sort: a folder with neither summary nor brief is plain alphabetical', () => {
  const out = Nav.sort(docsOf(['zeta.md', 'alpha.md', 'middle.md']), 'spine');
  assert.deepEqual(namesOf(out), ['alpha.md', 'middle.md', 'zeta.md']);
});

test('spine sort: brief leads when there is no summary, and neither name is hoisted from a longer one', () => {
  const out = Nav.sort(docsOf(['design-brief.md', 'automated-pursuit-brief.md', 'brief.md', 'a-summary.md']), 'spine');
  // Only the exact filenames are the spine — `design-brief.md` is an ordinary document, and a folder
  // full of *-brief.md (the grant-developer one) must not have one of them promoted at random.
  assert.deepEqual(namesOf(out), ['brief.md', 'a-summary.md', 'automated-pursuit-brief.md', 'design-brief.md']);
});

test('spine sort: an .html asset sits in the same order as markdown, by name', () => {
  const out = Nav.sort(docsOf(['poster.html', 'notes.md', 'summary.md']), 'spine');
  assert.deepEqual(namesOf(out), ['summary.md', 'notes.md', 'poster.html']);
});

test('spine sort: names collate numerically, so slice2 comes before slice10', () => {
  const out = Nav.sort(docsOf(['slice10-walkthrough.md', 'slice2-walkthrough.md']), 'spine');
  assert.deepEqual(namesOf(out), ['slice2-walkthrough.md', 'slice10-walkthrough.md']);
});

test('spine sort is total and repeatable — case never leaves two names tied to readdir order', () => {
  const a = Nav.sort(docsOf(['Beta.md', 'beta.md', 'Alpha.md']), 'spine');
  const b = Nav.sort(docsOf(['beta.md', 'Alpha.md', 'Beta.md']), 'spine');
  assert.deepEqual(namesOf(a), namesOf(b), 'the same set sorts the same way whatever order it arrives in');
  assert.equal(namesOf(a)[0], 'Alpha.md');
});

test('sort does not mutate the list it is given', () => {
  const input = docsOf(['zeta.md', 'summary.md']);
  Nav.sort(input, 'spine');
  assert.deepEqual(namesOf(input), ['zeta.md', 'summary.md'], 'the caller keeps its own order');
});

test('updated sort: newest first, and equal timestamps fall back to spine order', () => {
  const docs = [
    { rel: 'p/old.md', name: 'old.md', mtime: 10 },
    { rel: 'p/new.md', name: 'new.md', mtime: 90 },
    { rel: 'p/zeta.md', name: 'zeta.md', mtime: 50 },
    { rel: 'p/summary.md', name: 'summary.md', mtime: 50 },
  ];
  assert.deepEqual(namesOf(Nav.sort(docs, 'updated')), ['new.md', 'summary.md', 'zeta.md', 'old.md']);
});

test('updated sort: a document with no mtime sorts last rather than throwing', () => {
  const docs = [{ rel: 'p/a.md', name: 'a.md' }, { rel: 'p/b.md', name: 'b.md', mtime: 5 }];
  assert.deepEqual(namesOf(Nav.sort(docs, 'updated')), ['b.md', 'a.md']);
});

test('waiting-on-you sort: turn counts descending, and with none it IS spine order', () => {
  const plain = docsOf(['zeta.md', 'brief.md', 'summary.md']);
  // A folder where nothing is open (or where no document has a sidecar at all) carries no counts, and
  // the mode has to resolve to the spine order rather than to whatever readdir returned.
  assert.deepEqual(namesOf(Nav.sort(plain, 'turn')), namesOf(Nav.sort(plain, 'spine')));
  const counted = [
    { rel: 'p/summary.md', name: 'summary.md', turn: 0 },
    { rel: 'p/zeta.md', name: 'zeta.md', turn: 3 },
    { rel: 'p/brief.md', name: 'brief.md', turn: 1 },
  ];
  assert.deepEqual(namesOf(Nav.sort(counted, 'turn')), ['zeta.md', 'brief.md', 'summary.md']);
});

test('an unknown sort mode falls back to spine rather than to nothing', () => {
  const docs = docsOf(['zeta.md', 'summary.md']);
  assert.deepEqual(namesOf(Nav.sort(docs, 'nonsense')), ['summary.md', 'zeta.md']);
  assert.deepEqual(namesOf(Nav.sort(docs, undefined)), ['summary.md', 'zeta.md']);
  assert.deepEqual(Nav.sort(undefined, 'spine'), [], 'and no list at all is an empty one');
});

test('every sort mode the panel offers is one the sorter answers to', () => {
  // The switcher renders straight off MODES/LABELS, so a mode with no label would draw as `undefined`.
  for (const m of Nav.MODES) assert.equal(typeof Nav.LABELS[m], 'string', `${m} has a label`);
  assert.deepEqual(Nav.MODES, ['spine', 'updated', 'turn']);
});

// ---------- whose turn is it: the panel's badges (public/turn.js) ----------
// The SAME file index.html loads via <script> AND server.js requires — the badge the panel draws and
// the count /api/dir computes are this function, once. Every case below is therefore a case both
// sides answer identically, which is the whole reason it is one module.
const Turn = require('./public/turn.js');
const AGENT = 'claude', HUMAN = 'alex';
let seq = 0;
const msg = (by, text) => ({ by, at: new Date(Date.UTC(2026, 7, 15, 12, 0, seq++)).toISOString(), text });
const comment = (id, status, ...thread) =>
  ({ id, kind: 'comment', by: thread[0] ? thread[0].by : AGENT, anchor: { quote: 'the ' + id + ' span' }, status, thread });
const sug = (id, status) => ({ id, kind: 'suggestion', by: AGENT, anchor: { quote: 'the ' + id + ' span' }, replacement: 'x', status });

test('a doc with two agent-last threads and one pending suggestion badges 3', () => {
  // The acceptance case from the plan, stated as arithmetic.
  const review = { schema: 1, items: [
    comment('c1', 'open', msg(HUMAN, 'what about this'), msg(AGENT, 'here is why')),
    comment('c2', 'open', msg(AGENT, 'this paragraph contradicts the one above')),
    sug('s1', 'pending'),
    comment('c3', 'open', msg(AGENT, 'a question'), msg(HUMAN, 'answered')),   // the agent's move now
    comment('c4', 'resolved', msg(AGENT, 'settled')),                           // not live at all
    sug('s2', 'accepted'),
  ] };
  const t = Turn.of(review, AGENT);
  assert.equal(t.turn, 3, 'two agent-last comments and one pending suggestion');
  assert.equal(t.open, 4, 'the human-last comment is open too, just not yours');
  assert.deepEqual(t.items.filter(i => i.turn).map(i => i.id), ['c1', 'c2', 's1']);
});

test('turn is keyed off the agent NAME, so any other author reads as the human', () => {
  const review = { schema: 1, items: [comment('c1', 'open', msg('gemini', 'hello'))] };
  assert.equal(Turn.of(review, 'gemini').turn, 1, 'a differently named agent still holds the turn');
  assert.equal(Turn.of(review, AGENT).turn, 0, 'and to claude it is someone else speaking');
  // The default SIDECAR_USER, a legacy `alex`, and a custom name all read as the human — the same rule
  // index.html's whoCls uses to colour the chip.
  for (const who of ['you', 'alex', 'Alexandra']) {
    assert.equal(Turn.of({ items: [comment('c1', 'open', msg(who, 'hi'))] }, AGENT).turn, 0, who);
  }
});

test('a comment with no thread falls back to its author', () => {
  // `sidecar comment` always writes a thread, but an item hand-written into the JSON may not have one,
  // and an agent's unanswered comment is the clearest "your turn" there is.
  const bare = { id: 'c1', kind: 'comment', by: AGENT, anchor: { quote: 'x' }, status: 'open' };
  assert.equal(Turn.of({ items: [bare] }, AGENT).turn, 1);
  assert.equal(Turn.of({ items: [{ ...bare, by: HUMAN }] }, AGENT).turn, 0);
});

test('an orphaned suggestion is open but is the AGENT\'s move; an orphaned comment keeps the thread rule', () => {
  // Repairing a broken anchor is `sidecar reanchor`, which the human cannot run — so it gets the
  // neutral dot. A comment on a broken anchor is still a conversation, and whoever spoke last owns it.
  const t = Turn.of({ items: [
    sug('s1', 'orphaned'),
    comment('c1', 'orphaned', msg(AGENT, 'still asking')),
    comment('c2', 'orphaned', msg(HUMAN, 'still answering')),
  ] }, AGENT);
  assert.equal(t.open, 3);
  assert.deepEqual(t.items.filter(i => i.turn).map(i => i.id), ['c1']);
});

test('a settled item counts for nothing, whatever it used to be', () => {
  const t = Turn.of({ items: [
    comment('c1', 'resolved', msg(AGENT, 'x')), sug('s1', 'accepted'), sug('s2', 'rejected'),
  ] }, AGENT);
  assert.deepEqual(t, { turn: 0, open: 0, items: [] });
});

test('a missing, empty or malformed review is zero badges rather than a throw', () => {
  // The renamed-file case: a document whose sidecar is still `.review.json` has no `.sidecar.json` for
  // the panel to read, and one truncated by a crashed write parses to nothing useful. Neither may take
  // the folder listing down with it — every OTHER document in that folder still has to draw.
  for (const bad of [undefined, null, {}, { items: null }, { items: [] }, { items: [{}] },
                     { items: [{ id: 'x', status: 'open' }] }]) {
    const t = Turn.of(bad, AGENT);
    assert.equal(t.turn, 0, JSON.stringify(bad));
  }
  // An item with no anchor and no kind is still LIVE and still counts as open — it is a real card in
  // the rail. It just has no quote to show, and the item says so rather than carrying "undefined".
  assert.equal(Turn.of({ items: [{ id: 'x', status: 'open' }] }, AGENT).open, 1);
  assert.equal(Turn.of({ items: [{ id: 'x', status: 'open' }] }, AGENT).items[0].quote, '');
});

test('a live item carries enough to be recognised, with the quote cut to one line', () => {
  const long = 'word '.repeat(80).trim();
  const it = Turn.of({ items: [{ id: 'c1', kind: 'comment', by: HUMAN, status: 'open',
    anchor: { quote: 'a\n  quote   across\nlines' }, thread: [msg(AGENT, 'hi')] }] }, AGENT).items[0];
  assert.equal(it.by, AGENT, 'who spoke LAST, which is who the row is waiting on');
  assert.equal(it.kind, 'comment');
  assert.equal(it.quote, 'a quote across lines', 'whitespace collapsed to one line');
  assert.ok(it.at, 'and when it last moved');
  const cut = Turn.of({ items: [comment('c1', 'open', msg(AGENT, long))] }, AGENT).items[0];
  assert.ok(cut.quote.length <= Turn.QUOTE_MAX, 'never longer than the cap');
  const big = Turn.of({ items: [{ id: 'c1', kind: 'comment', status: 'open', anchor: { quote: long } }] }, AGENT);
  assert.equal(big.items[0].quote.length, Turn.QUOTE_MAX);
  assert.ok(big.items[0].quote.endsWith('…'), 'and says it was cut');
});

test('a flag reads as its own kind, not as a comment', () => {
  const t = Turn.of({ items: [{ id: 'f1', kind: 'comment', flag: true, by: AGENT, status: 'open',
    anchor: { quote: 'x' }, thread: [msg(AGENT, 'blocking')] }] }, AGENT);
  assert.equal(t.items[0].kind, 'flag');
  assert.equal(t.turn, 1, 'and it is still the human\'s turn');
});

test('the folder has no inbox: the rows\' badges are the one account of what is waiting', () => {
  // A second tab listed every open item across the folder. The badge on each row already says which
  // documents want the human, and opening one shows its threads in the rail, so it was a second road
  // to the same place.
  assert.equal(Turn.inbox, undefined, 'the model no longer builds one');
  assert.doesNotMatch(PAGE, /navInbox|nav-tabs|data-view=/, 'and the panel no longer draws one');
});

// ---------- the rail's resting shape (Turn.rail) ----------
// index.html's renderSide hands this the two counts it has already sorted out, and turns 'bare' into
// body.rail-bare: a 12px hairline track, no tab bar, nothing drawn. So these are the cases that decide
// whether the review column is on screen at all before the human has done anything.

test('a document with nothing open and nothing archived rests as a hairline', () => {
  assert.equal(Turn.rail(0, 0), 'bare');
});

test('a document with everything settled keeps its tab bar', () => {
  // The archive is a click away and the count on the tab is the only thing saying so, so the rail
  // stays. What goes is the sentence that used to sit under the tabs explaining the emptiness.
  assert.equal(Turn.rail(0, 1), 'tabs');
  assert.equal(Turn.rail(0, 12), 'tabs');
});

test('one open thread is enough to bring the whole rail back', () => {
  assert.equal(Turn.rail(1, 0), 'full', 'the first card expands it');
  assert.equal(Turn.rail(1, 3), 'full');
  assert.equal(Turn.rail(9, 9), 'full');
});

test('the rail rests bare on the counts a real empty review produces', () => {
  // Wired end to end rather than asserted on literals: a review whose items are all settled is the
  // 'tabs' case, and one with no items at all is the 'bare' case, counted the way renderSide counts.
  const settled = { schema: 1, items: [comment('c1', 'resolved', msg(AGENT, 'x')), sug('s1', 'accepted')] };
  const live = Turn.of(settled, AGENT);
  assert.equal(live.open, 0, 'nothing live');
  assert.equal(Turn.rail(live.open, settled.items.length - live.open), 'tabs');
  const empty = { schema: 1, items: [] };
  const none = Turn.of(empty, AGENT);
  assert.equal(Turn.rail(none.open, empty.items.length - none.open), 'bare');
});

// ---------- the rail's density, and which cards rest collapsed (Turn.density / startCollapsed) ----------
// The rail has two densities. The rule for which cards fold is the
// SAME `waiting` rule the panel's badge runs, so a card is full exactly when the badge would have
// counted it, and the two cannot drift because there is one function under both.

test('a stored density that is not one of the two reads as compact', () => {
  // The stored value comes back through localStorage, which a human can edit and an older build may
  // have written. Anything unrecognised must not leave the rail in a state no control can name.
  // 'hidden' was a third density until the header's panel toggle was left as the one way to shut the
  // rail, so an install that stored it must come back at the default rather than at nothing.
  for (const raw of ['', null, undefined, 'dense', 'hidden', 'HIDDEN', '__proto__', 'constructor']) {
    assert.equal(Turn.density(raw), 'compact', JSON.stringify(raw));
  }
  for (const d of Turn.DENSITIES) assert.equal(Turn.density(d), d, d);
  assert.equal(Turn.DENSITY_REST, 'compact', 'and compact is where an untouched install rests');
});

test('the density is a toggle between two states, and neither of them shuts the panel', () => {
  assert.deepEqual(Turn.DENSITIES, ['full', 'compact'], 'densest first, and no state that hides the rail');
  const walk = [];
  let d = Turn.DENSITY_REST;
  for (let i = 0; i < 2; i++) { d = Turn.nextDensity(d); walk.push(d); }
  assert.deepEqual(walk, ['full', 'compact'], 'two clicks from compact land back on compact');
  assert.equal(Turn.nextDensity('nonsense'), 'full', 'a junk value toggles as if it were the default');
});

test('at full nothing folds', () => {
  const items = [comment('c1', 'open', msg(HUMAN, 'over to you')), comment('c2', 'resolved', msg(AGENT, 'done')),
                 sug('s1', 'pending')];
  for (const d of ['full']) {
    for (const it of items) assert.equal(Turn.startCollapsed(it, AGENT, d), false, `${it.id} at ${d}`);
  }
});

test('a thread waiting on the AGENT rests collapsed; one waiting on the human stays full', () => {
  // The human said the last word and the ball is in claude's court: there is nothing to do on this card
  // and nothing to read on it that the human did not just write.
  const mine = comment('c1', 'open', msg(AGENT, 'a question'), msg(HUMAN, 'answered'));
  assert.equal(Turn.startCollapsed(mine, AGENT, 'compact'), true);
  // Claude asked and nobody answered, so the card is the question.
  const theirs = comment('c2', 'open', msg(AGENT, 'a question'));
  assert.equal(Turn.startCollapsed(theirs, AGENT, 'compact'), false);
  // The same split the badge makes, asserted against it rather than restated.
  assert.equal(Turn.waiting(theirs, AGENT), true);
  assert.equal(Turn.waiting(mine, AGENT), false);
});

test('a pending suggestion and a flag are always full; a decided suggestion is not', () => {
  assert.equal(Turn.startCollapsed(sug('s1', 'pending'), AGENT, 'compact'), false, 'only the human can decide it');
  assert.equal(Turn.startCollapsed(sug('s2', 'accepted'), AGENT, 'compact'), true, 'decided, so it is a record');
  assert.equal(Turn.startCollapsed(sug('s3', 'rejected'), AGENT, 'compact'), true);
  // A flag is the one item written to be looked at, whoever spoke last on it.
  const flag = { ...comment('f1', 'open', msg(HUMAN, 'look here')), flag: true };
  assert.equal(Turn.startCollapsed(flag, AGENT, 'compact'), false);
});

test('an orphan stays full, which is the whole point of the -1 rank', () => {
  // index.html floats an orphaned card to the top of the rail so a broken anchor is seen. Folding it to
  // a pill in the same breath would undo that, so the orphan is the one live card the density leaves
  // alone whoever spoke last on it.
  assert.equal(Turn.startCollapsed(comment('c1', 'orphaned', msg(HUMAN, 'said my piece')), AGENT, 'compact'), false);
  assert.equal(Turn.startCollapsed(sug('s1', 'orphaned'), AGENT, 'compact'), false);
});

test('everything settled rests collapsed, which is every card on the archived tab', () => {
  for (const st of ['resolved', 'accepted', 'rejected']) {
    assert.equal(Turn.startCollapsed(comment('c1', st, msg(AGENT, 'x')), AGENT, 'compact'), true, st);
    assert.ok(!Turn.isLive({ status: st }), st + ' is not live');
  }
});

test('the rail at compact folds exactly the cards the badge does not count', () => {
  // Wired end to end over one review rather than asserted per item: what stays full is what `Turn.of`
  // reports as the human's turn, plus the two the rule adds by hand (a flag, an orphan).
  const review = { schema: 1, items: [
    comment('c1', 'open', msg(AGENT, 'unanswered')),              // claude's move on the human → full
    comment('c2', 'open', msg(AGENT, 'q'), msg(HUMAN, 'a')),      // the human answered → collapsed
    sug('s1', 'pending'),                                          // awaiting accept/reject → full
    comment('c3', 'resolved', msg(AGENT, 'settled')),              // archived → collapsed
  ] };
  const full = review.items.filter(it => !Turn.startCollapsed(it, AGENT, 'compact')).map(i => i.id);
  const badged = Turn.of(review, AGENT).items.filter(i => i.turn).map(i => i.id);
  assert.deepEqual(full, ['c1', 's1']);
  assert.deepEqual(full, badged, 'the two answers are the one rule');
});

test('the collapsed pill previews the last line said, and never an empty one', () => {
  assert.equal(Turn.peek(comment('c1', 'open', msg(AGENT, 'first'), msg(HUMAN, 'last word'))), 'last word');
  // Multi-line bodies are common (an agent writes markdown); the pill gets the first line with content.
  assert.equal(Turn.peek(comment('c2', 'open', msg(AGENT, '\n\n  the heading\nand the body'))), 'the heading');
  // A suggestion nobody has replied to has no message at all: its note, then the span it is about.
  assert.equal(Turn.peek({ ...sug('s1', 'pending'), note: 'tighter' }), 'tighter');
  assert.equal(Turn.peek(sug('s2', 'pending')), 'the s2 span');
  // And it is cut to the same length a quote is, so one pill cannot be a paragraph.
  const long = Turn.peek(comment('c3', 'open', msg(AGENT, 'x'.repeat(400))));
  assert.equal(long.length, Turn.QUOTE_MAX);
  assert.ok(long.endsWith('…'));
});

// ---------- a long thread folds in its middle (Turn.foldThread) ----------
// The card-level clip is a pixel cap and cuts the END off a conversation, which is the half being read.
// This takes the middle instead: the opening comment, a row, and the last two replies.

const thread = (n) => Array.from({ length: n }, (_, i) => msg(i % 2 ? HUMAN : AGENT, 'message ' + i));

test('a thread of four or fewer draws whole', () => {
  for (let n = 0; n <= 4; n++) {
    const all = thread(n);
    const f = Turn.foldThread(all, false);
    assert.deepEqual(f.head, all, `${n} messages`);
    assert.equal(f.hiddenCount, 0);
    assert.deepEqual(f.tail, []);
    assert.equal(f.foldable, false, 'and there is no row to draw');
  }
  // Nothing at all is the same answer, since a card can carry a thread the file never wrote.
  assert.deepEqual(Turn.foldThread(null, false), { head: [], hiddenCount: 0, tail: [], foldable: false });
});

test('a thread of five folds to the opener, a row for two, and the last two', () => {
  const all = thread(5);
  const f = Turn.foldThread(all, false);
  assert.deepEqual(f.head.map(m => m.text), ['message 0']);
  assert.equal(f.hiddenCount, 2);
  assert.deepEqual(f.tail.map(m => m.text), ['message 3', 'message 4']);
  // Five is the shortest thread that folds, so two is the fewest it ever hides: a row standing in for
  // one message costs a row and saves a row.
  assert.ok(f.hiddenCount >= 2, 'the fold never trades a row for a row');
});

test('the fold keeps its shape as the thread grows, so only the count moves', () => {
  for (const n of [6, 10, 40]) {
    const all = thread(n);
    const f = Turn.foldThread(all, false);
    assert.equal(f.head.length, Turn.THREAD_HEAD, `${n}: one opener`);
    assert.equal(f.tail.length, Turn.THREAD_TAIL, `${n}: two replies`);
    assert.equal(f.hiddenCount, n - 3, `${n}: and the row names the rest`);
    assert.equal(f.head.length + f.hiddenCount + f.tail.length, n, `${n}: nothing is lost`);
    // The newest is always drawn, and so is the one before it: the newest is usually an answer and its
    // predecessor is the question it answers.
    assert.deepEqual(f.tail.map(m => m.text), [`message ${n - 2}`, `message ${n - 1}`]);
  }
});

test('an expanded thread draws whole and still carries the row that folds it back', () => {
  const all = thread(9);
  const f = Turn.foldThread(all, true);
  assert.deepEqual(f.head.concat(f.tail), all, 'every message, none of them hidden');
  assert.equal(f.hiddenCount, 0, 'so the row says `fold` rather than a count');
  assert.equal(f.foldable, true, 'and the row is still drawn, which is the only way back');
  // The row sits between head and tail in both states, so it holds its place in the thread when the
  // fold opens: the label changes under the pointer instead of the control moving.
  assert.equal(f.head.length, Turn.THREAD_HEAD, 'and it is still after the opening comment');
  assert.deepEqual(f.head.map(m => m.text), Turn.foldThread(all, false).head.map(m => m.text));
  // A short thread expanded is a short thread: there is nothing to fold back to.
  assert.equal(Turn.foldThread(thread(3), true).foldable, false);
});

test('folding reads the thread and never writes it', () => {
  const all = thread(7);
  const before = JSON.stringify(all);
  const f = Turn.foldThread(all, false);
  f.head.push(msg(AGENT, 'not yours'));
  assert.equal(JSON.stringify(all), before, 'the caller keeps its array');
  assert.equal(all.length, 7);
});

// ---------- what the page shows at rest (public/index.html) ----------
// Asserted against the file the same way the sandbox flag is: these are single literal strings whose
// absence IS the feature, and each one was on screen on a clean document before anybody acted.

test('the page carries no permanent presence label and no empty-rail sentence', () => {
  const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  // The readout is empty unless an agent is watching, working or replying.
  assert.doesNotMatch(page, /waiting for claude/, 'no "waiting for claude" anywhere');
  assert.doesNotMatch(page, /'sent to claude'/, 'and no permanent handoff label in the header');
  assert.doesNotMatch(page, /no active threads/, 'an empty active list draws nothing');
  // The hover pop is opt-in on the decisions, so nothing is left switching it back off.
  assert.doesNotMatch(page, /button:hover \{ transform:scale/, 'the global hover pop is gone');
  assert.match(page, /\.pop:hover:not\(:active\) \{ transform:scale\(1\.02\); \}/,
    'and lands on .pop instead, yielding to the press so a held button compresses');
  const undo = page.split('\n').filter(l => /:hover/.test(l) && /transform:none/.test(l)).map(l => l.trim());
  assert.deepEqual(undo, ['button:active, .pop:hover:not(:active) { transform:none; }'],
    'the only hover rule cancelling a transform is the reduced-motion one');
  // The press scale and its spring stay: they are what a button owes the finger.
  assert.match(page, /button:active \{ transform:scale\(\.96\)/, 'the press scale survives');
  assert.match(page, /--spring-press:/, 'and so does the spring token');
});

// ---------- which links open IN sidecar (public/doclink.js) ----------
// The SAME file index.html loads via <script>. Three callers ask it the question — the document's two
// click handlers and the asset frame's pick — so every case below is a case all three follow.
const DocLink = require('./public/doclink.js');
const cliAllow = require('./lib/cli.js');
const BRIEF = 'vault/projects/ccdc-portal/brief.md';

test('a relative link to a sibling document opens in sidecar, however it is written', () => {
  for (const href of ['market-research.md', './market-research.md', './/market-research.md',
                      'sub/../market-research.md']) {
    assert.deepEqual(DocLink.route(href, BRIEF),
      { rel: 'vault/projects/ccdc-portal/market-research.md', hash: '' }, href);
  }
  assert.deepEqual(DocLink.route('slices/slice1.md', BRIEF),
    { rel: 'vault/projects/ccdc-portal/slices/slice1.md', hash: '' }, 'and one a folder down');
  assert.deepEqual(DocLink.route('../grant-developer/brief.md', BRIEF),
    { rel: 'vault/projects/grant-developer/brief.md', hash: '' }, 'and one a folder up');
});

test('an .html asset is a document too, and both extension lists are the CLI\'s', () => {
  assert.deepEqual(DocLink.route('./poster.html', BRIEF),
    { rel: 'vault/projects/ccdc-portal/poster.html', hash: '' });
  assert.deepEqual(DocLink.route('./NOTES.MD', BRIEF),
    { rel: 'vault/projects/ccdc-portal/NOTES.MD', hash: '' }, 'the extension is matched case-blind');
  // lib/cli.js cannot be require'd from a browser, so this file carries its own copy of the two
  // allowlists. A document kind the CLI reviews and this one does not know about is a link that
  // reloads the whole page instead of switching in place.
  assert.deepEqual(DocLink.MARKDOWN, cliAllow.MARKDOWN);
  assert.deepEqual(DocLink.ASSETS, cliAllow.ASSETS);
});

test('a link that is not a document in this root is left exactly as it is', () => {
  const native = [
    'https://example.com/doc.md', 'http://other.host/x.md',   // another host
    'mailto:alex@example.com', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/x.md',
    '//example.com/x.md',                                     // protocol-relative
    '/absolute/x.md', '/?f=other.md',                         // a URL on this origin, not a path in the root
    '#a-heading', '#',                                        // an anchor within this document
    'notes.txt', 'script.js', 'photo.png', 'README',          // not a kind sidecar reviews
    'folder/', '', '   ', './',
    '../../../../../../etc/passwd.md',                        // out of the served root
    'research.md?raw=1',                                      // a query is not part of any path in the root
  ];
  for (const href of native) assert.equal(DocLink.route(href, BRIEF), null, JSON.stringify(href));
});

test('climbing out of the served root is refused, and climbing back in is not', () => {
  // The root is implicit: every path is relative to it, so a link that runs out of segments to pop has
  // walked out of everything sidecar serves. The server would refuse it (safePath) and the page must
  // not ask.
  assert.equal(DocLink.route('../../../../other.md', BRIEF), null);
  assert.equal(DocLink.route('../x.md', 'top.md'), null, 'a document at the root has nowhere above it');
  assert.deepEqual(DocLink.route('./x.md', 'top.md'), { rel: 'x.md', hash: '' });
  assert.deepEqual(DocLink.route('../../people/alex.md', BRIEF),
    { rel: 'vault/people/alex.md', hash: '' }, 'two up and along is still inside');
});

test('a fragment rides along, and a fragment alone is an anchor in this document', () => {
  assert.deepEqual(DocLink.route('./market-research.md#the-bet', BRIEF),
    { rel: 'vault/projects/ccdc-portal/market-research.md', hash: 'the-bet' });
  assert.equal(DocLink.route('#the-bet', BRIEF), null, 'same document: the browser already does this');
});

test('a written link is percent-encoded and a path on disk is not', () => {
  assert.deepEqual(DocLink.route('./market%20research.md', BRIEF),
    { rel: 'vault/projects/ccdc-portal/market research.md', hash: '' });
  assert.equal(DocLink.route('./%E0%A4%A.md', BRIEF), null, 'and a malformed escape is left alone');
});

test('a link to the open document itself still resolves to it', () => {
  // openDoc no-ops on the document already showing, so the answer here is "yes, that one" rather than
  // a special case this file has to know about.
  assert.deepEqual(DocLink.route('./brief.md', BRIEF), { rel: BRIEF, hash: '' });
});

// ---------- anchor stability while an agent edits (public/stability.js) ----------
// The SAME file index.html loads via <script>. Everything here is a pure function of arguments plus
// recorded state, with the clock passed in, so the whole edit → orphan → reanchor sequence can be run
// in milliseconds. The scenario throughout: a human is reading a card, an agent rewrites the sentence
// it is anchored to, and `sidecar reanchor` follows a few seconds later.
const Stability = require('./public/stability.js');
const GRACE = Stability.GRACE_MS;

test('a card that was live holds its normal face until the grace window expires', () => {
  const s = Stability.create();
  let t = 1000;
  s.observe('c1', true, t);                                  // the anchor matched on load
  t += 500;
  s.observe('c1', false, t);                                 // the agent rewrote the sentence
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t), false, 'not the instant it breaks');
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + GRACE - 1), false, 'nor a millisecond early');
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + GRACE), true, 'and then it admits it');
});

test('a reanchor inside the window means the card never flips at all', () => {
  const s = Stability.create();
  let t = 1000;
  s.observe('c1', true, t);
  s.observe('c1', false, t + 100);                           // edit lands
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + 3000), false);
  s.observe('c1', true, t + 3500);                           // `sidecar reanchor` lands
  assert.equal(s.showOrphaned('c1', false, undefined, t + 3600), false, 'and the file agrees');
  // The clock is reset by the match, so a LATER break gets a full window of its own rather than the
  // remains of the first one.
  s.observe('c1', false, t + 4000);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + 4000 + GRACE - 1), false);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', t + 4000 + GRACE), true);
});

test('never-matched and element-changed skip the window, for opposite reasons', () => {
  const s = Stability.create();
  s.observe('bad', true, 1000);                              // even with a live observation behind it
  s.observe('bad', false, 1100);
  // A bad anchor from birth: there is nothing to protect and the whole point of surfacing it is that
  // somebody has to fix it.
  assert.equal(s.showOrphaned('bad', true, 'never-matched', 1100), true);
  // An element anchor: the browser picker has a DOM and has already done its own deferring.
  assert.equal(s.showOrphaned('bad', true, 'element-changed', 1100), true);
  assert.deepEqual(Stability.IMMEDIATE, ['never-matched', 'element-changed']);
});

test('a cold load of an already-orphaned item shows it at once', () => {
  // Nothing was ever remembered about it, so there is no "last position" to hold it at and no reason to
  // pretend it is fine. This is the pre-existing behaviour, and it is the default.
  const s = Stability.create();
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000), true, 'never observed at all');
  s.observe('c1', false, 1000);                              // observed, and it has never matched
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000), true);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000 + GRACE * 10), true);
});

test('the file calling it orphaned while our own matcher still finds it is not a flash', () => {
  // The two can disagree for a moment in either direction: the review file and the document arrive as
  // two separate fs events. The card follows what the page can see.
  const s = Stability.create();
  s.observe('c1', true, 1000);
  assert.equal(s.showOrphaned('c1', true, 'text-changed', 1000), false);
  assert.equal(s.showOrphaned('c1', false, undefined, 1000), false, 'and a live item is never orphaned');
});

test('one timer ends the window, armed at the earliest card that needs it', () => {
  // Nothing re-renders once the file stops changing, so without this a grace that expires between
  // events would leave a card open forever on a dead anchor.
  const s = Stability.create();
  assert.equal(s.nextFlip(1000), null, 'nothing pending, no timer');
  s.observe('a', true, 1000); s.observe('b', true, 1000);
  s.observe('a', false, 2000);
  s.observe('b', false, 3000);
  assert.equal(s.nextFlip(3000), GRACE - 1000, 'the earlier break is the one that decides');
  s.observe('a', true, 4000);
  assert.equal(s.nextFlip(4000), GRACE - 1000, 'a repaired anchor drops out of the reckoning');
  // A window that has already expired is NOT pending. Reporting 0 for one asks for an immediate
  // render, the record survives it (the anchor is still broken), and the next arm asks again: a card
  // nobody repairs spins the rail for as long as the tab is open. Live testing found exactly that.
  assert.equal(s.nextFlip(3000 + GRACE), null, 'a card that has already flipped wants no more timers');
  s.observe('a', false, 3000 + GRACE);
  assert.equal(s.nextFlip(3000 + GRACE), GRACE, 'and a fresh break still gets its own');
});

test('a text-changed orphan keeps the rank and the pixel it last held', () => {
  const s = Stability.create();
  s.noteRank('c1', 4200); s.noteTop('c1', 318);              // where it docked while its anchor matched
  // The anchor stops matching: docRank hands over -1 and dockCards has no mark to measure.
  assert.equal(s.rankFor('c1', -1, 'text-changed'), 4200, 'it does not float to the top');
  assert.equal(s.topFor('c1', null, 'text-changed'), 318, 'it does not take the next free slot');
  // A live mark always wins: the reanchor lands and the card goes where the document says.
  assert.equal(s.rankFor('c1', 9100, 'text-changed'), 9100);
  assert.equal(s.topFor('c1', 640, null), 640);
});

test('a never-matched anchor still floats to the top of the rail', () => {
  const s = Stability.create();
  s.noteRank('c1', 4200); s.noteTop('c1', 318);
  assert.equal(s.rankFor('c1', -1, 'never-matched'), -1);
  assert.equal(s.topFor('c1', null, 'never-matched'), null, 'null → dockCards gives it the next slot');
  assert.equal(s.rankFor('c1', -1, 'element-changed'), -1, 'and so does an element that is gone');
});

test('an item with nothing remembered behaves exactly as it always did', () => {
  const s = Stability.create();
  assert.equal(s.rankFor('c1', -1, 'text-changed'), -1);
  assert.equal(s.topFor('c1', null, 'text-changed'), null);
  s.noteRank('c1', -1); s.noteTop('c1', null);               // a non-position is not a memory
  assert.equal(s.rankFor('c1', -1, 'text-changed'), -1);
  assert.equal(s.topFor('c1', null, 'text-changed'), null);
});

test('a frozen card outranks the document itself, and releasing hands it back', () => {
  const s = Stability.create();
  s.noteRank('c1', 4200); s.noteTop('c1', 318);
  s.pin('c1', 318, 4200);                                    // the caret entered its reply box
  assert.equal(s.isPinned('c1'), true);
  assert.equal(s.pinnedTop('c1'), 318);
  // Everything the document could say while a reply is being typed: the anchor moved, the anchor died,
  // the anchor came back somewhere else. The card does not move for any of it.
  assert.equal(s.topFor('c1', 950, null), 318, 'not even for a live mark somewhere else');
  assert.equal(s.rankFor('c1', 9100, null), 4200);
  assert.equal(s.topFor('c1', null, 'text-changed'), 318);
  assert.equal(s.rankFor('c1', -1, 'never-matched'), 4200, 'nor for the float-to-top rule');
  // Pinning is idempotent: syncFreeze runs on every dock, and a second pin would re-baseline the card
  // to wherever it had drifted instead of holding the position the caret arrived on.
  s.pin('c1', 999, 8888);
  assert.equal(s.pinnedTop('c1'), 318);
  s.unpin('c1');
  assert.equal(s.topFor('c1', 950, null), 950, 'blurred and empty: the document has it back');
});

test('a pin with no rank behind it falls back to the last one, then to the top', () => {
  const s = Stability.create();
  s.noteRank('c1', 77);
  assert.equal(s.pin('c1', 100).rank, 77);
  const s2 = Stability.create();
  assert.equal(s2.pin('fresh', 100).rank, -1, 'a card that has never ranked pins where it is, at the top');
});

test('the position memory is evicted with the item and cleared with the document', () => {
  const s = Stability.create();
  for (const id of ['a', 'b', 'c']) { s.observe(id, true, 1000); s.noteRank(id, 10); s.noteTop(id, 20); }
  s.keep(['a', 'c']);                                        // b was resolved, so it leaves the rail
  assert.equal(s.size(), 2);
  assert.equal(s.rankFor('b', -1, 'text-changed'), -1, 'and takes its remembered position with it');
  assert.equal(s.rankFor('a', -1, 'text-changed'), 10, 'while the survivors keep theirs');
  // The document swap. A position measured in one document says nothing true about the next one, which
  // is why resetDocState calls this.
  s.reset();
  assert.equal(s.size(), 0);
  assert.equal(s.showOrphaned('a', true, 'text-changed', 1000), true, 'a cold rail again');
});

test('the page loads the stability module from the server, not a copy of it', async () => {
  // Same contract as the other shared modules: one file, loaded by the browser and required by these
  // tests, so the rules cannot drift into two versions.
  const served = await fetchRetry(`${BASE}/`).then(r => r.text());
  assert.match(served, /<script src="\/stability\.js">/, 'the page asks for it');
  const js = await fetchRetry(`${BASE}/stability.js`);
  assert.equal(js.status, 200, 'and the server hands it over');
  assert.match(await js.text(), /GRACE_MS/);
});

test('showOrphaned records nothing, so a card that is never docked is never evicted', () => {
  // A nested reply-suggestion renders inside its parent's thread: it is never ranked and never docked,
  // so it is never observed. Asking about it must not create a record that keep() would then evict,
  // which would make the answer depend on how recently the rail happened to render.
  const s = Stability.create();
  assert.equal(s.showOrphaned('nested', true, 'text-changed', 1000), true);
  assert.equal(s.size(), 0);
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
  const it = JSON.parse(fs.readFileSync(path.join(d, 'f.md.sidecar.json'), 'utf8')).items[0];
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
   IMAGES IN COMMENTS — a pasted screenshot becomes a file in `<doc>.sidecar.assets/`
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
  assert.match(out.src, /^doc\.md\.sidecar\.assets\/[0-9a-f]{12}\.png$/);
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
  const files = fs.readdirSync(path.join(dir, 'doc.md.sidecar.assets'));
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
  // Without the existence check this would create `<anything>.sidecar.assets/` anywhere under the root.
  const r = await postBytes('/api/asset?doc=nope.md', PNG_1x1);
  assert.equal(r.status, 404);
  assert.ok(!fs.existsSync(path.join(dir, 'nope.md.sidecar.assets')), 'no directory created for a doc that is not there');
  const esc = await postBytes(`/api/asset?doc=${encodeURIComponent('../../../../tmp/evil.md')}`, PNG_1x1);
  assert.equal(esc.status, 403);
});

test('an image in a comment body survives the review round-trip as a path, never as bytes', async () => {
  const up = await (await postBytes('/api/asset?doc=doc.md', PNG_1x1)).json();
  const s = await state();
  s.review.items.push({ id: 'cimg1', kind: 'comment', by: 'you', anchor: { quote: 'Closing paragraph.' },
    status: 'open', thread: [{ by: 'you', at: new Date().toISOString(), text: `look:\n\n${up.markdown}` }] });
  await put('/api/review', { path: 'doc.md', review: s.review });
  const raw = fs.readFileSync(path.join(dir, 'doc.md.sidecar.json'), 'utf8');
  assert.match(raw, /doc\.md\.sidecar\.assets\//);
  assert.doesNotMatch(raw, /base64|data:image/, 'the sidecar stays a small text file');
});

test('CLI --image copies the file in and appends a markdown link to the comment', () => {
  const d = cliDir();
  fs.writeFileSync(path.join(d, 'shot.png'), PNG_1x1);
  cli(d, 'comment', 'doc.md', '--quote', 'Success metrics are not defined yet.', '--text', 'see this', '--image', 'shot.png');
  const review = JSON.parse(fs.readFileSync(path.join(d, 'doc.md.sidecar.json'), 'utf8'));
  const body = review.items[0].thread[0].text;
  assert.match(body, /^see this\n\n!\[\]\(doc\.md\.sidecar\.assets\/[0-9a-f]{12}\.png\)$/);
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
  const review = JSON.parse(fs.readFileSync(path.join(d, 'doc.md.sidecar.json'), 'utf8'));
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

/* ────────────────────────────────────────────────────────────────────────────
   ASSETS — an .html file reviewed as a rendered visual (1.7.0). A second
   document kind, and with it a second anchor kind: an item pins to an ELEMENT
   instead of to quoted text. The sandboxed frame that renders one arrives in
   phase 3; what is covered here is the store, the CLI, and the Node-side
   resolution rule that decides whether an element anchor is still live.
   ──────────────────────────────────────────────────────────────────────────── */

const Element = require('./lib/element.js');

const POSTER = `<!doctype html>
<html>
<head><style>h1 { font-size: 64px }</style></head>
<body>
  <main class="wrap">
    <h1 data-sc="headline">Train your own image gen model</h1>
    <p id="sub">Ten minutes, no GPU required.</p>
    <a data-sc='cta' href="/start">Get started</a>
    <img data-sc="shot" src="./pic.svg">
    <footer>© 2026 spktr</footer>
  </main>
</body>
</html>
`;

// An empty repo, not a committed one: `show` shells out to `git diff` and a temp dir that happens to
// sit inside someone's checkout would otherwise report that repo's changes.
function assetDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-asset-'));
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER);
  fs.writeFileSync(path.join(d, 'doc.md'), CLI_DOC);
  execSync('git init -q', { cwd: d });
  return d;
}
const scAt = (d, name) => JSON.parse(fs.readFileSync(path.join(d, name + '.sidecar.json'), 'utf8'));

// ---------- the document kind, at the server's door ----------

test('/api/state classifies the document and refuses anything in neither allowlist', async () => {
  fs.writeFileSync(path.join(dir, 'poster.html'), POSTER);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a document\n');
  const asset = await fetchRetry(`${BASE}/api/state?path=poster.html`).then(j);
  assert.equal(asset.kind, 'asset');
  assert.equal(asset.markdown, POSTER, 'an asset arrives as its raw HTML');
  const md = await state();
  assert.equal(md.kind, 'markdown');
  // The seam this closes: `?f=notes.txt` loaded unguarded and rendered through the markdown path.
  const r = await fetchRetry(`${BASE}/api/state?path=notes.txt`);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /markdown and html assets/);
});

test('save and format refuse an asset — it is read-only in the viewer', async () => {
  const before = fs.readFileSync(path.join(dir, 'poster.html'), 'utf8');
  const saved = await put('/api/save', { path: 'poster.html', content: '<h1>rewritten</h1>' });
  assert.equal(saved.status, 400);
  assert.match((await saved.json()).error, /read-only/);
  const formatted = await post('/api/format', { path: 'poster.html', quote: 'Get started', op: 'bold' });
  assert.equal(formatted.status, 400);
  assert.equal(fs.readFileSync(path.join(dir, 'poster.html'), 'utf8'), before, 'the file is untouched');
});

test('the file picker walk lists assets beside markdown', async () => {
  const { files } = await fetchRetry(`${BASE}/api/files`).then(j);
  const rels = files.map(f => f.rel);
  assert.ok(rels.includes('poster.html'), 'the asset is offered for review');
  assert.ok(rels.includes('doc.md'), 'markdown still is');
  assert.ok(!rels.includes('notes.txt'), 'and a file in neither allowlist is not');
});

test('the directory listing is one folder of documents: no recursion, no directories, no non-documents', async () => {
  fs.mkdirSync(path.join(dir, 'folder', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'folder', 'summary.md'), '# summary\n');
  fs.writeFileSync(path.join(dir, 'folder', 'card.html'), '<h1>card</h1>');
  fs.writeFileSync(path.join(dir, 'folder', 'notes.txt'), 'not a document');
  fs.writeFileSync(path.join(dir, 'folder', '.hidden.md'), '# hidden\n');
  fs.writeFileSync(path.join(dir, 'folder', 'deeper', 'buried.md'), '# buried\n');
  const d = await fetchRetry(`${BASE}/api/dir?path=folder`).then(j);
  assert.deepEqual(d.docs.map(x => x.name).sort(), ['card.html', 'summary.md']);
  assert.ok(d.docs.every(x => typeof x.mtime === 'number' && x.mtime > 0), 'each carries an mtime to sort by');
  assert.equal(d.docs[0].rel.startsWith('folder/'), true, 'rel is relative to the served root');
  assert.equal(d.dir, 'folder');
  assert.equal(d.parent, '', 'the parent of a top-level folder is the root itself');
});

test('the directory listing at the served root has no parent to walk up to', async () => {
  const d = await fetchRetry(`${BASE}/api/dir?path=`).then(j);
  assert.equal(d.dir, '');
  assert.equal(d.parent, null, 'null, not a path outside the root');
  assert.ok(d.docs.some(x => x.name === 'doc.md'));
  assert.ok(!d.docs.some(x => x.name === 'folder'), 'a directory is not a document');
});

test('the directory listing carries each document\'s turn count and its open count', async () => {
  // The badge's data path end to end: a review on disk → /api/dir → what the panel draws. The counting
  // is public/turn.js, asserted directly above; this is that the server runs it, per document, per
  // folder, and hands back the two counts the rows badge.
  const folder = path.join(dir, 'badges');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'brief.md'), '# brief\n\nA sentence to anchor to.\n');
  fs.writeFileSync(path.join(folder, 'quiet.md'), '# quiet\n\nNothing open here.\n');
  fs.writeFileSync(path.join(folder, 'brief.md.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'claude', anchor: { quote: 'A sentence' }, status: 'open',
      thread: [{ by: 'claude', at: '2026-08-15T10:00:00Z', text: 'asking' }] },
    { id: 'c2', kind: 'comment', by: 'alex', anchor: { quote: 'to anchor to' }, status: 'open',
      thread: [{ by: 'alex', at: '2026-08-15T11:00:00Z', text: 'over to you' }] },
    { id: 's1', kind: 'suggestion', by: 'claude', anchor: { quote: 'sentence' }, replacement: 'line', status: 'pending' },
    { id: 'c3', kind: 'comment', by: 'alex', anchor: { quote: 'brief' }, status: 'resolved',
      thread: [{ by: 'alex', at: '2026-08-15T09:00:00Z', text: 'done' }] },
  ] }));
  const d = await fetchRetry(`${BASE}/api/dir?path=badges`).then(j);
  const brief = d.docs.find(x => x.name === 'brief.md'), quiet = d.docs.find(x => x.name === 'quiet.md');
  assert.equal(brief.turn, 2, 'the agent-last comment and the pending suggestion');
  assert.equal(brief.open, 3, 'the human-last one is open too');
  assert.equal(brief.items, undefined, 'counts only: the items themselves stay in the sidecar');
  assert.equal(quiet.turn, 0, 'a document with no sidecar at all');
  assert.equal(quiet.open, 0);
});

test('a legacy or unreadable sidecar is zero badges, and the rest of the folder still lists', async () => {
  // The renamed-file case (pre-1.7 `.review.json`) and the crashed-write case, which must not take the
  // listing down with them. The panel counts only; migrating on a listing nobody asked to migrate would
  // rename a whole folder's siblings as a side effect of scrolling past it.
  const folder = path.join(dir, 'legacy');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'old.md'), '# old\n\nStill here.\n');
  fs.writeFileSync(path.join(folder, 'old.md.review.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c1', kind: 'comment', by: 'claude', anchor: { quote: 'Still here' }, status: 'open',
      thread: [{ by: 'claude', at: '2026-08-15T10:00:00Z', text: 'from before the rename' }] },
  ] }));
  fs.writeFileSync(path.join(folder, 'broken.md'), '# broken\n');
  fs.writeFileSync(path.join(folder, 'broken.md.sidecar.json'), '{"schema":1,"items":[{"id":"c1"');
  fs.writeFileSync(path.join(folder, 'fine.md'), '# fine\n');
  const d = await fetchRetry(`${BASE}/api/dir?path=legacy`).then(j);
  assert.deepEqual(d.docs.map(x => x.name).sort(), ['broken.md', 'fine.md', 'old.md'],
    'every document still lists');
  for (const x of d.docs) { assert.equal(x.turn, 0, x.name); assert.equal(x.open, 0, x.name); }
  assert.ok(fs.existsSync(path.join(folder, 'old.md.review.json')), 'and the listing renamed nothing');
});

test('the directory listing is confined to the served root, and refuses a file', async () => {
  const escaped = await fetchRetry(`${BASE}/api/dir?path=../..`);
  assert.equal(escaped.status, 400);
  assert.match((await escaped.json()).error, /escapes root/);
  const notADir = await fetchRetry(`${BASE}/api/dir?path=doc.md`);
  assert.equal(notADir.status, 404, 'a document is not a folder');
  const missing = await fetchRetry(`${BASE}/api/dir?path=nope`);
  assert.equal(missing.status, 404);
});

// A live /events subscription, resolved once the stream is open so a write made after it cannot slip
// through before the client is listening.
function sse(match, timeoutMs = 6000) {
  return new Promise((open) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/events', method: 'GET' }, (res) => {
      let buf = '';
      const got = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { req.destroy(); reject(new Error('no matching SSE event')); }, timeoutMs);
        res.on('data', (c) => {
          buf += c;
          for (const line of buf.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let d; try { d = JSON.parse(line.slice(6)); } catch { continue; }
            if (match(d)) { clearTimeout(timer); req.destroy(); resolve(d); }
          }
        });
      });
      open({ got });
    });
    req.on('error', () => {});
    req.end();
  });
}

test('the watcher fires on an asset, so an agent edit reloads the frame', async () => {
  const sub = await sse((e) => e.rel === 'watched.html');
  fs.writeFileSync(path.join(dir, 'watched.html'), POSTER);
  const ev = await sub.got;
  assert.equal(ev.rel, 'watched.html');
});

test('review PUT refuses an element sel that is not a plain name (the id guard, for the other anchor)', async () => {
  const r = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'cbad', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { sel: '[data-sc=x" onload=alert(1)]' }, quote: 'x' }, thread: [] }] } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /invalid element sel/);
});

// ---------- the Node-side resolution rule (lib/element.js) ----------

test('an element reference normalizes from all three forms an agent might type', () => {
  for (const ref of ['headline', '[data-sc=headline]', '[data-sc="headline"]', "[data-sc='headline']"])
    assert.equal(Element.parseRef(ref).sel, '[data-sc=headline]', `${ref} names the data-sc element`);
  assert.equal(Element.parseRef('#sub').sel, '#sub');
  // An id and a data-sc value that read alike are two different attributes, so the sel keeps them apart.
  assert.notEqual(Element.parseRef('#headline').sel, Element.parseRef('headline').sel);
  for (const bad of ['a b', '.cls', 'x"onload=1', '', '[class=x]'])
    assert.ok(Element.parseRef(bad).error, `${JSON.stringify(bad)} is refused`);
});

test('element liveness is textual in Node: the attribute, or the signature after tag-stripping', () => {
  assert.equal(Element.isLive(POSTER, { sel: '[data-sc=headline]' }), true, 'a double-quoted attribute');
  assert.equal(Element.isLive(POSTER, { sel: '[data-sc=cta]' }), true, 'a single-quoted one');
  assert.equal(Element.isLive(POSTER, { sel: '#sub' }), true, 'an id');
  assert.equal(Element.isLive('<h1 id=hero>x</h1>', { sel: '#hero' }), true, 'an unquoted one');
  assert.equal(Element.isLive('<h1 id=heroic>x</h1>', { sel: '#hero' }), false, 'and not a longer name that starts the same');
  assert.equal(Element.isLive('<p data-id="sub">x</p>', { sel: '#sub' }), false, 'nor a different attribute holding the value');
  assert.equal(Element.isLive('<p id="sub">x</p>', { sel: '[data-sc=sub]' }), false, 'an id is not a data-sc value');

  // The signature half: the attribute is gone, the content is not. Tags become spaces and the shared
  // matcher does the rest, so a signature spanning the source's line breaks still resolves.
  const relabelled = POSTER.replace('data-sc="headline"', 'class="big"');
  assert.equal(Element.isLive(relabelled, { sel: '[data-sc=headline]' }), false, 'attribute gone, no signature');
  assert.equal(Element.isLive(relabelled, { sel: '[data-sc=headline]', sig: 'Train your own image gen model' }), true);
  assert.equal(Element.isLive(relabelled, { sel: '[data-sc=headline]', sig: 'Train your own text model' }), false);
  const wrapped = '<div>\n  <h1 class="big">Train your own\n  image gen model</h1>\n</div>';
  assert.equal(Element.isLive(wrapped, { sel: '[data-sc=headline]', sig: 'Train your own image gen model' }), true,
    'the signature goes through public/anchor.js, so whitespace normalizes exactly as a quote does');
});

test('mergeItem backfills path and sig onto an element anchor without clobbering the rest', () => {
  const { mergeItem } = require('./lib/review.js');
  const stored = { id: 'c1', kind: 'comment', by: 'claude', status: 'open',
    anchor: { element: { sel: '[data-sc=headline]' }, quote: 'headline · Train your own image gen model' },
    thread: [{ by: 'claude', at: '2026-08-13T10:00:00Z', text: 'too long' }] };
  // What the picker sends once it has resolved the same element in a real DOM: the anchor alone.
  const merged = mergeItem(stored, { id: 'c1', anchor: { element: { path: 'main>h1', sig: 'Train your own image gen model' } } });
  assert.deepEqual(merged.anchor.element,
    { sel: '[data-sc=headline]', path: 'main>h1', sig: 'Train your own image gen model' });
  assert.equal(merged.anchor.quote, stored.anchor.quote, 'the synthesized quote every surface reads survives');
  assert.equal(merged.thread.length, 1);
  assert.equal(merged.status, 'open');
});

test('a text anchor still REPLACES on merge — reanchor must not inherit the old occurrence', () => {
  const { mergeItem } = require('./lib/review.js');
  const stored = { id: 'c1', kind: 'comment', status: 'open', anchor: { quote: 'old', occurrence: 3 }, thread: [] };
  const merged = mergeItem(stored, { id: 'c1', anchor: { quote: 'new' } });
  assert.deepEqual(merged.anchor, { quote: 'new' }, 'the element merge is scoped to element anchors');
});

// ---------- `sidecar elements` ----------

test('elements lists what an asset offers to anchor to: label, tag, and its text', () => {
  const d = assetDir();
  const out = cli(d, 'elements', 'poster.html');
  assert.match(out, /4 anchorable elements/);
  assert.match(out, /\[data-sc=headline\]\s+h1\s+Train your own image gen model/);
  assert.match(out, /#sub\s+p\s+Ten minutes, no GPU required\./);
  assert.match(out, /\[data-sc=cta\]\s+a\s+Get started/);
  assert.match(out, /\[data-sc=shot\]\s+img/, 'a void element is anchorable and simply has no text');
  assert.doesNotMatch(out, /footer/, 'an element carrying neither attribute is not anchorable');
  assert.match(out, /sidecar comment poster\.html --element headline/, 'and it names the command that uses one');
  fs.rmSync(d, { recursive: true, force: true });
});

test('elements is regex extraction, and these are its honest limits', () => {
  const d = assetDir();
  fs.writeFileSync(path.join(d, 'messy.html'), [
    '<!-- <div data-sc="commented">never rendered</div> -->',
    '<p data-sc="twin">first</p>',
    '<p data-sc="twin">second</p>',
    '<div data-sc="unclosed">open',
    '<p>the next paragraph</p>',
  ].join('\n'));
  const out = cli(d, 'elements', 'messy.html');
  // Nothing here knows what a comment is, so an attribute inside one is listed like any other.
  assert.match(out, /commented/);
  // Two elements sharing a label are both listed. The collision is real; hiding one would make
  // `elements` disagree with the file, and `check --element` says which way the frame will resolve it.
  assert.equal((out.match(/data-sc=twin/g) || []).length, 2);
  assert.match(cli(d, 'check', 'messy.html', '--element', 'twin'), /2 elements match .* not unique/);
  // A tag that never closes has no end to read to, so its snippet runs on into what follows.
  assert.match(out, /\[data-sc=unclosed\]\s+div\s+open the next paragraph/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('elements refuses a markdown document, and names the anchor kind that document does take', () => {
  const d = assetDir();
  const e = cliFails(d, 'elements', 'doc.md');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /is markdown/);
  assert.match(e.stderr, /--quote/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- comment / flag on an asset ----------

test('comment --element takes all three reference forms and stores one sel', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'bare data-sc value');
  cli(d, 'comment', 'poster.html', '--element', '[data-sc=cta]', '--text', 'selector form');
  cli(d, 'comment', 'poster.html', '--element', '#sub', '--text', 'id form');
  const sels = scAt(d, 'poster.html').items.map(i => i.anchor.element.sel);
  assert.deepEqual(sels, ['[data-sc=headline]', '[data-sc=cta]', '#sub']);
  const [first] = scAt(d, 'poster.html').items;
  assert.equal(first.anchor.quote, 'headline · Train your own image gen model',
    'the quote is synthesized from the label and the text, and is what every surface reads');
  assert.equal(first.anchor.element.path, undefined, 'path and sig stay absent until the picker resolves them');
  assert.equal(first.anchor.element.sig, undefined);
  assert.equal(first.status, 'open');
  assert.equal(first.kind, 'comment');
  fs.rmSync(d, { recursive: true, force: true });
});

test('flag works on an element too, and the anchor is validated before anything is written', () => {
  const d = assetDir();
  cli(d, 'flag', 'poster.html', '--element', 'cta', '--text', 'the link goes nowhere');
  assert.equal(scAt(d, 'poster.html').items[0].flag, true);
  const e = cliFails(d, 'comment', 'poster.html', '--element', 'ghost', '--text', 'x');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /no element \[data-sc=ghost\] in the file/);
  assert.match(e.stderr, /sidecar elements/, 'and it names the command that would have shown the real ones');
  assert.equal(scAt(d, 'poster.html').items.length, 1, 'nothing written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a sel that is not a plain name is refused at write time, as an item id is', () => {
  const d = assetDir();
  const e = cliFails(d, 'comment', 'poster.html', '--element', '[data-sc=a b]', '--text', 'x');
  assert.equal(e.status, 2);
  assert.match(e.stderr, /plain name/);
  assert.ok(!fs.existsSync(path.join(d, 'poster.html.sidecar.json')), 'no sidecar written');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the two cross-kind refusals: --quote on an asset, --element on markdown', () => {
  const d = assetDir();
  const onAsset = cliFails(d, 'comment', 'poster.html', '--quote', 'Get started', '--text', 'x');
  assert.equal(onAsset.status, 2);
  assert.match(onAsset.stderr, /is an asset/);
  assert.match(onAsset.stderr, /--element/);
  const onMarkdown = cliFails(d, 'comment', 'doc.md', '--element', 'headline', '--text', 'x');
  assert.equal(onMarkdown.status, 2);
  assert.match(onMarkdown.stderr, /is markdown/);
  assert.match(onMarkdown.stderr, /--quote/);
  assert.ok(!fs.existsSync(path.join(d, 'poster.html.sidecar.json')));
  assert.ok(!fs.existsSync(path.join(d, 'doc.md.sidecar.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('the verbs that rewrite the document refuse an asset outright', () => {
  const d = assetDir();
  for (const [verb, ...rest] of [['suggest', '--quote', 'Get started', '--replacement', 'x'],
                                 ['answer', 'c-nothing', '--replacement', 'x'],
                                 ['reanchor', 'c-nothing', '--quote', 'x']]) {
    const e = cliFails(d, verb, 'poster.html', ...rest);
    assert.equal(e.status, 2, `${verb} should refuse`);
    assert.match(e.stderr, /is an asset/);
    assert.match(e.stderr, /read-only/);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('add takes an element key, and refuses a suggestion anchored to one', () => {
  const d = assetDir();
  cliStdin(d, JSON.stringify([
    { element: 'headline', text: 'too long for one line' },
    { element: '#sub', text: 'is the GPU claim true?', flag: true },
  ]), 'add', 'poster.html');
  const items = scAt(d, 'poster.html').items;
  assert.deepEqual(items.map(i => i.anchor.element.sel), ['[data-sc=headline]', '#sub']);
  assert.equal(items[1].flag, true);
  // An accept splices raw bytes into the document, and an asset is read-only, so the pair cannot exist.
  const e = cliFailsStdin(d, JSON.stringify([{ element: 'headline', replacement: 'shorter' }]), 'add', 'poster.html');
  assert.match(e.stderr, /suggestion cannot anchor to an element/);
  assert.equal(scAt(d, 'poster.html').items.length, 2, 'nothing added');
  // And the cross-kind refusals reach `add` too, by the same one rule.
  assert.match(cliFailsStdin(d, JSON.stringify([{ quote: 'Get started', text: 'x' }]), 'add', 'poster.html').stderr, /is an asset/);
  assert.match(cliFailsStdin(d, JSON.stringify([{ element: 'headline', text: 'x' }]), 'add', 'doc.md').stderr, /is markdown/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- check, show, orphan, digest ----------

test('check --element pre-flights one element, and bare check lints the anchors already stored', () => {
  const d = assetDir();
  const ok = cli(d, 'check', 'poster.html', '--element', 'headline');
  assert.match(ok, /unambiguous, safe to anchor/);
  assert.match(ok, /<h1>\s+Train your own image gen model/);
  const miss = cliFails(d, 'check', 'poster.html', '--element', 'ghost');
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /no element \[data-sc=ghost\]/);
  // --quote and --element check different anchor kinds, so each is refused on the other's document.
  assert.match(cliFails(d, 'check', 'poster.html', '--quote', 'Get started').stderr, /is an asset/);
  assert.match(cliFails(d, 'check', 'doc.md', '--element', 'headline').stderr, /is markdown/);

  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'x');
  assert.match(cli(d, 'check', 'poster.html'), /ok {3}c-headline.*\[data-sc=headline\]/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('show prints an element item like any other, and says why one orphaned', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'cta', '--text', 'the link goes nowhere');
  const before = cli(d, 'show', 'poster.html');
  assert.match(before, /1 item/);
  assert.match(before, /comment {2}OPEN/);
  assert.match(before, /@ "cta · Get started"/);
  assert.match(before, /claude: the link goes nowhere/);

  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace("data-sc='cta'", 'class="btn"'));
  const after = cli(d, 'show', 'poster.html');
  assert.match(after, /ORPHANED/);
  assert.match(after, /\[the element is gone\]/);
  assert.equal(scAt(d, 'poster.html').items[0].orphanReason, 'element-changed');
  fs.rmSync(d, { recursive: true, force: true });
});

test('an element item orphans when its element goes, and revives when it comes back', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'too long');
  const id = scAt(d, 'poster.html').items[0].id;
  const gone = POSTER.replace('<h1 data-sc="headline">Train your own image gen model</h1>', '<h1>Something else</h1>');
  fs.writeFileSync(path.join(d, 'poster.html'), gone);
  cli(d, 'show', 'poster.html');
  assert.equal(scAt(d, 'poster.html').items[0].status, 'orphaned');
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER);
  cli(d, 'show', 'poster.html');
  const back = scAt(d, 'poster.html').items[0];
  assert.equal(back.id, id);
  assert.equal(back.status, 'open', 'revival works exactly as it does for a text anchor');
  assert.equal(back.orphanReason, undefined);
  assert.equal(back.orphanedAt, undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an element item rides the digest and the cursor untouched', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'too long');
  cli(d, 'digest', 'poster.html');
  assert.match(cli(d, 'digest', 'poster.html'), /nothing new/, 'the cursor advanced over an element item');

  // The human answers on the card, exactly as they would on a text anchor.
  const id = scAt(d, 'poster.html').items[0].id;
  const review = scAt(d, 'poster.html');
  review.items[0].thread.push({ by: 'you', at: '2026-08-13T12:00:00Z', text: 'shorten it to four words' });
  fs.writeFileSync(path.join(d, 'poster.html.sidecar.json'), JSON.stringify(review, null, 2));
  const reply = cli(d, 'digest', 'poster.html');
  assert.match(reply, /REPLY @ “headline · Train your own image gen model”: shorten it/);
  assert.match(cli(d, 'reply', 'poster.html', id, 'four words it is'), /updated /);

  // And an orphan reaches the digest with the reason the element rule gives it.
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace('data-sc="headline"', 'class="big"'));
  assert.match(cli(d, 'digest', 'poster.html'), /ORPHANED @ “headline · .*” \[the element is gone\]/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an asset keeps the same sibling files a markdown document does', () => {
  const d = assetDir();
  cli(d, 'comment', 'poster.html', '--element', 'headline', '--text', 'x');
  cli(d, 'digest', 'poster.html');
  for (const suffix of ['.sidecar.json', '.sidecar.seen.json', '.sidecar.seen.base.claude'])
    assert.ok(fs.existsSync(path.join(d, 'poster.html' + suffix)), `poster.html${suffix} is written`);
  fs.rmSync(d, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   THE ASSET FRAME (1.7.0, phase 3) — an asset renders in a sandboxed iframe
   whose srcdoc the client assembles. Two properties hold the isolation
   guarantee up (docs/adr/0001-asset-frame-isolation.md) and both are pinned
   here: the asset's own scripts never run, and the sandbox is exactly
   `allow-scripts`. Below that, the picker's pure half — candidates, paths,
   signatures, resolution — exercised through require(), the way the shared
   matcher already is.
   ──────────────────────────────────────────────────────────────────────────── */

const AssetFrame = require('./public/assetframe.js');
const Picker = require('./public/picker.js');

// A DOMPurify bound to a jsdom window, which is exactly what the page hands buildFrame (its own
// global). Same library, same version, same profile — so what the suite asserts about the srcdoc is
// what the browser assembles.
function purifier() {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>');
  return require('dompurify')(window);
}

// Everything an asset should NOT be able to smuggle into the frame, in one fixture.
const HOSTILE = `<!doctype html>
<html>
<head><style>@font-face { src: url(./face.woff2) } .b { background: url('shot.png') } .c { background: url(https://cdn.example.com/x.png) }</style></head>
<body onload="boom()">
  <h1 data-sc="hero" style="background:url(bg.jpg)" onclick="steal()">Headline</h1>
  <script>fetch('/api/state?path=doc.md')</script>
  <iframe src="./nested.html"></iframe><object data="./o.pdf"></object><embed src="./e.swf">
  <img src="./pic.png" srcset="small.png 1x, /abs.png 2x">
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <a href="./page.html">a link</a><a href="javascript:alert(1)">js</a>
</body>
</html>`;

test('the served page pins the asset frame to sandbox="allow-scripts", and never allow-same-origin', async () => {
  // Read the file AND what the server hands the browser, because the guarantee is about what actually
  // reaches the page. The flag set lives in markup rather than being assembled in code precisely so it
  // can be asserted as one literal string.
  const onDisk = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const served = await fetchRetry(`${BASE}/`).then(r => r.text());
  for (const [what, html] of [['on disk', onDisk], ['as served', served]]) {
    assert.match(html, /<iframe class="asset-frame" sandbox="allow-scripts"/, `the frame is sandboxed ${what}`);
    // The permanent one, from the spec's "not in this release": no flag, no option, no escape hatch.
    // With it the frame would share this origin, which carries the file read/write API.
    assert.doesNotMatch(html, /allow-same-origin/, `allow-same-origin appears nowhere ${what}`);
  }
});

test('the asset profile strips everything that executes and keeps everything that styles', () => {
  const out = AssetFrame.buildFrame({ html: HOSTILE, docRel: 'poster.html', purify: purifier(), picker: 'PICKER_SOURCE' });
  // The asset's own script is gone, and so is every handler and javascript: URL that would run without one.
  assert.doesNotMatch(out, /fetch\('\/api\/state/, 'the asset script is gone');
  assert.doesNotMatch(out, /onload=|onclick=/, 'inline handlers are gone');
  assert.doesNotMatch(out, /javascript:/, 'javascript: URLs are gone');
  // Another browsing context inside the frame is a second thing to reason about, so there is none.
  for (const tag of ['iframe', 'object', 'embed']) assert.ok(!out.includes('<' + tag), `<${tag}> is stripped`);
  // …and the half that differs from the markdown profile: an asset's styling IS the document.
  assert.match(out, /<style>/, '<style> survives');
  assert.match(out, /@font-face/, 'and its contents');
  assert.match(out, /<h1 data-sc="hero" style="background:url/, 'the inline style survives');
  // Exactly one script, and it is ours. This pairs with the sandbox flags above: neither is alone.
  assert.equal((out.match(/<script/g) || []).length, 1, 'one script tag');
  assert.match(out, /<script>PICKER_SOURCE<\/script>/);
  assert.match(out, /^<!doctype html>/, 'and a doctype, or the frame parses in quirks mode');
});

test('relative references are rewritten to /assets; absolute, protocol-relative and data: are not', () => {
  const out = AssetFrame.buildFrame({ html: HOSTILE, docRel: 'brand/poster.html', purify: purifier(), picker: '' });
  const at = (src) => '/assets?doc=' + encodeURIComponent('brand/poster.html') + '&src=' + encodeURIComponent(src);
  assert.ok(out.includes(at('./pic.png').replace(/&/g, '&amp;')), 'an <img src>');
  assert.ok(out.includes(at('small.png').replace(/&/g, '&amp;')), 'the first srcset candidate');
  assert.ok(out.includes('/abs.png 2x'), 'and an absolute one in the same srcset is left alone');
  assert.ok(out.includes(at('./face.woff2')), 'a url() in a <style> block');
  assert.ok(out.includes(at('shot.png')), 'a single-quoted one');
  assert.ok(out.includes('url(https://cdn.example.com/x.png)'), 'an absolute url() is untouched');
  assert.match(out, /src="data:image\/gif/, 'a data: URL is untouched');
  assert.match(out, /<a href="\.\/page\.html"/, 'and an <a href> is a destination, not a subresource — untouched');
});

test('the url() rewriter reaches every spelling of a CSS reference, and only the relative ones', () => {
  const css = AssetFrame.rewriteCss(
    `a{background:url(one.png)} b{background:url("two.png")} c{background:url( 'three.png' )}
     d{background:url(/abs.png)} e{background:url(//cdn/x.png)} f{background:url(data:image/gif;base64,AA)}`, 'p.html');
  for (const n of ['one.png', 'two.png', 'three.png'])
    assert.ok(css.includes('src=' + encodeURIComponent(n)), `${n} is rewritten`);
  assert.ok(css.includes('url(/abs.png)'), 'an absolute path is left alone');
  assert.ok(css.includes('url(//cdn/x.png)'), 'so is a protocol-relative one');
  assert.ok(css.includes('url(data:image/gif;base64,AA)'), 'and so is a data: URL');
});

test('buildFrame refuses a picker source that could close its own script tag', () => {
  // Script content serializes raw, so this sequence would end the tag and spill the rest into the
  // document as markup. It has never appeared in picker.js; the guard is what keeps it that way.
  assert.throws(() => AssetFrame.buildFrame({ html: '<p>x</p>', docRel: 'p.html', purify: purifier(),
    picker: 'var s = "</script><img onerror=alert(1)>"' }), /<\/script/);
});

test('the real picker.js inlines cleanly and boots only inside a frame', () => {
  const src = fs.readFileSync(path.join(__dirname, 'public', 'picker.js'), 'utf8');
  const out = AssetFrame.buildFrame({ html: '<p>x</p>', docRel: 'p.html', purify: purifier(), picker: src });
  assert.ok(out.includes('sidecar:'), 'the picker source made it into the srcdoc');
  assert.equal((out.match(/<script/g) || []).length, 1);
  // require()d, it must export and NOT touch a DOM — the Node tests below depend on that, and so does
  // a stray <script src="/picker.js"> in the page itself.
  assert.equal(typeof Picker.candidatesFor, 'function');
});

test('/assets serves the font types an asset needs, and still refuses anything unlisted', async () => {
  for (const name of ['face.woff2', 'face.woff', 'face.ttf', 'face.otf'])
    fs.writeFileSync(path.join(dir, name), 'not really a font');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: red }');
  const types = { 'face.woff2': 'font/woff2', 'face.woff': 'font/woff', 'face.ttf': 'font/ttf', 'face.otf': 'font/otf' };
  for (const name in types) {
    const r = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent('./' + name)}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers.get('content-type'), types[name]);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', 'the type stays pinned');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    // The frame is an opaque origin and a CSS font fetch is CORS-mode, so without this the poster
    // renders in a fallback face. Images need none of it, and do not get it.
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  }
  const img = await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent('./pic.svg')}`);
  assert.equal(img.headers.get('access-control-allow-origin'), null, 'an image is not opened up');
  for (const bad of ['./style.css', './doc.md', './server.js'])
    assert.equal((await fetchRetry(`${BASE}/assets?doc=doc.md&src=${encodeURIComponent(bad)}`)).status, 400, bad);
});

// ---------- the picker's pure half ----------

// A DOM to pick out of, built the way the frame's would be.
function pickerDom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('an asset reports the link a click would follow, from the element or from its ancestors', () => {
  // The frame never decides: it says what the href is and public/doclink.js, on the page's side of the
  // postMessage boundary, decides whether it names a document. An asset's <a href> survives the
  // sanitize profile unrewritten (only LINK/IMAGE/USE hrefs become /assets references), so what the
  // page routes is what the author wrote.
  const doc = pickerDom('<main><a href="./market-research.md"><span id="in">the research</span></a>'
    + '<a href="https://example.com"><em id="out">a site</em></a><p id="plain">no link</p></main>');
  assert.equal(Picker.linkHref(doc.querySelector('#in')), './market-research.md',
    'the link is found from the deepest element, which is what the outline lands on');
  assert.equal(Picker.linkHref(doc.querySelector('a')), './market-research.md');
  assert.equal(Picker.linkHref(doc.querySelector('#out')), 'https://example.com',
    'an outbound link is reported too; the page is what refuses it');
  assert.equal(Picker.linkHref(doc.querySelector('#plain')), '');
  assert.equal(Picker.linkHref(null), '');
  // And the two ends meet: what the frame reports of a sibling citation is what the page follows.
  assert.deepEqual(DocLink.route(Picker.linkHref(doc.querySelector('#in')), 'vault/projects/ccdc-portal/poster.html'),
    { rel: 'vault/projects/ccdc-portal/market-research.md', hash: '' });
  assert.equal(DocLink.route(Picker.linkHref(doc.querySelector('#out')), 'vault/projects/ccdc-portal/poster.html'), null,
    'and an outbound one stays an ordinary pick');
});

test('a pick offers its candidates best-first: data-sc, then id, then the structural path', () => {
  const doc = pickerDom('<main><h1 data-sc="hero" id="top">Train your own image gen model</h1>'
    + '<p id="sub">Ten minutes.</p><p>bare</p><p>also bare</p></main>');
  const both = Picker.candidatesFor(doc.querySelector('h1'));
  assert.deepEqual(both.map(c => c.sel), ['[data-sc=hero]', '#top', undefined],
    'data-sc outranks id, and the path is always the last resort');
  assert.equal(both[0].label, 'hero');
  assert.ok(both.every(c => c.sig === 'Train your own image gen model'), 'every candidate carries the signature');
  assert.ok(both.every(c => c.path === 'main>h1'), 'and the same path');

  const idOnly = Picker.candidatesFor(doc.querySelector('#sub'));
  assert.deepEqual(idOnly.map(c => c.sel), ['#sub', undefined]);
  // An element carrying neither attribute is still reviewable — most real posters have no data-sc at
  // all, and refusing to anchor one would leave nothing to comment on.
  const bare = Picker.candidatesFor(doc.querySelectorAll('p')[1]);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].sel, undefined);
  assert.equal(bare[0].label, 'p');
  assert.equal(bare[0].path, 'main>p:nth-of-type(2)');
});

test('the structural path is a tag chain, indexed only where a tag repeats, and stops at <body>', () => {
  const doc = pickerDom('<main><section><h2>One</h2></section><section><h2>Two</h2><h2>Three</h2></section></main>');
  const secs = doc.querySelectorAll('section');
  assert.equal(Picker.pathOf(secs[0].querySelector('h2')), 'main>section:nth-of-type(1)>h2',
    'the section repeats so it is indexed; its lone h2 is not');
  assert.equal(Picker.pathOf(secs[1].querySelectorAll('h2')[1]), 'main>section:nth-of-type(2)>h2:nth-of-type(2)');
  assert.equal(Picker.pathOf(doc.querySelector('main')), 'main', 'the chain stops before <body>');
  // Every step has to survive the store's own path rule, or the write is refused after the human typed
  // the comment.
  for (const p of ['main>section:nth-of-type(2)>h2:nth-of-type(2)', 'main', 'div>h1'])
    assert.ok(Element.validPath(p), p);
  for (const bad of ['', 'main h1', 'main>[x=1]', 'main>h1:nth-child(2)', 'a'.repeat(400)])
    assert.ok(!Element.validPath(bad), JSON.stringify(bad) + ' is refused');
});

test('the picker and lib/element.js agree on a sel, a snippet and a synthesized quote', () => {
  // selectorFor re-derives what parseRef knows, because the frame gets picker.js and nothing else.
  // These are the three forms an agent can type and the picker can store.
  for (const [ref, css] of [['[data-sc=hero]', '[data-sc="hero"]'], ['hero', '[data-sc="hero"]'], ['#sub', '[id="sub"]']]) {
    assert.equal(Picker.selectorFor(ref), css, ref);
    assert.ok(Element.validSel(ref), ref + ' is a sel the store holds');
  }
  assert.equal(Picker.selectorFor('a b'), null, 'and a value neither would store resolves to nothing');

  // The quote a picker comment writes and the quote `sidecar comment --element` writes have to be the
  // same string, or the same element reads two ways depending on who commented on it. The fixture nests
  // inline tags on purpose: Node reads the file with every tag replaced by a SPACE, so a picker reading
  // textContent would glue "your"+"own" into one word and agree with nothing.
  const html = '<h1 data-sc="headline">Train <b>your</b><i>own</i> image generation model in ten minutes flat, no GPU and no account and no waiting</h1>';
  const el = pickerDom(html).querySelector('h1');
  const fromNode = Element.extract(html)[0];
  assert.equal(Picker.textOf(el), Element.stripTags('Train <b>your</b><i>own</i> image generation model in ten minutes flat, no GPU and no account and no waiting'),
    'the picker reads an element the way the Node rule reads the file');
  assert.equal(Picker.snippet(Picker.textOf(el)), fromNode.text, 'the elided display snippet matches');
  assert.equal(Picker.synthQuote('headline', Picker.snippet(Picker.textOf(el))),
    Element.synthQuote(fromNode.label, fromNode.text), 'and so does the whole quote');
  assert.ok(fromNode.text.endsWith('…'), 'both elide at 80 characters');

  // The SIGNATURE is a different string on purpose: Node checks liveness by matching it against the
  // tag-stripped file, and an ellipsis appears nowhere in the source.
  const sig = Picker.candidatesFor(el)[0].sig;
  assert.ok(!sig.includes('…'), 'no ellipsis in a signature');
  assert.equal(sig.length, 80);
  assert.equal(Element.isLive(html.replace('data-sc="headline"', 'class="big"'), { sel: '[data-sc=headline]', sig }), true,
    'so a signature the picker wrote still resolves by the Node rule after the attribute is renamed');
});

test('the picker resolves sel first, then path checked against sig, then sig alone', () => {
  const doc = pickerDom('<main><h1 data-sc="headline">Train your own image gen model</h1>'
    + '<section><p>Ten minutes, no GPU required.</p></section></main>');
  const sig = 'Train your own image gen model';

  const bySel = Picker.resolve(doc, { sel: '[data-sc=headline]', path: 'nope>nope', sig: 'wrong' });
  assert.equal(bySel.by, 'sel', 'the attribute the agent named wins');
  assert.equal(bySel.el.tagName, 'H1');

  // Attribute gone, path still good: the path is trusted only because the signature agrees.
  const byPath = Picker.resolve(doc, { sel: '[data-sc=gone]', path: 'main>h1', sig });
  assert.equal(byPath.by, 'path');
  assert.equal(byPath.el.tagName, 'H1');
  // A path that now points at the wrong element is refused by the signature and falls through.
  const stale = Picker.resolve(doc, { sel: '[data-sc=gone]', path: 'main>section>p', sig });
  assert.equal(stale.by, 'sig', 'a path whose signature disagrees is not trusted');
  assert.equal(stale.el.tagName, 'H1');
  // Nothing left but the text.
  assert.equal(Picker.resolve(doc, { sig }).by, 'sig');
  assert.equal(Picker.resolve(doc, { sel: '[data-sc=gone]', sig: 'not in this document' }), null);

  // A wrapper holding one child reads the same text as the child, so the deepest match is the one a
  // human pointed at.
  const nested = pickerDom('<main><div><span>Only text</span></div></main>');
  assert.equal(Picker.resolve(nested, { sig: 'Only text' }).el.tagName, 'SPAN');
});

test('an element anchor may be stored by path and signature alone, and a bad path is refused', async () => {
  // The picker's third candidate: an element with neither a data-sc nor an id. `sel` is absent rather
  // than invalid, and the store holds it — CONTEXT.md's element anchor resolves "by structural path
  // checked against a text-content signature" for exactly this case.
  const ok = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'c-bare', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { path: 'main>footer', sig: '© 2026 spktr' }, quote: 'footer · © 2026 spktr' }, thread: [] }] } });
  assert.equal(ok.status, 200);
  const stored = (await ok.json()).review.items.find(i => i.id === 'c-bare');
  assert.deepEqual(stored.anchor.element, { path: 'main>footer', sig: '© 2026 spktr' });

  // A path is run through querySelector inside the frame, so it gets the same treatment the sel does.
  const bad = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'c-badpath', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { path: 'main > *:has(script)', sig: 'x' }, quote: 'x' }, thread: [] }] } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /invalid element path/);

  // And an element anchor that names nothing at all is not an anchor.
  const empty = await put('/api/review', { path: 'poster.html', review: { items: [
    { id: 'c-empty', kind: 'comment', by: 'you', status: 'open',
      anchor: { element: { sig: 'x' }, quote: 'x' }, thread: [] }] } });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /needs a sel or a path/);
});

test('check reports a path anchor as a third state, never as ok, and prints it by its path', () => {
  // Node cannot run a structural path without a DOM, so it abstains, and `check` has to SAY that
  // rather than print `ok`, which would report a check that never happened. Three states, and the
  // path-only anchor still prints by its path (an absent sel used to read as "undefined").
  const d = assetDir();
  const sc = (items) => fs.writeFileSync(path.join(d, 'poster.html.sidecar.json'),
    JSON.stringify({ schema: 1, items }, null, 2));
  const bare = (element) => ({ id: 'c-bare', kind: 'comment', by: 'claude', status: 'open',
    anchor: { element, quote: 'footer · © 2026 spktr' },
    thread: [{ by: 'claude', at: '2026-08-13T10:00:00Z', text: 'the year is wrong' }] });

  sc([bare({ path: 'main>footer', sig: '© 2026 spktr' })]);
  const out = cli(d, 'check', 'poster.html');
  assert.match(out, /\? {4}c-bare {2}main>footer \(\+sig\)/);
  assert.doesNotMatch(out, /undefined/);
  assert.doesNotMatch(out, /^ok/m, 'an unverified anchor is never reported as ok');
  assert.match(out, /1 anchor pins by a structural path/);
  assert.match(out, /cannot say whether the path still lands on that element/);
  assert.match(out, /resolves each one for real when the document is next opened/);

  // The signature is information, both ways, and a signature that stopped matching is NOT death: the
  // element is the referent and its text is evidence.
  sc([bare({ path: 'main>footer', sig: 'a year that is not in the file' })]);
  assert.match(cli(d, 'check', 'poster.html'), /\? {4}c-bare {2}main>footer \(\+sig\)/);
  sc([bare({ path: 'main>div>img' })]);
  assert.match(cli(d, 'check', 'poster.html'), /\? {4}c-bare {2}main>div>img \(no sig\)/);

  // And the abstention does not swallow the answer Node CAN give. A sel anchor is still checked.
  sc([{ id: 'c-sel', kind: 'comment', by: 'claude', status: 'open',
    anchor: { element: { sel: '[data-sc=ghost]' }, quote: 'ghost' }, thread: [] }]);
  const miss = cliFails(d, 'check', 'poster.html');
  assert.equal(miss.status, 1);
  assert.match(miss.stdout, /MISS c-sel/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a comment on a picture survives: no attribute, no text, and Node abstains instead of orphaning', () => {
  // The case the real fixture forced. A poster is mostly pictures, and a picture carries no data-sc, no
  // id and no text — so the anchor is a path and the signature is empty. The Node rule is textual and
  // has nothing to check, and calling that "the element is gone" would orphan every picture comment the
  // moment it was written.
  const poster = '<main><div class="plate"><img src="./face.jpg"></div><p>caption</p></main>';
  const el = pickerDom(poster).querySelector('img');
  const cand = Picker.candidatesFor(el)[0];
  assert.equal(cand.sel, undefined);
  assert.equal(cand.sig, '');
  assert.equal(cand.path, 'main>div>img');
  const element = { path: cand.path, sig: cand.sig };
  assert.equal(Element.isLive(poster, element), true, 'Node abstains on a path it cannot run');
  assert.equal(Element.liveness(poster, element), 'unverified', 'and says so as its own state');
  // The abstention covers a path anchor that HAS a signature too, and that is the change: a signature
  // that stopped matching is evidence of an edit. Node still judges what it can see, so an anchor with
  // a signature and no path is answered outright.
  assert.equal(Element.liveness('<main><p>caption</p></main>', { path: 'main>h1', sig: 'gone now' }), 'unverified');
  assert.equal(Element.liveness('<main><p>caption</p></main>', { sig: 'gone now' }), 'missing');
  assert.equal(Element.liveness('<main><p>caption</p></main>', { sig: 'caption' }), 'live');

  // And the store takes it, so the comment can actually be written.
  const { annotateOrphans } = require('./lib/review.js');
  const review = { items: [{ id: 'c-pic', kind: 'comment', status: 'open',
    anchor: { element, quote: 'img' }, thread: [] }] };
  annotateOrphans(poster, review);
  assert.equal(review.items[0].status, 'open');
});

test('the picker, booted inside the real srcdoc, speaks the whole protocol', () => {
  // The DOM half, exercised the only way it can be without a browser: build the srcdoc the page would
  // build, run it under jsdom with scripts ON, and drive it. jsdom does no layout, so the rects are all
  // zero — geometry VALUES are for the browser pass; that they are reported, keyed by item, is here.
  const srcdoc = AssetFrame.buildFrame({ html: POSTER, docRel: 'poster.html', purify: purifier(),
    picker: fs.readFileSync(path.join(__dirname, 'public', 'picker.js'), 'utf8') });
  const dom = new JSDOM(srcdoc, { runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window, doc = win.document;
  const sent = [];
  // At the jsdom top level window.parent IS the window, which is also why the picker did not boot
  // itself — it only does that inside a frame. So this captures its outbound channel.
  win.postMessage = (msg) => sent.push(msg);
  assert.equal(typeof win.SidecarPicker, 'object', 'the inlined picker ran');
  win.SidecarPicker.boot(win);
  const ready = sent.find(m => m.type === 'sidecar:ready');
  assert.ok(ready, 'it reports the canvas on boot');
  assert.equal(typeof ready.width, 'number');

  const say = (data) => { sent.length = 0; win.dispatchEvent(new win.MessageEvent('message', { data })); };

  // init with what a TERMINAL-written item knows: a sel and nothing else.
  say({ type: 'sidecar:init', items: [{ id: 'c1', element: { sel: '[data-sc=headline]' } }] });
  assert.deepEqual(sent.find(m => m.type === 'sidecar:anchors').anchors, { c1: 'resolved' });
  assert.deepEqual(Object.keys(sent.find(m => m.type === 'sidecar:geometry').rects), ['c1']);
  assert.equal(doc.querySelectorAll('.sc-anchored').length, 1, 'the element carries its cue');
  // …and the picker hands back what only a DOM could know, for the store to keep.
  const bf = sent.find(m => m.type === 'sidecar:backfill');
  assert.equal(bf.id, 'c1');
  assert.equal(bf.element.path, 'main>h1');
  assert.equal(bf.element.sig, 'Train your own image gen model');
  // Written back, that anchor still resolves by the NODE rule after its attribute is renamed — which is
  // the whole point of the backfill.
  assert.equal(Element.isLive(POSTER.replace('data-sc="headline"', 'class="big"'), bf.element), true);

  // A click on a bare element is a pick; a click on one that already carries an item opens that card.
  const footer = doc.querySelector('footer');
  sent.length = 0;
  footer.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(sent.find(m => m.type === 'sidecar:hover').label, 'footer');
  assert.equal(doc.querySelectorAll('.sc-hover').length, 1);
  sent.length = 0;
  footer.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const pick = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(pick.label, 'footer');
  assert.equal(pick.text, '© 2026 spktr');
  assert.equal(pick.candidates[0].path, 'main>footer');
  sent.length = 0;
  doc.querySelector('h1').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(sent.filter(m => m.type === 'sidecar:open').map(m => m.id), ['c1']);
  assert.equal(sent.some(m => m.type === 'sidecar:pick'), false, 'and it does not also start a second thread');

  // A link inside the frame must never navigate: the sandbox lets a frame navigate ITSELF, which would
  // replace the asset with whatever the URL resolves to.
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  doc.querySelector('a').dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);

  // The two inbound cues from the rail.
  say({ type: 'sidecar:highlight', id: 'c1' });
  assert.equal(doc.querySelectorAll('.sc-lit').length, 1);
  say({ type: 'sidecar:highlight', id: null });
  assert.equal(doc.querySelectorAll('.sc-lit').length, 0);
  say({ type: 'sidecar:pulse', id: 'c1' });
  assert.equal(doc.querySelectorAll('.sc-flash').length, 1);

  // An anchor whose element is gone reports missing, which is what the card's orphan badge reads.
  say({ type: 'sidecar:init', items: [{ id: 'c9', element: { sel: '[data-sc=ghost]', sig: 'nothing here' } }] });
  assert.deepEqual(sent.find(m => m.type === 'sidecar:anchors').anchors, { c9: 'missing' });
  dom.window.close();
});

/* ────────────────────────────────────────────────────────────────────────────
   Drift: the element is the referent, its text is only evidence

   The incident, from live testing: a card said "change this to Alex Smith", the change was made, and
   the card orphaned, so acting on a comment destroyed the comment. Any text edit to an unlabelled
   element did it, because the stored signature was the text as it read when the card was written.
   ──────────────────────────────────────────────────────────────────────────── */

// A frame around one asset, driven the way the boot test drives it: the real srcdoc, jsdom with
// scripts on, the outbound channel captured.
function bootFrame(html) {
  const srcdoc = AssetFrame.buildFrame({ html, docRel: 'poster.html', purify: purifier(),
    picker: fs.readFileSync(path.join(__dirname, 'public', 'picker.js'), 'utf8') });
  const dom = new JSDOM(srcdoc, { runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window, sent = [];
  win.postMessage = (msg) => sent.push(msg);
  win.SidecarPicker.boot(win);
  return { dom, win, doc: win.document, sent,
    say: (data) => { sent.length = 0; win.dispatchEvent(new win.MessageEvent('message', { data })); } };
}

test('a text edit at a stable path keeps the card and backfills the new signature', () => {
  // THE INCIDENT. The card asks for the footer to read "Alex Smith"; the edit is made; the element is
  // the same element at the same path with different words in it. It stays live, and the picker hands
  // back the new signature so the next resolution starts from what the file says now.
  const edited = POSTER.replace('© 2026 spktr', '© 2026 Alex Smith');
  const { doc, sent, say, dom } = bootFrame(edited);
  const stored = { path: 'main>footer', sig: '© 2026 spktr' };

  say({ type: 'sidecar:init', items: [{ id: 'c-bare', element: stored }] });
  assert.deepEqual(sent.find(m => m.type === 'sidecar:anchors').anchors, { 'c-bare': 'resolved' });
  const bf = sent.find(m => m.type === 'sidecar:backfill');
  assert.deepEqual(bf.element, { path: 'main>footer', sig: '© 2026 Alex Smith' });
  assert.equal(doc.querySelector('footer').classList.contains('sc-anchored'), true);
  assert.equal(Picker.resolve(doc, stored).by, 'path-edited', 'the same element, its text edited');

  // The guard that makes case 3 safe. The old signature turning up somewhere ELSE means the element
  // moved, so the search wins and the element that now sits at the stale path does not impersonate it.
  const moved = POSTER.replace('© 2026 spktr', 'Ten minutes, no GPU required.');
  const two = bootFrame(moved);
  const hit = Picker.resolve(two.doc, { path: 'main>footer', sig: 'Ten minutes, no GPU required.' });
  assert.equal(hit.by, 'path', 'the path itself still agrees here');
  two.say({ type: 'sidecar:init', items: [{ id: 'c-moved',
    element: { path: 'main>h1', sig: 'Ten minutes, no GPU required.' } }] });
  const found = Picker.resolve(two.doc, { path: 'main>h1', sig: 'Ten minutes, no GPU required.' });
  assert.equal(found.by, 'sig', 'the stale path resolves to the h1, whose text disagrees, so the search runs');
  assert.equal(found.el.tagName, 'P', 'and it lands on the element the text moved to');
  const bf2 = two.sent.find(m => m.type === 'sidecar:backfill');
  assert.equal(bf2.element.path, 'main>p', 'the new path is backfilled, not the old one kept');
  dom.window.close(); two.dom.window.close();
});

test('resolution order: sel, path+sig, sig anywhere, then the same path with edited text', () => {
  // The full ladder in one place, because the last two rungs are the ones that trade off against each
  // other. Two paragraphs share a path shape; the second holds the text the first used to hold.
  const doc = pickerDom('<main><p>Old words</p><p>New words</p></main>');
  // Nothing else in the document reads "Only here", so the path is trusted despite the mismatch.
  const solo = pickerDom('<main><p>Different words now</p></main>');
  assert.equal(Picker.resolve(solo, { path: 'main>p', sig: 'Only here' }).by, 'path-edited');
  assert.equal(Picker.resolve(solo, { path: 'main>p', sig: 'Only here' }).el.tagName, 'P');
  // The same mismatch, except the stored text is alive elsewhere: that is a move, and it wins.
  const moved = Picker.resolve(doc, { path: 'main>p:nth-of-type(2)', sig: 'Old words' });
  assert.equal(moved.by, 'sig');
  assert.equal(Picker.textOf(moved.el), 'Old words');
  // A path that resolves to nothing and a signature that is nowhere is still death.
  assert.equal(Picker.resolve(solo, { path: 'main>h1', sig: 'Only here' }), null);
});

test('Node never orphans a path anchor, and still orphans one whose sel is deleted', () => {
  const d = assetDir();
  // An item with no attribute at all: what the picker writes when the human clicks a bare element.
  // Its signature is deliberately stale, which used to read as "the element is gone".
  fs.writeFileSync(path.join(d, 'poster.html.sidecar.json'), JSON.stringify({ schema: 1, items: [
    { id: 'c-bare', kind: 'comment', by: 'claude', status: 'open',
      anchor: { element: { path: 'main>footer', sig: '© 2026 spktr' }, quote: 'footer · © 2026 spktr' },
      thread: [{ by: 'claude', at: '2026-08-13T10:00:00Z', text: 'change this to Alex Smith' }] }] }, null, 2));
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace('© 2026 spktr', '© 2026 Alex Smith'));
  cli(d, 'show', 'poster.html');
  assert.equal(scAt(d, 'poster.html').items[0].status, 'open', 'the card survives the edit it asked for');
  // Even the element being cut leaves it open here: a path is the frame's to judge, and the frame
  // reports missing on the next open. Node reporting it dead would be a guess dressed as a fact.
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace(/<footer>[^<]*<\/footer>/, ''));
  cli(d, 'show', 'poster.html');
  assert.equal(scAt(d, 'poster.html').items[0].status, 'open', 'Node defers rather than guessing');

  // A sel anchor is a different matter: Node can read the attribute out of the file, so it answers.
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER);
  cli(d, 'comment', 'poster.html', '--element', 'cta', '--text', 'the link goes nowhere');
  const id = scAt(d, 'poster.html').items.find(i => i.id !== 'c-bare').id;
  const at = (name) => scAt(d, 'poster.html').items.find(i => i.id === id).status;
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace('>Get started<', '>Start now<'));
  cli(d, 'show', 'poster.html');
  assert.equal(at(), 'open', 'rewriting the text does not orphan a sel anchor either');
  fs.writeFileSync(path.join(d, 'poster.html'), POSTER.replace("data-sc='cta'", 'class="btn"'));
  cli(d, 'show', 'poster.html');
  assert.equal(at(), 'orphaned', 'deleting the attribute does');
  assert.equal(scAt(d, 'poster.html').items.find(i => i.id === id).orphanReason, 'element-changed');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   Layer stepping: reaching what the paint stack buries

   The incident: a poster's background image could not be commented on anywhere except one gap,
   because scrims covered the rest of it and hover only ever finds the top of the stack.
   ──────────────────────────────────────────────────────────────────────────── */

const LAYERED = `<!doctype html>
<html><body>
  <main>
    <img data-sc="art" src="./art.jpg">
    <div data-sc="scrim"></div>
  </main>
</body></html>
`;

test('the layer stack is the pickable elements under a point, top first and deduped', () => {
  const doc = pickerDom('<main><img data-sc="art" src="./art.jpg"><div data-sc="scrim"></div></main>');
  const scrim = doc.querySelector('[data-sc=scrim]'), art = doc.querySelector('img');
  const main = doc.querySelector('main');
  // jsdom does no layout, so the browser's hit test is stubbed. What is under test is the filtering
  // and the ordering, which is all the picker contributes.
  doc.elementsFromPoint = () => [scrim, art, art, main, doc.body, doc.documentElement];
  assert.deepEqual(Picker.stackAt(doc, 5, 5, null), [scrim, art, main],
    'body, html and the repeat are dropped; paint order is kept');
  // No hit test at all (jsdom without the stub, an older engine): the event target carries it.
  const bare = pickerDom('<main><p>x</p></main>');
  assert.deepEqual(Picker.stackAt(bare, 0, 0, bare.querySelector('p')), [bare.querySelector('p')]);
  assert.deepEqual(Picker.stackAt(bare, 0, 0, bare.body), [], 'and body is never a pick');

  // The step wraps, and a step left over from a deeper stack reads as the top rather than as nothing.
  const stack = [scrim, art, main];
  assert.equal(Picker.stepped(stack, 0), scrim);
  assert.equal(Picker.stepped(stack, 2), main);
  assert.equal(Picker.stepped(stack, 3), scrim, 'it wraps at the bottom');
  assert.equal(Picker.stepped([], 1), null);
  assert.equal(Picker.sameStack(stack, [scrim, art, main]), true);
  assert.equal(Picker.sameStack(stack, [scrim, art]), false);
  assert.equal(Picker.sameStack(stack, [art, scrim, main]), false, 'order is part of the identity');
});

test('Alt steps the outline a layer deeper, and the click takes what is outlined', () => {
  const { win, doc, sent, say, dom } = bootFrame(LAYERED);
  const scrim = doc.querySelector('[data-sc=scrim]'), art = doc.querySelector('img');
  const main = doc.querySelector('main');
  doc.elementsFromPoint = () => [scrim, art, main, doc.body];
  const move = () => { sent.length = 0;
    doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 })); };
  const hover = () => sent.find(m => m.type === 'sidecar:hover');

  move();
  assert.deepEqual({ ...hover(), type: undefined },
    { type: undefined, label: 'scrim', depth: 1, count: 3, href: '', link: false },
    'the top of the stack by default, with the depth the page shows, no link under it, no link mode');
  assert.equal(scrim.classList.contains('sc-hover'), true);

  // The page forwards the key, because a keydown reaches the frame only once the frame has focus.
  say({ type: 'sidecar:step' });
  assert.equal(hover().label, 'art');
  assert.equal(hover().depth, 2);
  assert.equal(art.classList.contains('sc-hover'), true);
  assert.equal(scrim.classList.contains('sc-hover'), false, 'one outline at a time');
  // The frame's own key does the same thing, so the two routes cannot drift.
  sent.length = 0;
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
  assert.equal(hover().label, 'main');
  sent.length = 0;
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
  assert.equal(hover().label, 'scrim', 'and it wraps');
  sent.length = 0;
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Alt', bubbles: true, repeat: true }));
  assert.equal(hover(), undefined, 'a held key does not spin through the stack');

  // A click takes the OUTLINED element. Step to the buried image and pick it, which is the whole
  // point: the scrim covers every pixel of it, so it is unreachable by hover.
  say({ type: 'sidecar:step' });
  sent.length = 0;
  scrim.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const pick = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(pick.label, 'art');
  assert.equal(pick.candidates[0].sel, '[data-sc=art]', 'the anchor is the image, not the thing clicked');

  // Moving to a point whose layers differ starts again at the top.
  doc.elementsFromPoint = () => [main, doc.body];
  move();
  assert.equal(hover().label, 'main');
  assert.equal(hover().count, 1);
  doc.elementsFromPoint = () => [scrim, art, main, doc.body];
  move();
  assert.equal(hover().label, 'scrim', 'and back over the stack, the step is reset');
  dom.window.close();
});

test('a citation inside an asset reaches the page as a pick carrying its href', () => {
  // An asset cites its siblings the way a document does, and following one is the same navigation. The
  // frame reports the href and nothing else: the rule lives in public/doclink.js on the page's side,
  // because the frame is given the picker and no way to fetch a second script.
  const cited = POSTER.replace('<footer>© 2026 spktr</footer>',
    '<footer><a href="./market-research.md"><span data-sc="cite">the research</span></a></footer>');
  const { win, doc, sent, dom } = bootFrame(cited);
  const span = doc.querySelector('[data-sc=cite]'), cta = doc.querySelector('[data-sc=cta]');
  const from = 'vault/projects/ccdc-portal/poster.html';

  doc.elementsFromPoint = () => [span, doc.querySelector('footer'), doc.body];
  sent.length = 0;
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
  const hover = sent.find(m => m.type === 'sidecar:hover');
  assert.equal(hover.label, 'cite');
  assert.equal(hover.href, './market-research.md', 'the affordance knows before the click');

  sent.length = 0;
  span.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const pick = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(pick.href, './market-research.md', 'found from the deepest element, through its ancestors');
  assert.equal(pick.follow, false, 'a plain click is the comment, whatever the href turns out to be');
  assert.deepEqual(DocLink.route(pick.href, from),
    { rel: 'vault/projects/ccdc-portal/market-research.md', hash: '' }, 'and the page could open that document');

  // Shift is what asks for the link. The page reads `follow` and routes the href; the frame's part is
  // reporting both, and preventing the default, since Chrome's own shift+click would want a second window.
  sent.length = 0;
  const shifted = new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, shiftKey: true });
  span.dispatchEvent(shifted);
  const follow = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(follow.follow, true, 'shift+click asks the page to follow the link');
  assert.equal(follow.href, './market-research.md');
  assert.equal(shifted.defaultPrevented, true, 'and never navigates the frame or opens a window itself');

  // The poster's own call to action is an absolute path, which is a URL on this origin rather than a
  // path in the served root — so it stays an ordinary pick and the composer opens on it.
  doc.elementsFromPoint = () => [cta, doc.querySelector('main'), doc.body];
  sent.length = 0;
  cta.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const second = sent.find(m => m.type === 'sidecar:pick');
  assert.equal(second.href, '/start');
  assert.equal(DocLink.route(second.href, from), null);
  dom.window.close();
});

test('shift puts the asset in link mode, and it comes back out of it', () => {
  // The other half of the complaint: a click that navigates and a click that comments looked identical.
  // While shift is down the frame carries a class the picker's own stylesheet paints links with, the
  // hover report says link mode is on so the page's status slot can name the destination, and a click
  // follows the link even where the element already carries a thread.
  const linked = POSTER.replace('<footer>© 2026 spktr</footer>',
    '<footer><a href="my-zone.html" id="nav">my zone</a></footer>');
  const { win, doc, sent, say, dom } = bootFrame(linked);
  const nav = doc.querySelector('#nav');
  const html = doc.documentElement;
  const hover = () => sent.find(m => m.type === 'sidecar:hover');
  doc.elementsFromPoint = () => [nav, doc.querySelector('footer'), doc.body];

  // The page forwards the first press, because the frame has no focus until it is clicked.
  say({ type: 'sidecar:linkmode', on: true });
  assert.equal(html.classList.contains('sc-linkmode'), true);
  assert.equal(hover().link, true, 'and the status slot is told without the cursor having to move');
  say({ type: 'sidecar:linkmode', on: false });
  assert.equal(html.classList.contains('sc-linkmode'), false);

  // The frame's own keys do the same, so the two routes cannot drift.
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  assert.equal(html.classList.contains('sc-linkmode'), true);
  doc.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  assert.equal(html.classList.contains('sc-linkmode'), false);

  // A keyup lost to a window switch would leave every link in the asset looking live. Blur clears it,
  // and so does the true modifier state on the next movement over the frame.
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  win.dispatchEvent(new win.Event('blur'));
  assert.equal(html.classList.contains('sc-linkmode'), false, 'blur drops it');
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5, shiftKey: true }));
  assert.equal(html.classList.contains('sc-linkmode'), true, 'a move with shift down puts it back');
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 6, clientY: 6 }));
  assert.equal(html.classList.contains('sc-linkmode'), false, 'and a move without it clears a stuck one');

  // An element that already carries an item: a plain click reopens its thread, shift follows the link.
  // A commented nav bar is exactly what a human then wants to click through.
  say({ type: 'sidecar:init', items: [{ id: 'c1', element: { sel: '#nav' } }] });
  sent.length = 0;
  nav.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  assert.equal(sent.find(m => m.type === 'sidecar:open').id, 'c1');
  sent.length = 0;
  nav.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, shiftKey: true }));
  assert.equal(sent.some(m => m.type === 'sidecar:open'), false, 'shift does not reopen the card');
  assert.equal(sent.find(m => m.type === 'sidecar:pick').follow, true);
  dom.window.close();
});

test('a fragment link reports where it points, for the page to scroll to', () => {
  // '#flags' scrolls the asset it is already in. The frame is laid out at its full natural height and has
  // no scrollport of its own, so the scroll belongs to the page and all the frame owes it is a rect.
  const fragged = POSTER.replace('<footer>© 2026 spktr</footer>', '<footer id="flags">flags</footer>');
  const { sent, say, dom } = bootFrame(fragged);

  say({ type: 'sidecar:reveal', frag: 'flags' });
  const at = sent.find(m => m.type === 'sidecar:revealed');
  assert.ok(at && at.rect && typeof at.rect.top === 'number', "the target, in the frame's own coordinates");

  say({ type: 'sidecar:reveal', frag: 'nothing-here' });
  assert.equal(sent.some(m => m.type === 'sidecar:revealed'), false,
    'an id in no element says nothing: that is a broken link in the asset, not a scroll to recover');
  dom.window.close();
});

// ---------- the folder layer: `wait --dir` / `digest --dir` (lib/dir.js) ----------
// Reviewing a product means reviewing a folder, so one watcher and one digest cover it. The cursors
// underneath stay per document — these assert the aggregation over them, the doc set it aggregates,
// and the lock that keeps two folder watchers off the same cursors.
const Dir = require('./lib/dir.js');
const { computeDigest: cd, renderDigest: rd, digestBody: db } = require('./lib/digest.js');

// A delta shaped like computeDigest's, without the disk round-trip.
const delta = (over = {}) => ({ decided: [], orphaned: [], news: [], replies: [], removed: [],
  docChanged: false, docPatch: null, done: false, empty: true, noMarker: false, at: null,
  snapshot: { docHash: 'h', items: {}, at: 'now' }, ...over });
const oneNew = (q, text) => delta({ empty: false, news: [{ id: 'c1', kind: 'comment', q, text }] });

test('the folder doc set is the panel\'s: this directory only, documents only, sorted', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirset-'));
  for (const n of ['zeta.md', 'brief.md', 'poster.html', 'notes.txt', 'data.json', '.hidden.md'])
    fs.writeFileSync(path.join(d, n), 'x');
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'deep.md'), 'x');       // no recursion: the panel shows one folder
  fs.writeFileSync(path.join(d, 'brief.md.sidecar.json'), '{}');   // a sidecar is not a document
  fs.writeFileSync(path.join(d, 'brief.md.sidecar.seen.json'), '{}');
  assert.deepEqual(Dir.docsIn(d).map(p => path.basename(p)), ['brief.md', 'poster.html', 'zeta.md']);
  assert.deepEqual(Dir.docsIn(path.join(d, 'nope')), [], 'a folder that is not there is empty, never a throw');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the folder digest labels every event with its document, and counts live against total', () => {
  const out = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'brief.md', d: oneNew('the bet', 'say who it is for') },
    { rel: 'business-case.md', d: delta() },
    { rel: 'market-research.md', d: delta({ empty: false, replies: [{ id: 'c2', q: 'counties', text: 'which ones' }] }) },
  ]);
  assert.match(out, /## sidecar — your turn in \/p\/ccdc \(2 of 3 documents\)/);
  assert.match(out, /### brief\.md\n- NEW comment @ “the bet”: say who it is for/);
  assert.match(out, /### market-research\.md\n- REPLY @ “counties”: which ones/);
  assert.ok(!out.includes('business-case.md'), 'a document with nothing unseen is counted, not printed');
  assert.match(out, /\nDONE: false$/);
});

test('a folder digest with nothing unseen says so once, not once per document', () => {
  const out = Dir.renderDirDigest('/p/ccdc', [{ rel: 'a.md', d: delta() }, { rel: 'b.md', d: delta() }]);
  assert.equal(out, 'nothing new across 2 documents in /p/ccdc\n\nDONE: false');
  assert.match(Dir.renderDirDigest('/p/empty', []), /^nothing new across 0 documents/);
});

test('folder DONE is true only when every document is done; a partial says which', () => {
  const half = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'a.md', d: delta({ done: true }) }, { rel: 'b.md', d: delta() }]);
  assert.match(half, /DONE: false {2}\(1 of 2 marked done: a\.md\)/, 'one finished document does not end the review');
  const all = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'a.md', d: delta({ done: true }) }, { rel: 'b.md', d: delta({ done: true }) }]);
  assert.match(all, /\nDONE: true$/);
  assert.ok(!/marked done:/.test(all), 'and it does not then list them all back');
});

test('a document with no cursor is labelled per document, since the others still have theirs', () => {
  const out = Dir.renderDirDigest('/p/ccdc', [
    { rel: 'fresh.md', d: { ...oneNew('q', 't'), noMarker: true } },
    { rel: 'seen.md', d: oneNew('q2', 't2') },
  ]);
  assert.match(out, /### fresh\.md {2}\(no last-seen marker\)/);
  assert.match(out, /### seen\.md\n/, 'the document with a cursor carries no such note');
});

test('the doc-changes section nests under the document name in a folder digest', () => {
  const withDiff = delta({ empty: false, docChanged: true, docPatch: '@@ -1 +1 @@\n-a\n+b' });
  assert.match(Dir.renderDirDigest('/p', [{ rel: 'a.md', d: withDiff }]), /#### doc changes \(since your last look\)/);
  // and the single-document digest still says ### — its heading is the top level there.
  assert.match(rd(withDiff), /\n### doc changes \(since your last look\)/);
});

test('digestBody is the single-document renderer minus its frame (the split kept renderDigest honest)', () => {
  const d = oneNew('the bet', 'say who');
  assert.equal(rd(d), '## sidecar — your turn\n' + db(d) + '\n\nDONE: false');
  const both = delta({ empty: false, news: d.news, docChanged: true, docPatch: '@@ -1 +1 @@\n-a\n+b' });
  assert.equal(rd(both), '## sidecar — your turn\n' + db(both) + '\n\nDONE: false');
});

test('the folder lock: one watcher per (folder, agent), and a different agent gets its own', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirlock-'));
  const p = Dir.lockPath(d, 'claude');
  assert.notEqual(p, Dir.lockPath(d, 'gemini'), 'the agent is part of the key');
  assert.notEqual(p, Dir.lockPath(d + '2', 'claude'), 'and so is the folder');
  assert.equal(Dir.heldBy(p), null, 'nothing held to begin with');
  assert.ok(Dir.acquireLock(d, 'claude').path, 'the first watcher takes it');
  assert.equal(Dir.heldBy(p).pid, process.pid);
  // Another agent on the same folder is a separate loop with its own cursors — it is not refused.
  assert.ok(Dir.acquireLock(d, 'gemini').path);
  assert.equal(Dir.heldBy(Dir.lockPath(d, 'gemini')).agent, 'gemini');
  assert.ok(Dir.acquireLock(d, 'claude').path, 'and a process is never a rival to itself');
  Dir.releaseLock(p); Dir.releaseLock(Dir.lockPath(d, 'gemini'));
  assert.equal(Dir.heldBy(p), null, 'and it is free again on the way out');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a lock whose holder is dead, or whose heartbeat stopped, is not held', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirlock2-'));
  const p = Dir.lockPath(d, 'claude');
  const live = { pid: process.pid, dir: d, agent: 'claude', at: 'now' };

  fs.writeFileSync(p, JSON.stringify(live));
  assert.ok(Dir.heldBy(p), 'a running holder with a fresh heartbeat holds it');

  // Stopped heartbeat: the file is old, whoever wrote it is not beating any more.
  const old = new Date(Date.now() - Dir.LOCK_TTL - 5000);
  fs.utimesSync(p, old, old);
  assert.equal(Dir.heldBy(p), null, 'three missed beats and the lock is free');
  Dir.touchLock(p);
  assert.ok(Dir.heldBy(p), 'a beat revives it');

  // Dead holder: a pid nothing is running. 0x7FFFFFF is beyond any live pid on macOS/Linux.
  fs.writeFileSync(p, JSON.stringify({ ...live, pid: 0x7FFFFFF }));
  assert.equal(Dir.heldBy(p), null, 'a fresh file from a dead process is not a claim');

  // A rival that is BOTH alive and beating is refused, and --force takes it.
  fs.writeFileSync(p, JSON.stringify({ ...live, pid: 1 }));   // pid 1 is always alive (EPERM reads as alive)
  assert.equal(Dir.acquireLock(d, 'claude').error.pid, 1, 'refused, and it names the holder');
  assert.ok(Dir.acquireLock(d, 'claude', { force: true }).path, '--force takes over');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).pid, process.pid);

  // Release only ever removes OUR lock — a process that was forced out must not delete the new claim.
  fs.writeFileSync(p, JSON.stringify({ ...live, pid: 1 }));
  Dir.releaseLock(p);
  assert.ok(fs.existsSync(p), 'someone else\'s lock survives our release');
  fs.writeFileSync(p, JSON.stringify(live));
  Dir.releaseLock(p);
  assert.ok(!fs.existsSync(p), 'and our own is cleaned up');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- the folder verbs, as real processes (no server: the filesystem is the sync layer) ----

const dirFixture = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-dirwait-'));
  fs.writeFileSync(path.join(d, 'brief.md'), '# Brief\n\nThe first claim lives here.\n');
  fs.writeFileSync(path.join(d, 'research.md'), '# Research\n\nThe second claim lives here.\n');
  fs.writeFileSync(path.join(d, 'ignored.json'), '{}');
  return d;
};
// Alex's side of the loop: the human writing a comment, run as a different agent name.
const asAlex = (args, cwd) => spawnSync('node', [path.join(__dirname, 'server.js'), ...args],
  { cwd, env: { ...process.env, SIDECAR_AGENT: 'alex', SIDECAR_PORT: '4990' }, encoding: 'utf8' });
const dirCli = (args, cwd) => spawnSync('node', [path.join(__dirname, 'server.js'), ...args],
  { cwd, env: { ...process.env, SIDECAR_PORT: '4990' }, encoding: 'utf8' });

test('sidecar wait --dir wakes on a change to ANY document and names which one', async () => {
  const d = dirFixture();
  dirCli(['digest', '--dir', d], d);   // seed both cursors, so the wait starts from a clean folder
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', '--dir', d, '--timeout', '20'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (x) => out += x.toString());
  await new Promise((res) => setTimeout(res, 900));   // let the fs-watcher attach
  asAlex(['comment', 'research.md', '--quote', 'The second claim lives here.', '--text', 'WAKE-ON-ANY-DOC'], d);
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0, 'the folder wait exits 0 once they act on any document in it');
  assert.match(out, /### research\.md/, 'the digest labels the event with its document');
  assert.match(out, /WAKE-ON-ANY-DOC/);
  assert.ok(!out.includes('### brief.md'), 'and says nothing about the document that did not change');
  // The cursor that advanced is research.md's own — the folder holds none of its own.
  assert.ok(fs.existsSync(path.join(d, 'research.md.sidecar.seen.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('a second wait --dir by the same agent refuses (exit 2) rather than racing the first', async () => {
  const d = dirFixture();
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', '--dir', d, '--timeout', '8'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  await new Promise((res) => setTimeout(res, 900));
  const second = dirCli(['wait', '--dir', d, '--timeout', '2'], d);
  assert.equal(second.status, 2, 'refused, the same exit code a bad path gets');
  assert.match(second.stderr, /already watching/);
  assert.match(second.stderr, /--force/, 'and it says how to take over');
  w.kill();
  await new Promise((res) => w.on('exit', res));
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait --dir on something that is not a folder exits 2, and --timeout exits 1', async () => {
  const d = dirFixture();
  const bad = dirCli(['wait', '--dir', path.join(d, 'brief.md')], d);
  assert.equal(bad.status, 2, 'a file is not a folder');
  assert.match(bad.stderr, /no folder at/);
  const asFile = dirCli(['wait', d, '--timeout', '2'], d);
  assert.equal(asFile.status, 2, 'and a folder passed as the file argument says which flag it wanted');
  assert.match(asFile.stderr, /--dir/);
  dirCli(['digest', '--dir', d], d);
  const quiet = dirCli(['wait', '--dir', d, '--timeout', '1'], d);
  assert.equal(quiet.status, 1, 'a quiet folder times out at 1, exactly as one quiet document does');
  assert.match(quiet.stdout, /still watching/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('digest --dir reports every document, then advances each cursor (and --peek advances none)', () => {
  const d = dirFixture();
  dirCli(['digest', '--dir', d], d);
  asAlex(['comment', 'brief.md', '--quote', 'The first claim lives here.', '--text', 'ONE'], d);
  asAlex(['comment', 'research.md', '--quote', 'The second claim lives here.', '--text', 'TWO'], d);

  const peek = dirCli(['digest', '--dir', d, '--peek'], d);
  assert.match(peek.stdout, /\(2 of 2 documents\)/);
  assert.match(peek.stdout, /### brief\.md\n- NEW comment @ “The first claim lives here\.”: ONE/);
  assert.match(peek.stdout, /### research\.md\n- NEW comment @ “The second claim lives here\.”: TWO/);

  const again = dirCli(['digest', '--dir', d, '--peek'], d);
  assert.equal(again.stdout, peek.stdout, '--peek advanced nothing, so it reads the same twice');

  const real = dirCli(['digest', '--dir', d], d);
  assert.equal(real.stdout, peek.stdout);
  assert.match(dirCli(['digest', '--dir', d], d).stdout, /^nothing new across 2 documents/,
    'and once looked at, both cursors have moved');

  // The cursors are the ordinary per-document ones: a single-document digest agrees with the folder.
  assert.match(dirCli(['digest', path.join(d, 'brief.md')], d).stdout, /^nothing new since/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a document created while wait --dir is armed joins the folder it is watching', async () => {
  const d = dirFixture();
  dirCli(['digest', '--dir', d], d);
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', '--dir', d, '--timeout', '20'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', (x) => out += x.toString());
  await new Promise((res) => setTimeout(res, 900));
  // Creating it must NOT wake the watcher: a new file is baselined where it stands, exactly as a
  // document with no cursor is at launch. The first real change to it is the news.
  fs.writeFileSync(path.join(d, 'business-case.md'), '# Case\n\nThe payback is eighteen months.\n');
  await new Promise((res) => setTimeout(res, 900));
  assert.equal(out, '', 'the file appearing is not itself an event');
  asAlex(['comment', 'business-case.md', '--quote', 'The payback is eighteen months.', '--text', 'LATE-DOC'], d);
  const code = await new Promise((res) => w.on('exit', res));
  assert.equal(code, 0);
  assert.match(out, /### business-case\.md/, 'a document that did not exist at launch is watched anyway');
  assert.match(out, /LATE-DOC/);
  assert.match(out, /\(1 of 3 documents\)/, 'and the folder is now three');
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------- the watcher registry: `sidecar watchers` (lib/watchers.js) ----------
// A `wait` is a long-lived process holding the turn, and half of them used to leave no trace at all.
// These cover the three things the verb promises: it says what is armed, it can tell a running
// watcher from a record that outlived its process, and --clean touches only the second kind.

const Watchers = require('./lib/watchers.js');

// A record for a pid nothing is running. 0x7FFFFFF is beyond any live pid on macOS/Linux, the same
// number the folder-lock tests use for a dead holder.
const DEAD_PID = 0x7FFFFFF;
const plantDead = (target, agent = 'ghost') => {
  const p = Watchers.recordPath('doc', target, agent);
  fs.writeFileSync(p, JSON.stringify({ pid: DEAD_PID, kind: 'doc', file: target, agent, at: new Date().toISOString() }));
  return p;
};

test('the registry reads a live record and a dead one apart, and clean removes only the dead', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-watchers-'));
  const liveDoc = path.join(d, 'live.md'), deadDoc = path.join(d, 'dead.md');

  const mine = Watchers.arm(liveDoc, 'claude');       // this process is genuinely alive
  const theirs = plantDead(deadDoc);
  const find = (t) => Watchers.list().find(r => r.target === t);

  assert.equal(find(liveDoc).state, 'live', 'a running holder with a fresh beat is live');
  assert.equal(find(liveDoc).pid, process.pid);
  assert.equal(find(liveDoc).kind, 'doc');
  assert.equal(find(deadDoc).state, 'stale', 'a fresh record from a dead process is stale');

  // A running holder that has missed three beats is QUIET, not stale: it may be suspended, and
  // reaping its record would hide a watcher that is genuinely armed.
  const old = new Date(Date.now() - Watchers.TTL - 5000);
  fs.utimesSync(mine, old, old);
  assert.equal(find(liveDoc).state, 'quiet');
  Watchers.touch(mine);
  assert.equal(find(liveDoc).state, 'live', 'a beat revives it');

  const reaped = Watchers.clean();
  assert.ok(reaped.some(r => r.target === deadDoc), 'the dead record is reaped');
  assert.ok(!reaped.some(r => r.target === liveDoc), 'and the live one is never touched');
  assert.ok(!fs.existsSync(theirs));
  assert.ok(fs.existsSync(mine));

  Watchers.release(mine);
  assert.ok(!fs.existsSync(mine), 'and our own goes on the way out');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the folder lock is one of the records the registry lists', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-watchers-dir-'));
  const lock = Dir.acquireLock(d, 'claude');
  const rec = Watchers.list().find(r => r.target === d);
  assert.equal(rec.kind, 'dir', 'a dir lock reads as a dir watcher');
  assert.equal(rec.agent, 'claude');
  assert.equal(rec.state, 'live');
  Dir.releaseLock(lock.path);
  assert.equal(Watchers.list().find(r => r.target === d), undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test('sidecar watchers lists a real armed wait as LIVE beside a dead record marked STALE', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-watchers-cli-'));
  const doc = path.join(d, 'armed.md');
  fs.writeFileSync(doc, '# Armed\n\nThe claim lives here.\n');
  fs.writeFileSync(doc + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  const ghostDoc = path.join(d, 'ghost.md');
  const ghost = plantDead(ghostDoc);

  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', doc, '--timeout', '20'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  try {
    await new Promise((res) => setTimeout(res, 900));   // let it get past the startup emit and arm
    const armed = fs.realpathSync(doc);

    const listed = dirCli(['watchers'], d);
    assert.equal(listed.status, 0, 'listing is never an error, whatever it finds');
    const live = listed.stdout.split('\n').find(l => l.includes(armed));
    assert.match(live, /LIVE\s+doc\s+claude\s+pid \d+/, 'the armed wait is live, with its pid');
    assert.match(listed.stdout, new RegExp(`STALE\\s+doc\\s+ghost.*${ghostDoc.replace(/[.]/g, '\\.')}`),
      'and the record whose process is gone is marked STALE');
    assert.match(listed.stdout, /sidecar watchers --clean/, 'which says how to clear it');

    const cleaned = dirCli(['watchers', '--clean'], d);
    assert.equal(cleaned.status, 0);
    assert.match(cleaned.stdout, /reaped \d+ stale watcher/);
    assert.ok(cleaned.stdout.includes(ghostDoc), 'it reports what it reaped by name');
    assert.ok(!fs.existsSync(ghost), 'the stale record is gone');

    const after = dirCli(['watchers'], d);
    assert.ok(after.stdout.includes(armed), 'the live watcher survived the clean');
    assert.ok(!after.stdout.includes(ghostDoc));

    // --kill refuses a pid it holds no record for, rather than signalling on a number alone.
    const stray = dirCli(['watchers', '--kill', String(DEAD_PID)], d);
    assert.equal(stray.status, 2);
    assert.match(stray.stderr, /no watcher record for pid/);
  } finally {
    w.kill();
    await new Promise((res) => w.on('exit', res));
  }
  // The wait cleans its own record up on the way out (SIGTERM now runs its exit path).
  assert.equal(Watchers.list().find(r => r.target === fs.realpathSync(doc)), undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test('wait --timeout 0 has no backstop: it blocks past the default and still wakes on a comment', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-notimeout-'));
  const doc = path.join(d, 'patient.md');
  fs.writeFileSync(doc, '# Patient\n\nThe claim lives here.\n');
  fs.writeFileSync(doc + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));

  // `Number(argv[++i]) || 900` read 0 as absent and armed the 15-minute backstop anyway. Nothing this
  // test can wait out proves "never", so it proves the flag is taken at all: a 1s wait on the same
  // document exits 1, and this one is still blocking well after that.
  const quick = dirCli(['wait', doc, '--timeout', '1'], d);
  assert.equal(quick.status, 1, 'a 1s timeout expires');

  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', doc, '--timeout', '0'],
    { env: { ...process.env, SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = '';
  w.stdout.on('data', (x) => out += x.toString());
  // Never let this hang the suite: whatever happens, the child dies at 15s.
  const guard = setTimeout(() => w.kill('SIGKILL'), 15000);
  try {
    await new Promise((res) => setTimeout(res, 2500));
    assert.equal(w.exitCode, null, 'still blocking with no timeout to expire');
    assert.equal(out, '', 'and it has said nothing');

    asAlex(['comment', 'patient.md', '--quote', 'The claim lives here.', '--text', 'NO-BACKSTOP'], d);
    const code = await new Promise((res) => w.on('exit', res));
    assert.equal(code, 0, 'it still wakes on a real event and exits 0');
    assert.match(out, /NO-BACKSTOP/);
  } finally { clearTimeout(guard); w.kill(); }
  fs.rmSync(d, { recursive: true, force: true });
});

test('the timeout exit says it is a timeout rather than a failure', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-timeoutmsg-'));
  const doc = path.join(d, 'quiet.md');
  fs.writeFileSync(doc, '# Quiet\n');
  fs.writeFileSync(doc + '.sidecar.json', JSON.stringify({ schema: 1, items: [] }));
  const r = dirCli(['wait', doc, '--timeout', '1'], d);
  assert.equal(r.status, 1, 'exit 1 is the contract and does not move');
  assert.match(r.stdout, /still watching/, 'the phrase agents match on stays');
  assert.match(r.stdout, /The timeout expired, nothing was missed and nothing advanced/);
  assert.match(r.stdout, /DONE: false/);
  fs.rmSync(d, { recursive: true, force: true });
});


/* ────────────────────────────────────────────────────────────────────────────
   THE THEME
   The palette is declared twice — once under the system's preference, once
   under an explicit choice — so the pair is asserted to say the same thing.
   Below that, the stamp that runs in <head> before the first paint, driven
   with its own localStorage so the private-mode throw is exercised too.
   ──────────────────────────────────────────────────────────────────────────── */

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const STYLE = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));

// One declaration block → { '--token': 'value' }. Comments go first, or a token named inside one
// would be read as a declaration.
function decls(block) {
  const out = {};
  for (const line of block.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const m = line.match(/(--[a-z0-9-]+)\s*:\s*([\s\S]+)/i);
    if (m) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  }
  return out;
}
const grab = (re, what) => {
  const m = STYLE.match(re);
  assert.ok(m, `the ${what} block is still findable`);
  return decls(m[1]);
};
// The stylesheet's :root carries the LAYOUT tokens and no colour at all: the two panel widths, the
// measure, the prose size, the six type steps, the three radii and the caps tracking.
const ROOT = grab(/\n {2}:root \{\n([\s\S]*?)\n {2}\}\n/, 'root token');
// The palette itself — the SAME file index.html loads in <head> and server.js requires, so what these
// tests read is what the page paints and what a theme file is validated against.
const Themes = require('./public/themes.js');
// What a rule on a light page actually resolves against: paper's colours over :root's sizes. The scale
// tests below read the sizes out of it and the palette tests read the colours, which is how both halves
// are asserted against one object the way the browser sees one cascade.
const LIGHT = { ...ROOT, ...Themes.BUILTIN.paper.tokens };
const DARK_ATTR = Themes.BUILTIN.ink.tokens;
const BUILTINS = Object.entries(Themes.BUILTIN);

test('every built-in declares every token, and nothing that is not one', () => {
  // The palette used to be declared three times in CSS and this test's whole job was keeping the copies
  // identical. It is declared once per theme now, so the job is that a theme is COMPLETE: a built-in
  // with a token missing would fall back to paper's for that one value and read as a bug in whatever
  // rule happened to use it.
  assert.equal(Themes.TOKENS.length, 50, 'the token list is the palette, not a subset of it');
  assert.equal(BUILTINS.length, 8, 'four light, four dark');
  for (const [id, t] of BUILTINS) {
    assert.ok(['light', 'dark'].includes(t.scheme), `${id} says which way round it is`);
    assert.ok(typeof t.name === 'string' && t.name, `${id} has a name to show in the menu`);
    for (const k of Themes.TOKENS) {
      assert.ok(k in t.tokens, `${id} declares ${k}`);
      assert.ok(Themes.validValue(t.tokens[k]), `${id}'s ${k} passes the same grammar a user's file does`);
    }
    for (const k of Object.keys(t.tokens)) assert.ok(Themes.TOKENS.includes(k), `${id}'s ${k} is a real token`);
  }
  // The grammar takes any comma-separated run of numbers, because that is what a shadow is. A COLOUR
  // function is narrower, and a generated palette got this wrong: an alpha of 0 came out as
  // `rgba(253,248,234,)`, which every browser drops on the floor and no test could see.
  for (const [id, t] of BUILTINS) {
    for (const [k, v] of Object.entries(t.tokens)) {
      for (const fn of v.match(/(?:rgba?|hsla?)\([^()]*\)/g) || []) {
        const args = fn.slice(fn.indexOf('(') + 1, -1).split(/[,/\s]+/).filter(Boolean);
        assert.ok(args.length === 3 || args.length === 4, `${id}'s ${k} has ${args.length} arguments in ${fn}`);
        for (const a of args) assert.match(a, /^-?[\d.]+%?$/, `${id}'s ${k}: ${a} is a number`);
      }
    }
  }
  assert.equal(BUILTINS.filter(([, t]) => t.scheme === 'light').length, 4);
  assert.equal(Themes.DEFAULT.light, 'paper');
  assert.equal(Themes.DEFAULT.dark, 'ink');
  assert.deepEqual(Themes.ORDER.slice().sort(), Object.keys(Themes.BUILTIN).sort(),
    'the menu order lists every built-in and nothing else');
});

test('the three things that do not move between themes do not move in any of the eight', () => {
  // YELLOW = THE AGENT, one hex everywhere: an agent that changed colour with the room would stop being
  // a convention. An artboard is paper, because an asset is someone's own design built for a white
  // page. Both were rules about two themes and are now the price of admission for any theme.
  for (const [id, t] of BUILTINS) {
    assert.equal(t.tokens['--yellow'], '#ffeb00', `${id} keeps the agent's yellow`);
    assert.equal(t.tokens['--on-yellow'], '#2b2a20', `${id} keeps the ink that sits on it`);
    assert.equal(t.tokens['--asset-canvas'], '#ffffff', `${id} keeps an artboard white`);
    assert.match(t.tokens['--anchor-wash'], /^rgba\(255,235,0,/, `${id}'s anchor wash is the agent's`);
    assert.match(t.tokens['--flash-fill'], /^rgba\(255,235,0,/, `${id}'s jump flash is too`);
  }
});

test('every colour token has a dark value, and layout stays out of the palette', () => {
  // The layout tokens carry no colour and are the same in every theme, so they live on :root and must
  // not appear in a theme. The type scale (--t-*), the radius scale (--r-*) and the caps tracking join
  // --doc-space-* and --measure there for the same reason: a size is a size in both themes.
  const LAYOUT = new Set(['--spring-press', '--rail-w', '--nav-w', '--nav-track', '--track-caps',
    '--prose-size', '--prose-floor']);
  const isLayout = (k) => LAYOUT.has(k) || k.startsWith('--doc-space-') || k === '--measure'
    || /^--[tr]-/.test(k);
  for (const k of Object.keys(LIGHT)) {
    if (isLayout(k)) { assert.ok(!(k in DARK_ATTR), `${k} is layout and stays out of the palette`); continue; }
    assert.ok(k in DARK_ATTR, `${k} has a dark value`);
  }
  for (const k of Object.keys(DARK_ATTR)) assert.ok(k in LIGHT, `${k} is a real token, not a dark-only stray`);
  for (const k of Object.keys(ROOT)) assert.ok(isLayout(k), `${k} is on :root, so it had better be layout`);
  for (const [id, t] of BUILTINS) {
    for (const k of Object.keys(t.tokens)) assert.ok(!isLayout(k), `${id} does not carry the layout token ${k}`);
  }
});

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

test('no built-in ground is pure, and every dark one is genuinely dark', () => {
  // iA Writer's rule, asserted rather than trusted: no #ffffff page under black ink, no #000000 page
  // under white ink. It was a claim about paper and ink; every built-in answers to it now.
  for (const [id, t] of BUILTINS) {
    assert.notEqual(t.tokens['--ink'], '#000000', `${id}'s ink is not pure black`);
    assert.notEqual(t.tokens['--ink'], '#ffffff', `${id}'s ink is not pure white`);
    assert.notEqual(t.tokens['--bg'], '#000000', `${id}'s ground is not pure black`);
    assert.ok(contrast(t.tokens['--fg'], t.tokens['--bg']) > 7, `${id}'s body copy clears AAA on its own ground`);
    assert.ok(contrast(t.tokens['--muted'], t.tokens['--bg']) > 3, `${id}'s secondary text is still readable`);
    // --shell is a surface of its own in both directions: one step off the page, never equal to it.
    assert.notEqual(t.tokens['--shell'], t.tokens['--bg'], `${id}'s panel is a surface, not the page`);
    if (t.scheme === 'dark') {
      assert.ok(lum(t.tokens['--bg']) < 0.03, `${id}'s ground is a ground, not a mid grey`);
      assert.ok(lum(t.tokens['--shell']) > lum(t.tokens['--bg']), `${id}'s panel steps LIGHTER`);
    } else {
      assert.ok(lum(t.tokens['--bg']) > 0.7, `${id} is a light theme and reads like one`);
    }
  }
  // The high-contrast pair earns its name against the pair it sits beside.
  assert.ok(contrast(Themes.BUILTIN.contrast.tokens['--fg'], Themes.BUILTIN.contrast.tokens['--bg'])
    > contrast(LIGHT['--fg'], LIGHT['--bg']), 'contrast out-contrasts paper');
  assert.ok(contrast(Themes.BUILTIN['contrast-dark'].tokens['--fg'], Themes.BUILTIN['contrast-dark'].tokens['--bg'])
    > contrast(DARK_ATTR['--fg'], DARK_ATTR['--bg']), 'and contrast dark out-contrasts ink');
});

test('no colour is hard-coded in the stylesheet at all', () => {
  // The whole point of moving the palette into themes.js is that one file decides every colour. A hex
  // dropped into a rule is a thing no theme can move, so the stylesheet is scanned for them with the
  // one remaining token block removed. Two literals are allowed and both are named here: a mask reads
  // only alpha, and a shadow cast on the lightbox's own scrim never touches the page.
  let rest = STYLE.replace(/\/\*[\s\S]*?\*\//g, '');
  const before = rest.length;
  rest = rest.replace(/\n {2}:root \{\n[\s\S]*?\n {2}\}\n/, '');
  assert.ok(rest.length < before, 'the token block was found and removed before the scan');
  const ALLOWED = ['#000 22px', '#000 22px', 'rgba(0,0,0,.45)'];
  const found = rest.match(/#[0-9a-f]{3,8}\b[^;,)]*|rgba?\([0-9.,\s]+\)/gi) || [];
  const stray = found.filter(f => !ALLOWED.includes(f.trim()));
  assert.deepEqual(stray, [], 'every colour in a rule comes from a token');
  // And the dark palette is gone from the CSS rather than merely unused: a second copy of it here is a
  // second thing to keep in step with themes.js.
  assert.doesNotMatch(STYLE, /:root\[data-theme="dark"\] \{/, 'no dark token block survives in the CSS');
  assert.doesNotMatch(STYLE, /prefers-color-scheme/, 'and no media query answers the question either');
});

/* ────────────────────────────────────────────────────────────────────────────
   A THEME FILE IS SOMETHING A STRANGER WROTE
   Every value in one ends up inside a custom property that rules all over the
   page read, so the validator is a security boundary rather than a courtesy.
   It is a parser, not a filter: a value is a hex, an rgb()/hsl(), a length or
   a bare keyword, in any comma- or space-separated combination. Anything else
   is not a value, which is why nothing below needs a blocklist to fail.
   ──────────────────────────────────────────────────────────────────────────── */

test('the value grammar takes colours, lengths and shadows', () => {
  for (const v of ['#fff', '#ffeb00', '#ffffffaa', 'rgba(20,20,15,.08)', 'rgb(255 255 0 / 50%)',
    'hsl(45,100%,50%)', 'transparent', 'currentColor', '0px', '99px', '.06em', '50%',
    '0 1px 2px rgba(20,20,15,.05), 0 10px 30px -20px rgba(20,20,15,.35)',
    '0 0 0 3px rgba(255,255,255,.14)']) {
    assert.ok(Themes.validValue(v), `${v} is a value`);
  }
});

test('the validator refuses a value that is trying to be something else', () => {
  const bad = [
    'url(https://tracker.example/p.gif)',                 // the one function worth naming: it fetches
    'url("data:image/svg+xml,<svg/>")',
    'image-set("a.png" 1x)',
    'red; } body { display:none } .x {',                  // escaping the declaration
    '#fff</style><script>alert(1)</script>',              // escaping the element
    '#fff" onload="alert(1)',
    'expression(alert(1))',
    'rgba(0,0,0,.5) /* */ url(x)',
    'var(--bg)',                                          // no indirection: a value is a value
    'attr(data-x)',
    '',
    '   ',
    123,
    null,
    { toString() { return '#fff'; } },
  ];
  for (const v of bad) assert.equal(Themes.validValue(v), false, `${String(v)} is not a value`);
  assert.equal(Themes.validValue('#fff '.repeat(60)), false, 'nor a wall of them');
});

test('a colour function is parsed, not pattern-matched at the character level', () => {
  // The grammar used to accept anything made of digits, commas, percent signs and slashes inside the
  // parens, which said yes to three things that are not colours. The browser drops each of them, so the
  // token goes silently missing from a page instead of the file being refused by name.
  for (const v of ['rgb()', 'rgba(,,,,)', 'hsl(/)', 'rgb(1,2)', 'rgb(1,2,3,4)', 'rgba(1,2,3)',
    'rgb(1 2 3 4)', 'rgb(a,b,c)', 'hsl(1,2,3,4,5)', 'rgb(1,2,3 / .5 / .2)', 'rgb(1,2,3/)',
    'lab(50% 40 59)', 'color(display-p3 1 0 0)']) {
    assert.equal(Themes.validValue(v), false, `${v} is not a colour`);
  }
  // Both syntaxes of all four functions, which is what the built-ins and a hand-written file use.
  for (const v of ['rgb(0,0,0)', 'rgb(255 255 255)', 'rgba(20,20,15,.08)', 'rgb(255 255 0 / 50%)',
    'hsl(45,100%,50%)', 'hsl(210deg 40% 96%)', 'hsla(0,0%,0%,0.5)', 'hsl(210deg 40% 96% / .4)']) {
    assert.ok(Themes.validValue(v), `${v} is a colour`);
  }
});

test('a theme file is an object with a name, a scheme and tokens', () => {
  assert.match(Themes.validate('a string').error, /JSON object/);
  assert.match(Themes.validate(null).error, /JSON object/);
  assert.match(Themes.validate([{ name: 'x' }]).error, /JSON object/, 'an array is not an object');
  assert.match(Themes.validate({ name: 'x', scheme: 'light' }).error, /tokens/);
  assert.match(Themes.validate({ name: 'x', scheme: 'light', tokens: [] }).error, /tokens/);
  assert.match(Themes.validate({ name: 'x', scheme: 'beige', tokens: {} }).error, /light.*dark/);
  assert.match(Themes.validate({ name: '<script>', scheme: 'light', tokens: {} }).error, /name/);
  assert.match(Themes.validate({ name: 'x', scheme: 'light', tokens: { '--bg': 'url(x)' } }).error,
    /--bg is not a colour/, 'a bad value names the token, since a human is editing this file');
  // Unknown tokens are DROPPED rather than fatal: a token renamed in a later version must not turn
  // every theme on somebody's disk into an error.
  const ok = Themes.validate({ name: 'mine', scheme: 'dark', tokens: { '--bg': '#101010', '--nope': 'url(x)' } });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.theme, { name: 'mine', scheme: 'dark', tokens: { '--bg': '#101010' } });
});

test('a theme with three colours in it is a whole palette by the time it is applied', () => {
  // Missing tokens fall back to the built-in of the SAME scheme, which is what makes the format worth
  // hand-editing: a file that changes the ground and the ink is a theme.
  const t = { name: 'mine', scheme: 'dark', tokens: { '--bg': '#101010' } };
  const r = Themes.resolve(t);
  assert.equal(Object.keys(r).length, Themes.TOKENS.length);
  assert.equal(r['--bg'], '#101010', 'what the file said');
  assert.equal(r['--fg'], Themes.BUILTIN.ink.tokens['--fg'], 'and ink for everything it did not');
  assert.equal(Themes.resolve({ scheme: 'light', tokens: {} })['--fg'], Themes.BUILTIN.paper.tokens['--fg']);
  // resolve is also the last gate: a value that got past the file (it did not) cannot reach the page.
  assert.equal(Themes.resolve({ scheme: 'light', tokens: { '--bg': 'url(x)' } })['--bg'], '#ffffff');
});

test('applying a theme writes inline properties, the scheme and color-scheme', () => {
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  Themes.apply(doc.documentElement, Themes.BUILTIN['slate-dark']);
  const style = doc.documentElement.getAttribute('style');
  for (const k of Themes.TOKENS) {
    assert.equal(doc.documentElement.style.getPropertyValue(k),
      Themes.BUILTIN['slate-dark'].tokens[k], k + ' is on the element');
  }
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark',
    'the RESOLVED scheme, which is what the wordmark inversion reads');
  assert.match(style, /color-scheme: ?dark/, 'and native controls follow');
  assert.doesNotMatch(style, /url\(|<|>/, 'nothing reaches the attribute that was not a token value');
  Themes.apply(doc.documentElement, Themes.BUILTIN.sepia);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light', 'and it moves back');
  assert.equal(doc.documentElement.style.getPropertyValue('--bg'), Themes.BUILTIN.sepia.tokens['--bg']);
});

/* ────────────────────────────────────────────────────────────────────────────
   THE THEMES DIRECTORY
   The fixture root keeps a `.sidecar` directory, so the server puts its themes
   inside it — which is the branch that also makes a theme file openable in
   sidecar. The XDG fallback is asserted against its own server below, because
   the one thing a test must never do is write into somebody's real home.
   ──────────────────────────────────────────────────────────────────────────── */

// realpathSync, because the server canonicalizes its root at boot and macOS puts /private in front of
// every /var/folders temp dir. Comparing the two spellings is how this read as a bug in the location.
const themesDir = () => path.join(fs.realpathSync(dir), '.sidecar', 'themes');
const writeTheme = (name, body) => fs.writeFileSync(path.join(themesDir(), name),
  typeof body === 'string' ? body : JSON.stringify(body, null, 2));

test('the themes directory sits beside the root\'s own .sidecar state', async () => {
  const d = await fetchRetry(`${BASE}/api/themes`).then(j);
  assert.equal(d.dir, themesDir(), 'inside the served root, because this root keeps a .sidecar');
  assert.ok(fs.existsSync(d.dir), 'and it exists, so there is somewhere to put a file');
});

test('the api lists a theme file, and hands back the path that opens it', async () => {
  writeTheme('midnight.json', { name: 'midnight', scheme: 'dark', tokens: { '--bg': '#0b0c14' } });
  const d = await fetchRetry(`${BASE}/api/themes`).then(j);
  const t = d.themes.find(x => x.id === 'user:midnight.json');
  assert.ok(t, 'the file is listed under an id that cannot collide with a built-in');
  assert.equal(t.name, 'midnight');
  assert.equal(t.scheme, 'dark');
  assert.deepEqual(t.tokens, { '--bg': '#0b0c14' }, 'only what the file actually said');
  assert.equal(t.rel, path.join('.sidecar', 'themes', 'midnight.json'),
    'under the served root, so the page can open it as a document');
});

test('a file that is not a theme is reported rather than swallowed', async () => {
  writeTheme('broken.json', '{ not json');
  writeTheme('hostile.json', { name: 'hostile', scheme: 'light', tokens: { '--bg': 'url(https://x/p.gif)' } });
  writeTheme('array.json', [1, 2, 3]);
  const d = await fetchRetry(`${BASE}/api/themes`).then(j);
  const err = (f) => (d.errors.find(e => e.file === f) || {}).error;
  assert.match(err('broken.json'), /not valid JSON/);
  assert.match(err('hostile.json'), /--bg is not a colour/, 'the token is named, since a human is editing it');
  assert.match(err('array.json'), /JSON object/);
  for (const f of ['broken.json', 'hostile.json', 'array.json']) {
    assert.ok(!d.themes.some(t => t.id === 'user:' + f), f + ' is not offered as a theme');
    fs.unlinkSync(path.join(themesDir(), f));
  }
});

test('sidecar\'s own state beside a theme is not a theme that failed to parse', async () => {
  // The themes directory sits inside `.sidecar` when the root keeps one, and a theme opened in sidecar
  // grows a review right beside it. Scanning every non-hidden `*.json` reported each of those as a
  // broken theme, so commenting on a theme put an error in the theme menu.
  writeTheme('midnight.json.sidecar.json', { schema: 1, items: [] });
  writeTheme('midnight.json.sidecar.seen.json', { claude: {} });
  const d = await fetchRetry(`${BASE}/api/themes`).then(j);
  for (const f of ['midnight.json.sidecar.json', 'midnight.json.sidecar.seen.json']) {
    assert.ok(!d.errors.some(e => e.file === f), f + ' is state, not a theme somebody got wrong');
    assert.ok(!d.themes.some(t => t.id === 'user:' + f));
    fs.unlinkSync(path.join(themesDir(), f));
  }
  assert.ok(d.themes.some(t => t.id === 'user:midnight.json'), 'and the theme beside them still lists');
});

test('a sidecar file in the themes directory is not a document either', async () => {
  // The same predicate on the other side: the CLI and the server accept exactly the same files.
  writeTheme('stray.md.sidecar.json', { schema: 1, items: [] });
  const rel = path.join('.sidecar', 'themes', 'stray.md.sidecar.json');
  const r = await fetchRetry(`${BASE}/api/state?path=${encodeURIComponent(rel)}`);
  assert.equal(r.status, 400);
  fs.unlinkSync(path.join(themesDir(), 'stray.md.sidecar.json'));
});

test('customize writes a copy of the theme and never overwrites the last one', async () => {
  const body = { name: 'sepia', scheme: 'light', tokens: Themes.BUILTIN.sepia.tokens };
  const r = await post('/api/themes', body).then(j);
  assert.equal(r.id, 'user:sepia-custom.json');
  assert.equal(r.rel, path.join('.sidecar', 'themes', 'sepia-custom.json'));
  const written = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(written.name, 'sepia');
  assert.equal(Object.keys(written.tokens).length, Themes.TOKENS.length,
    'every token spelled out, so the file a human opens is the whole palette');
  assert.equal(written.tokens['--yellow'], '#ffeb00');
  // A second customize is a second file, because the first one is somebody's evening of tuning.
  const again = await post('/api/themes', body).then(j);
  assert.equal(again.id, 'user:sepia-custom-2.json');
  fs.unlinkSync(again.file);
});

test('when there is no free number left, customize refuses rather than overwriting one', async () => {
  // The search for a free name stopped at the bound and then wrote anyway, which made the last numbered
  // copy the one file customize destroyed instead of adding to.
  const stem = 'crowded-custom';
  const names = ['crowded-custom.json'];
  for (let n = 2; n <= 100; n++) names.push(`${stem}-${n}.json`);
  for (const n of names) writeTheme(n, { name: 'crowded', scheme: 'light', tokens: {} });
  const before = names.map(n => fs.readFileSync(path.join(themesDir(), n), 'utf8'));
  const r = await post('/api/themes', { name: 'crowded', scheme: 'light', tokens: { '--bg': '#010203' } });
  assert.equal(r.status, 409);
  assert.match((await j(r)).error, /already in/);
  names.forEach((n, i) => assert.equal(fs.readFileSync(path.join(themesDir(), n), 'utf8'), before[i],
    n + ' is untouched, because a refusal writes nothing'));
  assert.ok(!fs.existsSync(path.join(themesDir(), `${stem}-101.json`)), 'and nothing new appears either');
  // One free slot is enough: the same request now lands in it.
  fs.unlinkSync(path.join(themesDir(), `${stem}-50.json`));
  const ok = await post('/api/themes', { name: 'crowded', scheme: 'light', tokens: { '--bg': '#010203' } }).then(j);
  assert.equal(ok.id, `user:${stem}-50.json`);
  for (const n of names) fs.rmSync(path.join(themesDir(), n), { force: true });
});

test('the write route is the same door a file on disk goes through', async () => {
  const bad = await post('/api/themes', { name: 'x', scheme: 'light', tokens: { '--bg': 'url(x)' } });
  assert.equal(bad.status, 400);
  assert.match((await j(bad)).error, /--bg is not a colour/);
  assert.equal((await post('/api/themes', { name: 'x' })).status, 400);
  assert.equal((await post('/api/themes', [1, 2])).status, 400);
  // A name that is a path is a name: the slug it lands under has no separators left in it.
  const r = await post('/api/themes', { name: 'a b', scheme: 'light', tokens: {} }).then(j);
  assert.equal(path.basename(r.file), 'a-b-custom.json');
  assert.equal(path.dirname(r.file), themesDir(), 'and it lands in the themes directory, nowhere else');
  fs.unlinkSync(r.file);
  assert.equal((await post('/api/themes', { name: '../../etc/pwn', scheme: 'light', tokens: {} })).status, 400,
    'a name full of separators is refused as a name before it is ever a path');
});

test('a theme file under the root opens in sidecar, as a fenced code block', async () => {
  const rel = path.join('.sidecar', 'themes', 'midnight.json');
  const s = await fetchRetry(`${BASE}/api/state?path=${encodeURIComponent(rel)}`).then(j);
  assert.equal(s.kind, 'markdown', 'so the viewer builds the surface it knows how to edit');
  assert.match(s.markdown, /^```json\n\{/, 'the bytes arrive inside a fence');
  assert.match(s.markdown, /\n```\n$/);
  // Saving it writes the JSON back out, fence removed, and the hash the client holds still matches.
  const edited = s.markdown.replace('#0b0c14', '#141c0b');
  const r = await put('/api/save', { path: rel, content: edited, baseHash: s.hash });
  assert.equal(r.status, 200);
  const raw = fs.readFileSync(path.join(dir, rel), 'utf8');
  assert.match(raw, /^\{/, 'what lands on disk is JSON, not markdown');
  assert.equal(JSON.parse(raw).tokens['--bg'], '#141c0b');
  assert.equal((await j(r)).hash, sha_of('```json\n' + raw.trim() + '\n```\n'), 'and the next baseHash matches');
  // The optimistic lock still bites on a stale save.
  assert.equal((await put('/api/save', { path: rel, content: edited, baseHash: s.hash })).status, 409);
});

test('a CRLF theme file survives open, edit and save', async () => {
  // /api/save rewrites every newline to the file's own ending before the fence comes off, so a CRLF
  // theme reached the unfencer with CRLF fence lines — which an LF-only pattern did not match. The
  // fence was then written into the .json, and the theme was dead on the next read.
  const raw = JSON.stringify({ name: 'crlf', scheme: 'dark', tokens: { '--bg': '#0b0c14' } }, null, 2)
    .replace(/\n/g, '\r\n') + '\r\n';
  fs.writeFileSync(path.join(themesDir(), 'crlf.json'), raw);
  const rel = path.join('.sidecar', 'themes', 'crlf.json');
  const s = await fetchRetry(`${BASE}/api/state?path=${encodeURIComponent(rel)}`).then(j);
  assert.equal(s.kind, 'markdown');
  assert.match(s.markdown, /^```json\r\n\{/, 'the fence takes the file\'s own line ending');
  // The client sends what marked and the serializer produce, which is all-LF, plus the edit.
  const edited = s.markdown.replace(/\r\n/g, '\n').replace('#0b0c14', '#141c0b');
  const r = await put('/api/save', { path: rel, content: edited, baseHash: s.hash });
  assert.equal(r.status, 200);
  const saved = fs.readFileSync(path.join(themesDir(), 'crlf.json'), 'utf8');
  assert.ok(!/```/.test(saved), 'no fence is written into the file');
  assert.equal(JSON.parse(saved).tokens['--bg'], '#141c0b', 'and it is still JSON, with the edit in it');
  assert.ok(saved.includes('\r\n'), 'CRLF endings preserved');
  assert.ok(!saved.replace(/\r\n/g, '').includes('\n'), 'no lone \\n left, the trailing one included');
  assert.equal((await j(r)).hash, sha_of('```json\r\n' + saved.replace(/\s+$/, '') + '\r\n```\r\n'),
    'and the next baseHash matches the fenced form the client holds');
  // The proof that matters: it is still a theme.
  const d = await fetchRetry(`${BASE}/api/themes`).then(j);
  const t = d.themes.find(x => x.id === 'user:crlf.json');
  assert.ok(t, 'the file is still read as a theme');
  assert.deepEqual(t.tokens, { '--bg': '#141c0b' });
  // A second save from the state the client now holds still locks and still round-trips.
  const s2 = await fetchRetry(`${BASE}/api/state?path=${encodeURIComponent(rel)}`).then(j);
  assert.equal(s2.hash, (await fetchRetry(`${BASE}/api/state?path=${encodeURIComponent(rel)}`).then(j)).hash);
  const r2 = await put('/api/save', { path: rel, content: s2.markdown.replace(/\r\n/g, '\n')
    .replace('#141c0b', '#0c1410'), baseHash: s2.hash });
  assert.equal(r2.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(themesDir(), 'crlf.json'), 'utf8')).tokens['--bg'], '#0c1410');
  fs.unlinkSync(path.join(themesDir(), 'crlf.json'));
});

test('a .json that is not in the themes directory is still not a document', async () => {
  fs.writeFileSync(path.join(dir, 'notatheme.json'), '{}');
  const r = await fetchRetry(`${BASE}/api/state?path=notatheme.json`);
  assert.equal(r.status, 400, 'or every doc.md.sidecar.json in the tree would be a document');
  const d = await fetchRetry(`${BASE}/api/dir?path=`).then(j);
  assert.ok(!d.docs.some(x => x.rel.endsWith('.json')), 'and the folder panel lists none of them');
  fs.unlinkSync(path.join(dir, 'notatheme.json'));
});

test('with no .sidecar in the root, themes live under the config directory', async () => {
  // The default for most installs, and the one place a test must not be casual: it runs against its own
  // XDG_CONFIG_HOME so nothing is ever written into a real home.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-xdg-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-plain-'));
  fs.writeFileSync(path.join(root, 'doc.md'), '# Doc\n');
  const port = PORT + 3;
  const p = spawn('node', [path.join(__dirname, 'server.js'), root],
    { env: { ...process.env, SIDECAR_PORT: port, XDG_CONFIG_HOME: home, SIDECAR_THEMES: '' }, stdio: 'pipe' });
  try {
    await new Promise((res, rej) => {
      p.stdout.on('data', (d) => { if (d.toString().includes('ready')) res(); });
      p.on('exit', () => rej(new Error('server died')));
      setTimeout(() => rej(new Error('never ready')), 8000);
    });
    const d = await fetch(`http://127.0.0.1:${port}/api/themes`).then(j);
    assert.equal(d.dir, path.join(home, 'sidecar', 'themes'));
    assert.ok(fs.existsSync(d.dir), 'created at boot, so there is somewhere to put a file');
    assert.deepEqual(d.themes, []);
    // Outside the served root there is no path sidecar can serve, so the page is told where it is.
    const r = await fetch(`http://127.0.0.1:${port}/api/themes`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ink', scheme: 'dark', tokens: {} }) }).then(j);
    assert.equal(r.rel, null, 'and the toast prints the path instead of opening it');
    assert.equal(r.file, path.join(home, 'sidecar', 'themes', 'ink-custom.json'));
  } finally {
    p.kill();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   ONE TYPE SCALE, ONE RADIUS SCALE
   The chrome once carried seventeen font sizes and fourteen radii, each one
   argued for in a comment of its own. Every one of them is a token now, and
   this is what stops the next good argument putting a nineteenth back.
   ──────────────────────────────────────────────────────────────────────────── */

// The stylesheet as innermost rules: comments gone, `selector` and the declarations inside its
// braces. An @media wrapper never matches (its body holds braces), so what comes back is the rules
// themselves, each carrying whatever selector list was written above it.
const RULES = (() => {
  const src = STYLE.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...src.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
})();

// The mobile block on its own, brace-matched from its own opening brace so the 540px query nested
// inside it rides along. Read as rules the same way, so a declaration can be attributed to the
// breakpoint that carries it rather than to the stylesheet at large.
const MOBILE = (() => {
  const src = STYLE.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = src.indexOf('@media (max-width: 780px) {');
  assert.ok(at > -1, 'the mobile block is still findable');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('the mobile block never closes');
})();
const MOBILE_RULES = [...MOBILE.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map(m => ({ sel: m[1].trim(), body: m[2] }));

// The tokens as DECLARED, rather than a shape a token name happens to fit: `var(--t-7)` matches the
// pattern, resolves to nothing, and takes the whole declaration down with it.
const TYPE_STEPS = Object.keys(LIGHT).filter(k => /^--t-\d+$/.test(k));
const RADIUS_STEPS = Object.keys(LIGHT).filter(k => /^--r-/.test(k));
const tokenOf = (v) => (v.trim().match(/^var\((--[a-z0-9-]+)\)$/) || [])[1] || null;

// A `font:` shorthand read into its parts: [style variant weight stretch] size[/line-height] family.
// The size is the first length or var() in it, the weight can only sit before that, and the
// line-height is whatever follows the slash. `font:inherit` carries none of the three.
function shorthand(v) {
  const lh = v.match(/\/\s*([^\s;]+)/);
  const parts = v.replace(/\/\s*[^\s;]+/, '').trim().split(/\s+/);
  const at = parts.findIndex(p => /^var\(--[a-z0-9-]+\)$/.test(p) || /^[\d.]+(?:px|r?em|%)$/.test(p));
  const before = at === -1 ? [] : parts.slice(0, at);
  return {
    size: at === -1 ? null : parts[at],
    weight: before.find(p => /^\d+$/.test(p) || ['bold', 'bolder', 'lighter', 'normal'].includes(p)) || null,
    height: lh ? lh[1] : null,
  };
}
const shorthands = (body) => [...body.matchAll(/(?:^|[;{\s])font:\s*([^;]+)/g)].map(m => m[1].trim());

test('the chrome type scale is six steps, and none of them is half a pixel', () => {
  const steps = Object.keys(LIGHT).filter(k => /^--t-\d$/.test(k));
  assert.deepEqual(steps, ['--t-1', '--t-2', '--t-3', '--t-4', '--t-5', '--t-6'],
    'six steps, numbered; a seventh is a new decision and has to be argued for here first');
  let last = 0;
  for (const k of steps) {
    const px = Number(LIGHT[k].replace('px', ''));
    assert.ok(Number.isInteger(px), `${k} is a whole pixel`);
    assert.ok(px > last, `${k} is a step UP from the one below it`);
    last = px;
  }
  const radii = Object.keys(LIGHT).filter(k => /^--r-/.test(k));
  assert.deepEqual(radii, ['--r-1', '--r-2', '--r-3', '--r-pill'], 'three radii and the pill');
  assert.equal(LIGHT['--r-pill'], '99px', 'the pill is a pill');
});

test('the three fields a phone can focus are pinned to a step iOS will not zoom into', () => {
  // iOS Safari zooms into a focused field whose text is under 16px and never zooms back out. A step
  // reaching 16px somewhere on the scale proves nothing on its own: what matters is that the three
  // focusable fields read that step below the breakpoint, so each one is found in the mobile block
  // and the step it names is resolved to its own declared value.
  const FIELDS = {
    '.reply': 'the reply box under a card',
    '#popover textarea': "the popover's textarea",
    '#seltool input': 'the link input in the selection toolbar',
  };
  const targets = (sel, field) => sel.split(',')
    .map(s => s.trim().replace(/\s+/g, ' '))
    .some(s => s === field || s.endsWith(` ${field}`));
  for (const [field, what] of Object.entries(FIELDS)) {
    const sizes = [];
    for (const { sel, body } of MOBILE_RULES) {
      if (!targets(sel, field)) continue;
      for (const m of body.matchAll(/font-size:\s*([^;]+)/g)) sizes.push(m[1].trim());
      for (const v of shorthands(body)) if (shorthand(v).size) sizes.push(shorthand(v).size);
    }
    assert.ok(sizes.length, `${what} (${field}) is given a size below the breakpoint`);
    for (const size of sizes) {
      const token = tokenOf(size);
      assert.ok(token && TYPE_STEPS.includes(token), `${what} names a declared step, not ${size}`);
      const px = Number(LIGHT[token].replace('px', ''));
      assert.ok(px >= 16, `${what} reads ${token}, which is ${LIGHT[token]}, and iOS zooms below 16px`);
    }
  }
});

test('every chrome font-size comes from the type scale', () => {
  // #doc is exempt and must stay exempt: prose was tuned on its own scale (16.5px body, 28/21/17
  // headings) against a measure this chrome has nothing to do with. Two scales, one per surface.
  // Everything else names a step. Two literals survive and both are here with their reason.
  const EXCEPT = {
    'font-size:.82em': "the docs link's arrow is sized to the word it follows, whatever that word is",
  };
  const stray = [];
  const step = (v) => TYPE_STEPS.includes(tokenOf(v));   // declared, so `var(--t-7)` is not one
  for (const { sel, body } of RULES) {
    if (sel.includes('#doc')) continue;
    for (const m of body.matchAll(/font-size:\s*([^;]+)/g)) {
      const decl = `font-size:${m[1].trim()}`;
      if (step(m[1]) || decl in EXCEPT) continue;
      stray.push(`${sel} → ${decl}`);
    }
    // The `font:` shorthand carries a size too, and it is read out of the shorthand rather than
    // looked for anywhere in it: a token that resolves to nothing invalidates the whole declaration,
    // so `var(--t-7)` has to fail here rather than pass on the strength of the three letters.
    // `inherit` carries no size and is how a textarea keeps the page's family before pinning a step.
    for (const v of shorthands(body)) {
      if (v === 'inherit' || (shorthand(v).size && step(shorthand(v).size))) continue;
      stray.push(`${sel} → font:${v}`);
    }
  }
  assert.deepEqual(stray, [], 'each of these is a size the eye has to learn on its own');
});

test('every border-radius comes from the radius scale', () => {
  // This one covers #doc as well: a code block, an image and the asset frame are boxes, not prose,
  // and a corner is a corner wherever it is drawn. `50%` is a circle rather than a step on the
  // scale, and `0` is the absence of one.
  // Same rule as the type scale: the token has to be one that is DECLARED, not one that is spelled
  // like a radius. `var(--r-4)` resolves to nothing and squares the corner it was meant to round.
  const ok = (part) => RADIUS_STEPS.includes(tokenOf(part)) || part === '50%' || part === '0';
  const stray = [];
  for (const { sel, body } of RULES) {
    for (const m of body.matchAll(/border-radius:\s*([^;]+)/g)) {
      const parts = m[1].trim().split(/\s+/);
      if (parts.every(ok)) continue;
      stray.push(`${sel} → border-radius:${m[1].trim()}`);
    }
  }
  assert.deepEqual(stray, [], 'each of these is a corner that belongs to nothing');
});

test('the chrome rests on three line heights and three weights', () => {
  // Longhand and shorthand both, because half the chrome sets its weight and leading inside a
  // `font:` and a rule that reads only `font-weight:` and `line-height:` cannot see any of it.
  // 0 is an icon button collapsing its line box, and is the one ratio that is not a reading measure.
  const heights = new Set(), weights = new Set();
  const centred = [];
  for (const { sel, body } of RULES) {
    if (sel.includes('#doc') || sel.includes('@font-face')) continue;
    for (const m of body.matchAll(/line-height:\s*([^;]+)/g)) heights.add(m[1].trim());
    for (const m of body.matchAll(/font-weight:\s*([^;]+)/g)) weights.add(m[1].trim());
    for (const v of shorthands(body)) {
      const { weight, height } = shorthand(v);
      if (weight) weights.add(weight);
      if (height === null) continue;
      // A line-height in pixels is geometry rather than a reading measure: it centres a number in a
      // round badge. That is allowed exactly where the same rule gives the badge the height it is
      // centring against, which is what makes it geometry and not a fourth leading.
      if (/^\d+px$/.test(height)) {
        assert.match(body, new RegExp(`(?:^|[;{\\s])height:${height}[;\\s]`),
          `${sel} centres its number on a height the same rule sets`);
        centred.push(sel);
        continue;
      }
      heights.add(height);
    }
  }
  assert.ok(centred.length >= 3, 'the badges that centre a number on their own height are still here');
  heights.delete('0');
  assert.deepEqual([...heights].sort(), ['1', '1.45', '1.6'],
    'one tight, one for UI text, one for body and mono');
  assert.deepEqual([...weights].sort(), ['400', '500', '600'], 'and three weights, no more');
});

test('one tracking for every uppercase micro-label', () => {
  // Six labels doing one job wore .03em, .05em, .06em, .13em and two more. They share a token now,
  // so the next one written cannot invent a seventh value.
  assert.match(LIGHT['--track-caps'], /^\.\d+em$/, 'the token is there and is a tracking');
  assert.ok(STYLE.split('letter-spacing:var(--track-caps)').length - 1 >= 3,
    'and the labels that were tracked by hand read it instead');
  // A label that sets a tracking sets the token, or the explicit 0 that resets it on a count inside
  // one.
  for (const { sel, body } of RULES) {
    if (!/text-transform:\s*uppercase/.test(body)) continue;
    for (const m of body.matchAll(/letter-spacing:\s*([^;]+)/g)) {
      assert.ok(['var(--track-caps)', '0'].includes(m[1].trim()),
        `${sel} tracks through the token, not by hand`);
    }
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   THE ANCHOR MARK, AND WHERE THE RAIL'S DENSITY IS KEPT
   The mark rests as a wash and takes its underline back on hover; the density
   is a preference like the two panel widths and goes through the same store.
   ──────────────────────────────────────────────────────────────────────────── */

test('an anchored span is a wash at rest and takes its underline back on hover', () => {
  // #ffeb00 as a 2px rule under prose was the highest-energy element on a near-monochrome page. What
  // replaced it must still cost the line box nothing, so the border stays (transparent) rather than
  // being added on hover, and the padding stays at zero.
  const rest = STYLE.match(/\n {2}mark\.anchor \{([\s\S]*?)\}/);
  assert.ok(rest, 'the mark rule is still findable');
  assert.match(rest[1], /background:var\(--anchor-wash\)/, 'the wash is the resting state');
  assert.match(rest[1], /border-bottom:2px solid transparent/, 'and the underline rests transparent');
  assert.match(rest[1], /padding:0/, 'no padding, or the paragraph reflows when a comment lands');
  assert.match(rest[1], /color:inherit/, "and the UA's own mark colour stays off");
  assert.doesNotMatch(rest[1], /border-bottom:2px solid var\(--yellow\)/, 'the solid rule is gone');
  // Both ends light it: the pointer over the span, and the pointer over its card (which sets .lit).
  assert.match(STYLE, /mark\.anchor:hover, mark\.anchor\.lit \{ border-bottom-color:var\(--yellow\); \}/);
  assert.match(STYLE, /mark\.anchor\.mine:hover, mark\.anchor\.mine\.lit \{ border-bottom-color:var\(--ink\); \}/);
  // The jump cue is unchanged.
  assert.match(STYLE, /mark\.anchor\.flash \{ background:var\(--flash-fill\)/);
});

test('the wash follows the dot convention and is retuned rather than reused in dark', () => {
  // Yellow is the agent's in both themes, but a 30% yellow over a near-black ground glows; the dark
  // palette carries its own alpha. The human's wash is an ink tint in light and a white one in dark,
  // because a tint of the ink is invisible on a ground the ink is lighter than.
  for (const k of ['--anchor-wash', '--anchor-wash-mine']) {
    assert.ok(k in LIGHT && k in DARK_ATTR, k + ' is declared in both palettes');
    assert.notEqual(LIGHT[k], DARK_ATTR[k], k + ' is retuned for the dark ground, not reused');
  }
  const alpha = (v) => Number(v.match(/([\d.]+)\)$/)[1]);
  assert.match(LIGHT['--anchor-wash'], /^rgba\(255,235,0,/, "claude's wash is the agent's yellow");
  assert.match(DARK_ATTR['--anchor-wash'], /^rgba\(255,235,0,/);
  assert.ok(alpha(DARK_ATTR['--anchor-wash']) < alpha(LIGHT['--anchor-wash']), 'quieter on dark');
  assert.ok(alpha(LIGHT['--anchor-wash']) <= 0.32, 'a wash, not a highlighter');
  assert.match(LIGHT['--anchor-wash-mine'], /^rgba\(20,20,15,/, 'yours is ink-tinted');
  assert.match(DARK_ATTR['--anchor-wash-mine'], /^rgba\(255,255,255,/, 'and inverts with the hairlines');
});

// The store, run with its own localStorage handed in, the same way the theme stamp below is, and for
// the same reason: the private-mode throw is only exercisable that way.
const UI_STORE = (() => {
  const m = PAGE.match(/const uiStore = \{\n([\s\S]*?)\n\};/);
  assert.ok(m, 'the one preference store is still in the page');
  return new Function('localStorage', 'return {\n' + m[1] + '\n};');
})();
const storeOver = (backing) => UI_STORE({
  getItem: (k) => (k in backing ? backing[k] : null),
  setItem: (k, v) => { backing[k] = String(v); },
});

test('the density is stored under the sc: prefix, beside every other preference', () => {
  const backing = {};
  const store = storeOver(backing);
  store.set('railDensity', 'full');
  assert.deepEqual(backing, { 'sc:railDensity': 'full' }, 'one key, prefixed like railWidth and theme');
  assert.equal(store.get('railDensity', ''), 'full', 'and it reads straight back');
});

test('a density round-trips through the store and the guard, junk and all', () => {
  // The store returns strings and knows nothing about densities; Turn.density is the guard. Together
  // they are what index.html runs at boot, so the pair is asserted rather than either half.
  const backing = {};
  const store = storeOver(backing);
  const read = () => Turn.density(store.get('railDensity', ''));
  assert.equal(read(), 'compact', 'an install that has never touched it rests at compact');
  for (const d of Turn.DENSITIES) { store.set('railDensity', d); assert.equal(read(), d, d); }
  store.set('railDensity', 'dense'); assert.equal(read(), 'compact', 'a value no control can name is the default');
});

test('a store that throws on every access still answers, and the rail still rests somewhere', () => {
  // Safari in private mode throws on setItem while getItem keeps answering null. Nothing about a
  // layout preference is worth an exception on the path that renders the review.
  const store = UI_STORE({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
  assert.doesNotThrow(() => store.set('railDensity', 'full'));
  assert.equal(store.get('railDensity', ''), '', 'the fallback comes back');
  assert.equal(Turn.density(store.get('railDensity', '')), 'compact', 'so the rail rests at compact');
});

test('the page reads and writes the density through that store and that guard', () => {
  assert.match(PAGE, /let railDensity = Turn\.density\(uiStore\.get\('railDensity', ''\)\);/,
    'one read at boot, guarded');
  assert.match(PAGE, /uiStore\.set\('railDensity', railDensity\);/, 'and the write is a mirror of it');
  // Shutting the panel is the header toggle's alone: no density leaves the rail without its cards.
  assert.doesNotMatch(PAGE, /Turn\.density\(railDensity\) === 'hidden'/, 'no branch still asks for the third state');
  assert.doesNotMatch(PAGE, /localStorage\.(get|set)Item\('sc:railDensity'/,
    'nothing reaches storage around the store');
});

test('the header title group holds the path and nothing else', () => {
  // A kind tag and a segmented zoom used to sit beside the path, and between them they covered the
  // filename the group exists to keep readable.
  const group = PAGE.match(/<div class="htitle">([\s\S]*?)<\/div>\s*<!-- Empty until an agent/);
  assert.ok(group, 'the title group is still there');
  assert.equal(group[1].trim(), '<div id="pwd"></div>', 'and the path is all it holds');
  assert.match(PAGE, /<button id="zoomToggle"[^>]*onclick="toggleAssetZoom\(\)"[^>]*hidden/, 'the zoom is one icon among the view controls, asset only');
  const paint = PAGE.match(/function paintZoom\(\) \{([\s\S]*?)\n\}/);
  assert.doesNotMatch(paint[1], /aria-label|\.title =/, 'its name is fixed in the markup; aria-pressed alone carries the state');
});

test('the header names the document and the panel holds the whole path', () => {
  // The title printed the full path, and the panel printed it again as a one-line breadcrumb clipped
  // to its last two segments. The name is the title now, the path is its hover, and the folder is a
  // menu that lists every level.
  assert.match(PAGE, /\$\('pwd'\)\.innerHTML = `<span class="file">/, 'the title is the filename');
  assert.match(PAGE, /\$\('pwd'\)\.title = p;/, 'and the whole path is its hover');
  // Exercised, not pattern-matched: the split has to find the name in a Windows path too, or the title
  // is the whole path again on the one platform that writes it with backslashes.
  const split = PAGE.match(/const i = (Math\.max\(p\.lastIndexOf[^;]+);/);
  assert.ok(split, 'the split is still one expression');
  const nameOf = new Function('p', 'const i = ' + split[1] + '; return i >= 0 ? p.slice(i + 1) : p;');
  assert.equal(nameOf('~/hq/vault/brief.md'), 'brief.md');
  assert.equal(nameOf('C:\\Users\\alex\\project\\brief.md'), 'brief.md');
  assert.equal(nameOf('brief.md'), 'brief.md');
  assert.doesNotMatch(PAGE, /id="navCrumb"/, 'the clipped breadcrumb is gone');
  assert.match(PAGE, /<div class="menu" id="navPathMenu" role="menu" hidden><\/div>/, 'the folder is a menu');
  assert.match(PAGE, /\$\('navPathMenu'\)\.addEventListener\('click'[\s\S]{0,200}loadDir\(b\.dataset\.dir\)/, 'and every level in it is live');
});

test('an asset hover never writes into the header', () => {
  // The label is as long as a sentence, and in the status slot it pushed every control in the bar to
  // the left and into the title. It is written to #hoverHint, which is fixed and moves nothing.
  const hover = PAGE.match(/case 'hover': \{([\s\S]*?)break;/);
  assert.ok(hover, 'the hover case is still there');
  assert.match(hover[1], /setHoverHint\(/, 'the label goes to the hint');
  assert.doesNotMatch(hover[1], /setStatus\(/, 'and never to the status slot');
  assert.match(PAGE, /#hoverHint \{ position:fixed;[^}]*pointer-events:none;/, 'fixed, and never the thing a pick lands on');
  assert.match(PAGE, /function resetDocState\(\) \{[\s\S]{0,400}?setHoverHint\(''\);/, 'and leaving the document clears it, since the old frame no longer can');
});

/* ────────────────────────────────────────────────────────────────────────────
   WHAT A COLLAPSED CARD STILL OWES THE THREAD
   A pill is a card with its body taken away, and two things that were living in
   that body have to outlive it: the reply the human has typed and not sent, and
   the agent composing an answer right now. Both are true of the THREAD, so
   neither can be kept in the element that stopped being drawn.
   ──────────────────────────────────────────────────────────────────────────── */

// One named function lifted out of the page and run with its collaborators handed in, the same way the
// preference store and the theme stamp are. Each of these is a rule the browser is not needed to judge.
const CARD_FN = (name, ...deps) => {
  const m = PAGE.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(m, name + ' is still one function in the page');
  return new Function(...deps, 'return ' + m[0]);
};
// A stand-in for a live reply box: the three things noteDraft reads off one, and the card it sits in.
const replyBox = (id, value) => ({
  value, selectionStart: value.length, selectionEnd: value.length,
  closest: () => (id ? { dataset: { id } } : null),
});

test('an unsent reply is kept against the thread id, not against the textarea', () => {
  // The bug this is here for: collapsing a card replaced its textarea with a pill, and a capture that
  // could only read live boxes had nothing to read, so the typed reply was discarded. The map is keyed
  // by item id and written from the box, which means the box is free to stop existing.
  const map = new Map();
  const note = CARD_FN('noteDraft', 'replyDrafts')(map);
  const card = note(replyBox('c1', 'half a thought'));
  assert.equal(card.dataset.id, 'c1', 'the card comes back so the caller can name the thread');
  assert.deepEqual([...map.keys()], ['c1']);
  assert.deepEqual(map.get('c1'), { value: 'half a thought', start: 14, end: 14 },
    'the caret rides along, because the restore puts it back');
  // Emptied by hand is not the same as folded away: one is the human dropping the reply, the other is
  // the rail drawing less of it. Only the first takes the entry out.
  note(replyBox('c1', ''));
  assert.equal(map.size, 0, 'an emptied box clears its draft');
  assert.equal(note(replyBox(null, 'nowhere')), null, 'a box outside a card names no thread');
  assert.equal(map.size, 0);
});

test('the page keeps that map for the page, and clears it only where a draft is genuinely over', () => {
  assert.match(PAGE, /const replyDrafts = new Map\(\);/, 'one map, page-lifetime');
  // Captured from every live box on each render, and restored from the MAP rather than from whatever
  // the last render happened to have on screen.
  assert.match(PAGE, /for \(const ta of side\.querySelectorAll\('textarea\.reply'\)\) \{\n\s*const card = noteDraft\(ta\);/,
    'the capture goes through noteDraft');
  assert.match(PAGE, /for \(const \[id, d\] of replyDrafts\) \{/, 'and the restore walks the map');
  assert.match(PAGE, /const ta = card && card\.querySelector\('textarea\.reply'\);\n\s*if \(!ta\) continue;/,
    'a draft with no box on screen is skipped, not dropped');
  assert.match(PAGE, /noteDraft\(ta\);   \/\/ keep the map level with the box/,
    'the input events write through it too, so syncFreeze reads the same answer');
  assert.match(PAGE, /const hot = hasDraft\(id\) \|\| /, 'and a pill holding a draft still holds its place');
  // The two ends of a draft's life: sent, and belonging to a document that is no longer open.
  assert.match(PAGE, /input\.value = '';[\s\S]{0,120}\n  replyDrafts\.delete\(id\);/, 'sending clears it');
  assert.match(PAGE, /replyDrafts\.clear\(\); draftFocus = null;/, 'and resetDocState clears the lot');
  // One focused box at a time, so a folded draft cannot steal the caret back on a later render.
  assert.match(PAGE, /let draftFocus = null;/);
  assert.match(PAGE, /if \(id === draftFocus\) \{ ta\.focus\(\);/);
});

test('a pill says when it is holding an unsent reply', () => {
  const pill = (it, draft) => CARD_FN('pillHtml', 'esc', 'Turn', 'hasDraft', 'replyingPill')(
    String, Turn, () => draft, () => '')(it, it.kind);
  const it = comment('c1', 'open', msg(AGENT, 'a question'));
  assert.doesNotMatch(pill(it, false), /draft/, 'nothing to say when there is nothing held');
  const held = pill(it, true);
  assert.match(held, /<span class="draft">draft<\/span>/, 'one mono word, so a fold is never a silent loss');
  assert.match(held, /title="expand \(unsent reply\)"/, 'and the expand control says what expanding gets back');
  assert.match(STYLE, /\.card\.collapsed \.pill \.draft \{[^}]*color:var\(--ink\)/, 'ink, not the count chip grey');
});

test('the agent replying is one rule, and both a full card and a pill read it', () => {
  const mark = (marks) => CARD_FN('replyingMark', 'liveMarks')(() => marks);
  const it = comment('c1', 'open', msg(HUMAN, 'over to you'));
  const live = [{ id: 'c1', agent: AGENT }];
  assert.deepEqual(mark(live)(it), live[0], 'marked, and the human spoke last');
  assert.equal(mark([{ id: 'c2', agent: AGENT }])(it), null, 'a mark on another thread is not this one');
  // The moment the reply lands the signal clears here, per thread, without waiting on the server's set.
  const answered = comment('c1', 'open', msg(HUMAN, 'over to you'), msg(AGENT, 'here'));
  assert.equal(mark(live)(answered), null, 'the reply is in: nobody is still replying');
  // Both surfaces are built from that one answer.
  assert.match(PAGE, /function replyingHtml\(it\) \{\n  const m = replyingMark\(it\);/);
  assert.match(PAGE, /function replyingPill\(it\) \{\n  const m = replyingMark\(it\);/);
});

test('a collapsed card shows the agent replying, which is exactly when it is collapsed', () => {
  // The contract this closes: at compact a human-authored comment rests as a pill precisely because it
  // is waiting on the agent, which is the whole window a `sidecar wait` presence update covers. A pill
  // that omitted the signal would drop it in the one state it is most often true.
  const it = comment('c1', 'open', msg(HUMAN, 'over to you'));
  assert.equal(Turn.startCollapsed(it, AGENT, 'compact'), true, 'waiting on the agent, so it is a pill');
  const mark = CARD_FN('replyingMark', 'liveMarks')(() => [{ id: 'c1', agent: AGENT }]);
  const replyingPill = CARD_FN('replyingPill', 'esc', 'replyingMark')(String, mark);
  const html = CARD_FN('pillHtml', 'esc', 'Turn', 'hasDraft', 'replyingPill')(
    String, Turn, () => false, replyingPill)(it, it.kind);
  assert.match(html, /<span class="replying"><span class="lbl">claude is replying<\/span><\/span>/,
    'the same label the full card carries, inside the pill');
  assert.ok(html.indexOf('<span class="replying">') < html.indexOf('</button>'),
    'inside the button, so it rides the pill rather than adding a row under it');
  assert.doesNotMatch(replyingPill(it), /<div/, 'a span, because a button holds phrasing content');
  // One shimmer rule for both, so the reduced-motion fallback comes along unchanged.
  assert.match(STYLE, /\.card\.collapsed \.pill \.replying \{ display:inline-flex;/);
  assert.match(STYLE, /\.card\.collapsed \.pill \.replying \.lbl \{ font:inherit;/);
  assert.match(STYLE, /\.replying \.lbl \{ animation:none; background:none; color:var\(--muted\); \}/,
    'and reduced motion still cuts the sweep for both');
});

// The stamp itself. It is a bare IIFE over `localStorage`, `document` and `Themes`, so it can be run
// with all three handed in — which is how the throw an unavailable localStorage raises gets exercised
// at all, and how the real themes.js is what answers rather than a stand-in.
const STAMP = (() => {
  const m = PAGE.match(/<script>\n([\s\S]*?Theme, before the first paint[\s\S]*?)\n<\/script>/);
  assert.ok(m, 'the pre-paint stamp is still in the page');
  return m[1];
})();
const runStamp = (cell) => {
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  new Function('localStorage', 'document', 'Themes', STAMP)(
    { getItem: (k) => (k in cell ? cell[k] : null) }, doc, Themes);
  return doc.documentElement;
};

test('the theme stamp runs in <head>, after themes.js and before anything the reader could see', () => {
  assert.ok(PAGE.indexOf('src="/themes.js"') < PAGE.indexOf('Theme, before the first paint'),
    'the palette is loaded before the thing that applies it, or the stamp calls nothing');
  assert.ok(PAGE.indexOf('Theme, before the first paint') < PAGE.indexOf('<style>'),
    'ahead of the stylesheet, so there is no unpainted frame to repaint');
  assert.ok(PAGE.indexOf('Theme, before the first paint') < PAGE.indexOf('<body>'), 'and inside <head>');
});

test('the stamp puts a stored theme on the page before the first paint', () => {
  // Nothing stored: paper, which is the palette sidecar shipped with.
  let el = runStamp({});
  assert.equal(el.getAttribute('data-theme'), 'light');
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN.paper.tokens['--bg']);
  // A chosen dark, wearing whatever theme that scheme was given.
  el = runStamp({ 'sc:theme': 'dark', 'sc:themeDark': 'slate-dark' });
  assert.equal(el.getAttribute('data-theme'), 'dark');
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN['slate-dark'].tokens['--bg']);
  assert.equal(el.style.getPropertyValue('--yellow'), '#ffeb00', 'the agent arrives with it');
  assert.match(el.getAttribute('style'), /color-scheme: ?dark/);
  // A chosen light beats a dark system, and the LIGHT slot is what it reads.
  el = runStamp({ 'sc:theme': 'light', 'sc:themeLight': 'sepia', 'sc:themeDark': 'ink' });
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN.sepia.tokens['--bg']);
  // A theme id that is not a theme falls back to the scheme's default rather than painting nothing.
  el = runStamp({ 'sc:theme': 'light', 'sc:themeLight': '<script>' });
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN.paper.tokens['--bg']);
  // A dark theme stored in the light slot is not a light theme: the slot decides the scheme.
  el = runStamp({ 'sc:theme': 'light', 'sc:themeLight': 'ink' });
  assert.equal(el.getAttribute('data-theme'), 'light');
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN.paper.tokens['--bg']);
});

test('a user theme comes back from the cache without a frame of paper', () => {
  // The stamp cannot read a file, so the page leaves the theme it applied where the stamp will look. It
  // is re-validated through the same rules the server runs — the cache is the first door with a shorter
  // walk, not a second door.
  const cache = (id, tokens) => JSON.stringify({ id, theme: { name: 'mine', scheme: 'dark', tokens } });
  let el = runStamp({ 'sc:theme': 'dark', 'sc:themeDark': 'user:mine.json',
    'sc:themeCache:dark': cache('user:mine.json', { '--bg': '#120b1a' }) });
  assert.equal(el.style.getPropertyValue('--bg'), '#120b1a', 'the file the reader was last wearing');
  assert.equal(el.style.getPropertyValue('--fg'), Themes.BUILTIN.ink.tokens['--fg'],
    'and ink underneath it for every token the file did not name');
  // A cache for a DIFFERENT theme is not this theme.
  el = runStamp({ 'sc:theme': 'dark', 'sc:themeDark': 'user:mine.json',
    'sc:themeCache:dark': cache('user:other.json', { '--bg': '#120b1a' }) });
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN.ink.tokens['--bg']);
  // A cache somebody tampered with goes through validate and is refused, not applied.
  el = runStamp({ 'sc:theme': 'dark', 'sc:themeDark': 'user:mine.json',
    'sc:themeCache:dark': cache('user:mine.json', { '--bg': 'url(https://x/p.gif)' }) });
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN.ink.tokens['--bg']);
  el = runStamp({ 'sc:theme': 'dark', 'sc:themeDark': 'user:mine.json', 'sc:themeCache:dark': 'not json' });
  assert.equal(el.style.getPropertyValue('--bg'), Themes.BUILTIN.ink.tokens['--bg']);
});

test('a localStorage that throws costs the page nothing', () => {
  // Safari in private mode. The catch is the whole reason the stamp is wrapped — and the page still has
  // to arrive painted, since the palette is no longer in the stylesheet to fall back on.
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const run = new Function('localStorage', 'document', 'Themes', STAMP);
  assert.doesNotThrow(() => run({ getItem() { throw new Error('blocked'); } }, doc, Themes));
  assert.equal(doc.documentElement.style.getPropertyValue('--bg'), Themes.BUILTIN.paper.tokens['--bg']);
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
});

// The page's own theme block — the store it writes through, the menu, and the two per-scheme choices —
// lifted out and run over a jsdom document. Asserting the behaviour from the source told us the list had
// three names in it and nothing about what a third click does, which is how a cycle that could not reach
// dark once passed.
const THEME_MODULE = (() => {
  const m = PAGE.match(/(const uiStore = \{[\s\S]*?\npaintTheme\(\);)/);
  assert.ok(m, 'the theme block is still one run of source in the page');
  return m[1];
})();

// `localStorage` and `$` are handed in, so the storage a private-mode Safari gives the page can be
// handed in too. `document` is a real jsdom one carrying the control the menu is drawn into.
function themePage({ localStorage, system } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="themeCtl">'
    + '<button id="themeToggle"></button><div class="menu" id="themeMenu" hidden></div></div></body></html>');
  const doc = dom.window.document;
  // What the room is set to. jsdom answers false to every media query, so a dark system is stubbed.
  dom.window.matchMedia = () => ({ matches: system === 'dark', addEventListener() {}, removeEventListener() {} });
  const written = [];
  const cell = new Map();
  const store = localStorage || {
    getItem: (k) => (cell.has(k) ? cell.get(k) : null),
    setItem: (k, v) => { cell.set(k, String(v)); written.push([k, String(v)]); },
  };
  const page = new Function('document', 'window', 'localStorage', '$', 'Themes',
    THEME_MODULE + '\nreturn { setThemeMode, setTheme, activeTheme, activeScheme, renderThemeMenu, '
    + 'toggleThemeMenu, applyTheme, mode: () => themeMode, users: (u) => { userThemes = u; } };')(
    doc, dom.window, store, (id) => doc.getElementById(id), Themes);
  page.doc = doc;
  page.bg = () => doc.documentElement.style.getPropertyValue('--bg');
  page.scheme = () => doc.documentElement.getAttribute('data-theme');
  page.title = () => doc.getElementById('themeToggle').getAttribute('title');
  page.items = () => [...doc.querySelectorAll('#themeMenu button')].map(b =>
    ({ theme: b.dataset.theme, mode: b.dataset.mode, act: b.dataset.act,
      on: b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-pressed') === 'true' }));
  page.written = written;
  return page;
}

test('the mode says which way round the page is and the theme says what it wears', () => {
  const page = themePage();
  assert.equal(page.mode(), 'system', 'a fresh install follows the room');
  assert.equal(page.bg(), Themes.BUILTIN.paper.tokens['--bg'], 'which jsdom says is a light one');
  assert.equal(page.title(), 'Theme: system · paper', 'and the button says both halves');

  page.setTheme('sepia');
  assert.equal(page.bg(), Themes.BUILTIN.sepia.tokens['--bg'], 'a light theme lands on a light page');
  page.setTheme('slate-dark');
  assert.equal(page.bg(), Themes.BUILTIN.sepia.tokens['--bg'],
    'choosing a dark theme by daylight sets tonight, and changes nothing on screen now');
  page.setThemeMode('dark');
  assert.equal(page.bg(), Themes.BUILTIN['slate-dark'].tokens['--bg'], 'and there it is');
  assert.equal(page.scheme(), 'dark');
  assert.equal(page.title(), 'Theme: slate dark');
  assert.deepEqual(page.written, [['sc:themeLight', 'sepia'], ['sc:themeDark', 'slate-dark'],
    ['sc:theme', 'dark']], 'three keys, each written when the thing it holds moved');
});

test('system follows the room, and the room decides which of the two choices is on screen', () => {
  const night = themePage({ system: 'dark' });
  assert.equal(night.scheme(), 'dark');
  assert.equal(night.bg(), Themes.BUILTIN.ink.tokens['--bg'], 'ink is what dark defaults to');
  night.setTheme('sepia');
  assert.equal(night.bg(), Themes.BUILTIN.ink.tokens['--bg'], 'a light theme chosen at night waits for morning');
  night.setThemeMode('light');
  assert.equal(night.bg(), Themes.BUILTIN.sepia.tokens['--bg'], 'an explicit light beats a dark system');
});

test('a storage that refuses every write still applies every choice', () => {
  // Safari in private mode: setItem throws and getItem keeps answering null. Deriving the next step from
  // the store there moved once and then stopped forever.
  const page = themePage({ localStorage: { getItem: () => null, setItem() { throw new Error('blocked'); } } });
  assert.doesNotThrow(() => page.setTheme('contrast'));
  assert.equal(page.bg(), Themes.BUILTIN.contrast.tokens['--bg']);
  page.setThemeMode('dark');
  assert.equal(page.bg(), Themes.BUILTIN.ink.tokens['--bg']);
  page.setTheme('contrast-dark');
  assert.equal(page.bg(), Themes.BUILTIN['contrast-dark'].tokens['--bg'], 'and the next one still lands');
});

test('the menu lists the built-ins by scheme, the user themes with them, and one action', () => {
  const page = themePage();
  page.users({ 'user:mine.json': { name: 'mine', scheme: 'dark', tokens: { '--bg': '#101018' } } });
  page.renderThemeMenu();
  const items = page.items();
  assert.deepEqual(items.filter(i => i.mode).map(i => i.mode), ['system', 'light', 'dark'],
    'the mode is three icons across the top, where the header button used to cycle');
  assert.deepEqual(items.filter(i => i.theme).map(i => i.theme),
    ['paper', 'sepia', 'slate', 'contrast', 'ink', 'sepia-dark', 'slate-dark', 'contrast-dark', 'user:mine.json'],
    'the light four, then the dark four, and a reader\'s own theme in its own group');
  assert.equal(items.filter(i => i.act === 'customize').length, 1, 'one action, at the foot');
  assert.deepEqual(items.filter(i => i.on).map(i => i.mode || i.theme), ['system', 'paper', 'ink'],
    'the mode, and the theme each scheme is wearing — including the one not on screen');
  // A swatch is the theme's own ground and ink, which is the only way a menu of names says anything.
  const sw = page.doc.querySelector('#themeMenu button[data-theme="user:mine.json"] .sw');
  assert.ok(sw, 'every row carries one');
  // jsdom hands a colour back as rgb(), which is the same value the browser resolves it to.
  assert.match(sw.getAttribute('style'), /rgb\(16, ?16, ?24\)|#101018/, 'painted from the theme it stands for');
  page.setTheme('user:mine.json');
  assert.deepEqual(page.written, [['sc:themeDark', 'user:mine.json'],
    ['sc:themeCache:dark', JSON.stringify({ id: 'user:mine.json',
      theme: Themes.expand({ name: 'mine', scheme: 'dark', tokens: { '--bg': '#101018' } }) })]],
    'a user theme is chosen like any other, and cached so the next load does not flash');
});

test('the theme control is an icon and a menu in the header, and writes through the one store', () => {
  assert.match(PAGE, /id="themeToggle"[\s\S]{0,200}onclick="toggleThemeMenu\(\)"/, 'the header carries the button');
  assert.match(PAGE, /<div class="menu" id="themeMenu" role="menu" hidden>/, 'and the menu it opens');
  assert.match(PAGE, /uiStore\.set\('theme', themeMode\)/, 'the mode goes through the one preference store');
  assert.match(PAGE, /uiStore\.set\(t\.scheme === 'dark' \? 'themeDark' : 'themeLight', id\)/,
    'and so does which theme wears each scheme');
  assert.ok(!/themeToggle[^>]*>[A-Za-z]/.test(PAGE.match(/<button id="themeToggle"[\s\S]*?<\/button>/)[0]),
    'no label text in the control — an icon and a title, like the two panel toggles beside it');
});

// ---- reading mode and typewriter scrolling ----
// Two axes, tested apart because they are separate features: what else is on screen, and where the
// active line sits. The first is a body class and is driven under jsdom; the second is arithmetic and
// is the pure module public/focus.js.

const Focus = require('./public/focus.js');   // the SAME file index.html loads via <script>

test('the typewriter target puts the caret\'s LINE at 45% of the window', () => {
  // A 22px line whose top is 700px down an 800px window: its middle is at 711, and 45% of 800 is 360,
  // so the page has to travel 351px further down.
  assert.equal(Focus.target({ caretTop: 700, caretHeight: 22, viewportH: 800, scrollY: 1000 }), 1351);
  // …and back up when the caret is above the line.
  assert.equal(Focus.target({ caretTop: 100, caretHeight: 22, viewportH: 800, scrollY: 1000 }), 751);
  assert.equal(Focus.RATIO, 0.45);
});

test('a tall line and a short one settle in the same place', () => {
  // The LINE is centred, not its top. A 44px heading and a 22px body line whose middles coincide have
  // to land on the same scroll position, or an h1 rests visibly lower than the prose under it.
  const heading = Focus.target({ caretTop: 400, caretHeight: 44, viewportH: 900, scrollY: 500 });
  const body = Focus.target({ caretTop: 411, caretHeight: 22, viewportH: 900, scrollY: 500 });
  assert.equal(heading, body);
});

test('the first and last lines scroll as far as the document allows and no further', () => {
  // A caret in the opening paragraph cannot sit at 45% of the window: the page would have to scroll
  // above zero. Clamped, not refused.
  assert.equal(Focus.target({ caretTop: 60, caretHeight: 22, viewportH: 800, scrollY: 100 }), 0);
  // And at the bottom, the far end of the scroll range rather than past it.
  assert.equal(Focus.target({ caretTop: 700, caretHeight: 22, viewportH: 800, scrollY: 1000, maxScroll: 1200 }),
    1200);
  // Already parked at the clamp, so there is nothing left to do and the answer is "hold still".
  assert.equal(Focus.target({ caretTop: 700, caretHeight: 22, viewportH: 800, scrollY: 1200, maxScroll: 1200 }),
    null);
});

test('a move smaller than the deadband is not a move', () => {
  // Every arrow key inside one line would otherwise restart a smooth scroll animation over nothing.
  const at = (top) => Focus.target({ caretTop: top, caretHeight: 20, viewportH: 1000, scrollY: 0 });
  assert.equal(at(440), null, 'a pixel out of place is left alone');
  assert.equal(at(443), null, 'and so is three');
  assert.ok(at(460) != null, 'a real move is a real move');
  assert.equal(Focus.DEADBAND, 4);
});

test('inputs that say nothing produce no scroll', () => {
  assert.equal(Focus.target(), null);
  assert.equal(Focus.target({ caretTop: 400, viewportH: 0 }), null, 'a window of no height');
  assert.equal(Focus.target({ viewportH: 800 }), null, 'no caret rect at all');
  assert.equal(Focus.target({ caretTop: NaN, viewportH: 800 }), null);
});

test('the page loads focus.js and computes the target through it', () => {
  assert.match(PAGE, /<script src="\/focus\.js">/, 'the same file the tests require');
  assert.match(PAGE, /Focus\.target\(\{/, 'and the page asks it rather than doing the arithmetic inline');
});

// The reading-mode block, lifted out of the page and run over a jsdom document, the THEME_MODULE
// pattern. Everything it reaches out to is handed in, including the timers, so the class the
// animation leaves behind can be asserted rather than waited for.
const READING_MODULE = (() => {
  const m = PAGE.match(/(const READING_MS = 220;[\s\S]*?\npaintReading\(\);)/);
  assert.ok(m, 'the reading-mode block is still one run of source in the page');
  return m[1];
})();

function readingPage() {
  const doc = new JSDOM('<!doctype html><html><body><header><div class="hwrap">'
    + '<button id="readingToggle"></button></div></header></body></html>').window.document;
  const calls = [], timers = [];
  const page = new Function('document', '$', 'closeNavDrawer', 'toggleSheet', 'hideTool', 'hidePopover',
    'syncMarkEditing', 'relayoutDoc', 'setTimeout', 'clearTimeout',
    READING_MODULE + '\nreturn { setReading, toggleReading, isReading, READING_MS };')(
    doc, (id) => doc.getElementById(id),
    () => calls.push('closeNavDrawer'),
    (v) => calls.push('toggleSheet:' + v),
    () => calls.push('hideTool'),
    () => calls.push('hidePopover'),
    () => calls.push('syncMarkEditing'),
    () => calls.push('relayoutDoc'),
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    () => {});
  page.calls = calls;
  page.timers = timers;
  page.classes = () => [...doc.body.classList].sort();
  page.btn = doc.getElementById('readingToggle');
  page.settle = () => timers[timers.length - 1].fn();   // the animation class comes off on this timer
  return page;
}

test('reading mode is one class on the body, on and back off again', () => {
  const page = readingPage();
  assert.deepEqual(page.classes(), [], 'a fresh page is not reading');
  assert.equal(page.isReading(), false);

  page.setReading(true);
  assert.deepEqual(page.classes(), ['reading', 'reading-animating']);
  assert.equal(page.isReading(), true);
  page.settle();
  assert.deepEqual(page.classes(), ['reading'], 'the animation class is not left on');

  page.setReading(false);
  assert.deepEqual(page.classes(), ['reading-animating'], 'and it comes back for the way out');
  page.settle();
  assert.deepEqual(page.classes(), []);
  assert.equal(page.isReading(), false);
});

test('the transition is 220ms and the class outlives it', () => {
  const page = readingPage();
  page.setReading(true);
  assert.equal(page.READING_MS, 220);
  assert.ok(page.timers[0].ms > 220, 'the class comes off after the transition, not during it');
  assert.match(STYLE, /body\.reading-animating main \{ transition:grid-template-columns \.22s ease; \}/);
  assert.match(STYLE, /prefers-reduced-motion: reduce\) \{\n\s*body\.reading-animating[\s\S]{0,240}transition:none;/,
    'and a reader who asked for no motion gets the mode without the move');
});

test('entering shuts the review overlays and drops a live selection; leaving shuts nothing', () => {
  const page = readingPage();
  page.setReading(true);
  assert.deepEqual(page.calls,
    ['closeNavDrawer', 'toggleSheet:false', 'hideTool', 'hidePopover', 'syncMarkEditing', 'relayoutDoc'],
    'the drawer, the sheet and the composer belong to the review and cannot sit on top of it');
  page.calls.length = 0;
  page.setReading(false);
  assert.deepEqual(page.calls, ['syncMarkEditing', 'relayoutDoc'],
    'coming back out hands the marks their tap target back and re-measures');
});

test('setting the mode it is already in does nothing at all', () => {
  const page = readingPage();
  page.setReading(true);
  page.settle();
  page.calls.length = 0;
  page.setReading(true);
  assert.deepEqual(page.calls, [], 'no second relayout, and no animation class for a change that is not one');
  assert.deepEqual(page.classes(), ['reading']);
  page.toggleReading();
  assert.equal(page.isReading(), false);
});

test('the button is the way back out and says so', () => {
  const page = readingPage();
  assert.match(page.btn.getAttribute('title'), /^Reading mode/);
  assert.equal(page.btn.getAttribute('aria-pressed'), 'false');
  page.setReading(true);
  assert.match(page.btn.getAttribute('title'), /^Leave reading mode/);
  assert.equal(page.btn.getAttribute('aria-pressed'), 'true');
  assert.equal(page.btn.getAttribute('aria-label'), page.btn.getAttribute('title'));
  assert.ok(!page.btn.textContent.trim(), 'an icon and a title, no label text');
});

test('reading mode persists nothing: it is per visit, always off at boot', () => {
  assert.ok(!/uiStore|localStorage/.test(READING_MODULE),
    'no store write anywhere in the block: a reload opening on a chromeless page is not a preference');
  assert.match(PAGE, /let reading = false, readingTimer = null;/, 'and the flag starts false');
});

test('reading mode collapses both tracks rather than removing them, and keeps its one exit', () => {
  assert.match(STYLE, /body\.reading, body\.reading\.nav-collapsed \{ --nav-track:0px; --rail-w:0px; \}/,
    'the two numbers the whole shell already follows, so the panels animate out');
  assert.match(STYLE, /body\.reading \.hwrap > \*:not\(#readingToggle\):not\(\.spacer\) \{ display:none; \}/,
    'the header keeps the way out and nothing else');
  assert.match(STYLE, /body\.reading mark\.anchor \{[^}]*transparent/, 'the marks stop painting');
  assert.match(STYLE, /body\.reading #seltool \{ display:none; \}/);
  assert.match(STYLE, /body\.reading #sheetToggle, body\.reading #sheetBackdrop \{ display:none; \}/,
    'and on a phone the pull-up pill goes with the rest of the review chrome');
  assert.match(PAGE, /if \(isReading\(\)\) return;/, 'the toolbar is refused in code too, not only in CSS');
});

test('⌘⇧F toggles reading and Escape leaves it, and neither key was taken', () => {
  assert.match(PAGE, /\(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey && \(e\.key === 'f' \|\| e\.key === 'F'\)/);
  assert.match(PAGE, /e\.key === 'Escape' && reading && !\$\('lightbox'\)\.classList\.contains\('on'\)/,
    'the lightbox has its own Escape and a picture is the nearer thing to dismiss');
  // Every key literal any handler in the page tests, so a new binding cannot quietly shadow one. The
  // page's other keydown handlers are Alt and Shift over an asset frame, Backspace and Enter inside
  // the document, and the arrow keys on the two resize grips; `a` is the selection toolbar's Cmd+A.
  const keys = [...PAGE.matchAll(/e\.key (?:!==|===) '([^']+)'/g)].map(m => m[1]);
  assert.equal(keys.filter(k => k === 'f' || k === 'F').length, 2, 'f and F are each bound exactly once');
  assert.ok(!keys.includes('F1'), 'and nothing else in the page is reaching for a function key');
});

test('typewriter scrolling is a preference, off by default, under sc:typewriter', () => {
  assert.match(PAGE, /let typewriter = uiStore\.get\('typewriter', ''\) === '1';/,
    'absent reads as off, through the one store that carries the sc: prefix');
  assert.match(PAGE, /uiStore\.set\('typewriter', typewriter \? '1' : ''\)/);
  assert.match(PAGE, /id="typewriterToggle"[\s\S]{0,240}onclick="toggleTypewriter\(\)"/,
    'the header carries the button beside the theme and the width');
  const btn = PAGE.match(/<button id="typewriterToggle"[\s\S]*?<\/button>/)[0];
  assert.ok(!/>[A-Za-z]/.test(btn.replace(/<svg[\s\S]*?<\/svg>/, '')),
    'no label text in the control: an icon and a title, like every other button in that group');
});

test('typewriter does not fight the reader, and only runs on the document', () => {
  assert.match(PAGE, /window\.addEventListener\('wheel', suspendTypewriter, \{ passive: true \}\)/);
  assert.match(PAGE, /window\.addEventListener\('touchmove', suspendTypewriter, \{ passive: true \}\)/);
  assert.match(PAGE, /typeSuspended = false;\s+\/\/ the caret moved/,
    'and the next caret move is what brings it back');
  assert.match(PAGE, /if \(!typewriter \|\| typeSuspended \|\| isAsset\(\) \|\| !docHasCaret\(\)\) return;/,
    'a reply box in the rail is not the document, and an asset has no caret');
  assert.match(PAGE, /behavior: reduceMotion\(\) \? 'auto' : 'smooth'/, 'instant under reduced motion');
  assert.match(PAGE, /document\.addEventListener\('selectionchange', onCaretActivity\)/);
});

// ---- what the second reviewer found on PR 5 ----

test('the caret rect is the FOCUS, not the document-order end of the selection', () => {
  // A Range is normalized to document order, so collapsing one to its end hands back the ANCHOR of a
  // backward selection. Shift+Up scrolled toward the sentence being left behind rather than the line
  // the caret was on.
  assert.match(PAGE, /const r = document\.createRange\(\);\n\s*r\.setStart\(s\.focusNode, Math\.min\(s\.focusOffset/,
    'built from focusNode/focusOffset');
  assert.ok(!/const r = s\.getRangeAt\(0\)\.cloneRange\(\);\n\s*r\.collapse\(false\);/.test(PAGE),
    'and never by collapsing the live range to its end');
  assert.match(PAGE, /lastCaret = \{ n: s\.focusNode, o: s\.focusOffset \};/,
    'the same two fields caretMoved keys off, so the two cannot disagree');
});

test('typewriter gives the document the room its last line needs', () => {
  // 45% of the window means 55vh of space below the caret. #doc rests at 40vh (42vh on a phone), so
  // the final paragraph topped out around 60% and the clamp ate the difference.
  assert.match(STYLE, /body\.typewriter #doc \{ padding-bottom:58vh; \}/);
  assert.match(PAGE, /document\.body\.classList\.toggle\('typewriter', typewriter\);/,
    'and the class follows the preference rather than being set once at boot');
  // The arithmetic the 58vh is there to satisfy, run through the real module: a 5000px document in a
  // 900px window, caret on the last line, scrolled from the top.
  const V = 900, line = 22, H = 5000;
  const lastLine = (pad) => {
    const y = H - pad * V - line;                       // the last line's top, in document coordinates
    return {
      ideal: Math.round(y + line / 2 - V * Focus.RATIO),
      got: Focus.target({ caretTop: y, caretHeight: line, viewportH: V, scrollY: 0, maxScroll: H - V }),
      restsAt: (pad2) => Math.round(((y - Math.min(H - V, y + line / 2 - V * Focus.RATIO)) / V) * 100),
    };
  };
  const tight = lastLine(0.40), roomy = lastLine(0.58);
  assert.ok(tight.got < tight.ideal, 'at 40vh the clamp stops the last line short of 45%');
  assert.equal(tight.restsAt(), 58, 'it rests around 58% instead, which is the bug the reviewer found');
  assert.equal(roomy.got, roomy.ideal, 'at 58vh it gets all the way there');
});

test('an invisible mark is not an island: reading mode hands its text back to the caret', () => {
  // A mark is contenteditable:false everywhere else, which is what makes it a tap target for its card.
  // Unpainted and untappable, that would be an anchored sentence the caret could not enter — the one
  // thing the mode promises you can still do.
  assert.match(PAGE, /function syncMarkEditing\(\) \{[\s\S]*?if \(isReading\(\)\) m\.removeAttribute\('contenteditable'\);/);
  assert.match(PAGE, /catch \(e\) \{ console\.error\('sidecar: failed to highlight', it\.id, e\); \}\n\s*\}\n\s*syncMarkEditing\(\);/,
    'markAnchors syncs too, because marks are rebuilt on every render');
  assert.match(PAGE, /\$\('doc'\)\.addEventListener\('click', \(e\) => \{\n\s*if \(isReading\(\)\) return;/,
    'and tapping one does not drag the rail back on screen');
});

test('entering reading mode closes the comment composer as well as the toolbar', () => {
  assert.match(PAGE, /if \(on\) \{ hideTool\(\); hidePopover\(\); \}/,
    'an open popover would sit over the chrome-free page it was opened from');
  const page = readingPage();
  assert.ok(READING_MODULE.includes('hidePopover()'), 'and it is part of the block, not a caller\'s job');
  page.setReading(true);
  assert.ok(page.calls.includes('hidePopover'), 'called on the way in');
  page.calls.length = 0;
  page.setReading(false);
  assert.ok(!page.calls.includes('hidePopover'), 'and not on the way out, where there is nothing to close');
});

/* ────────────────────────────────────────────────────────────────────────────
   THE COLLAPSED FOLDER IS A BARE EDGE
   It used to be a 48px icon strip: one initial per document, each wearing its
   own unread dot. Minimizing the folder is a request for the folder to go, so
   what is left is the way back out and, when something is waiting, the count.
   ──────────────────────────────────────────────────────────────────────────── */

test('the collapsed folder draws the handle, the count, and nothing else', () => {
  assert.match(STYLE, /body\.nav-collapsed \{ --nav-track:34px; \}/,
    'an edge, not a second document list');
  assert.match(STYLE, /body\.nav-collapsed \.nav-list, body\.nav-collapsed \.nav-empty \{ display:none; \}/,
    'the list and the empty state both go');
  assert.match(STYLE, /body\.nav-collapsed #navExpand \{ display:flex; margin-left:0; \}/,
    'the way back out stays');
  assert.match(STYLE, /body\.nav-collapsed #nav:hover #navExpand \{ color:var\(--ink\); \}/,
    'hovering the edge inks the handle');
  // Every rule that drew a document on the strip is gone, not merely overridden.
  for (const dead of ['body.nav-collapsed .nav-list a', 'body.nav-collapsed .nav-list a .ini',
                      'body.nav-collapsed .nav-list a .meta']) {
    assert.ok(!STYLE.includes(dead + ' {'), dead + ' has nothing left to style');
  }
  assert.ok(!STYLE.includes('.ini'), 'the initial is gone from the stylesheet');
  assert.ok(!PAGE.includes('class="ini"'), 'and the row no longer renders one');
});

test('the count is the whole control, and a zero takes it with it', () => {
  // A pill with no number in it is a control that does nothing, so the button goes rather than the
  // number. renderNav owns that, because it is the only place the folder's total is known.
  assert.match(PAGE, /strip\.hidden = !waiting;/,
    'renderNav hides the control itself at zero');
  assert.match(STYLE, /body\.nav-collapsed #navStripWaiting\[hidden\] \{ display:none; \}/,
    'and the collapsed block honours the attribute rather than out-specifying it');
  const pill = STYLE.match(/body\.nav-collapsed #navStripWaiting \.n \{([\s\S]*?)\}/);
  assert.ok(pill, 'the pill rule is still findable');
  assert.match(pill[1], /background:var\(--yellow\)/, 'yellow, because it is the agent holding something out');
  assert.match(PAGE, /id="navStripWaiting"[^>]*onclick="toggleNav\(true\)"/,
    'and clicking it opens the panel, where the rows say which documents');
});

/* ────────────────────────────────────────────────────────────────────────────
   THE DOCUMENT'S TYPE SIZE
   Four steps, stamped before the first paint, and one number every other
   number in the document is derived from: the vertical scale, the headings
   and the measure all follow it, so one control moves the whole page.
   ──────────────────────────────────────────────────────────────────────────── */

// The block lifted out and run with its collaborators handed in, the same way the theme's is.
const PROSE_MODULE = (() => {
  const from = PAGE.indexOf('// ---------- the document\'s type size ----------');
  const to = PAGE.indexOf('const railCollapsed =');
  assert.ok(from > -1 && to > from, 'the type-size block is still one block in the page');
  return PAGE.slice(from, to);
})();

function prosePage({ backing = {}, stamped } = {}) {
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  if (stamped) doc.documentElement.dataset.prose = stamped;
  const calls = [], bound = [];
  let asset = false;
  const page = new Function('document', 'uiStore', 'relayoutDoc', 'isAsset', 'window',
    PROSE_MODULE + '\nreturn { PROSE_SIZES, PROSE_DEFAULT, proseSize, applyProse, stepProse, cycleProse };')(
    doc, storeOver(backing), () => calls.push('relayoutDoc'), () => asset,
    { addEventListener: (type, fn, opts) => bound.push({ type, fn, opts }) });
  page.doc = doc;
  page.calls = calls;
  page.backing = backing;
  page.bound = bound;
  page.applied = () => doc.documentElement.style.getPropertyValue('--prose-size');
  page.setAsset = (v) => { asset = v; };
  page.press = (key, mods = { metaKey: true }) => {
    let prevented = false;
    bound[0].fn({ key, altKey: false, ...mods, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return page;
}

test('four steps, and the head and the page name the same four', () => {
  const page = prosePage();
  assert.deepEqual(page.PROSE_SIZES, ['15', '16.5', '18', '20'], 'four, a ratio apart');
  assert.equal(page.PROSE_DEFAULT, '16.5', 'and the reading column\'s own size is the default');
  // The stamp runs before this code exists and so carries its own copy. A drift between the two is a
  // reader who set 20px watching the page reflow on every load.
  const head = STAMP.match(/var S = \[([^\]]+)\]/);
  assert.ok(head, 'the stamp still declares its own list');
  assert.deepEqual(head[1].split(',').map(s => s.trim().replace(/'/g, '')), page.PROSE_SIZES,
    'the pre-paint list and the cycled list are identical');
  assert.match(STAMP, /if \(S\.indexOf\(p\) === -1\) p = '16\.5';/, 'and they default to the same step');
});

test('the stamp honours a stored step and ignores anything that is not one', () => {
  const run = new Function('localStorage', 'document', STAMP);
  const stamp = (stored) => {
    const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
    run({ getItem: (k) => (k === 'sc:proseSize' ? stored : null) }, doc);
    return doc.documentElement;
  };
  assert.equal(stamp('20').dataset.prose, '20', 'a chosen step is stamped');
  assert.equal(stamp('20').style.getPropertyValue('--prose-size'), '20px',
    'as the variable #doc reads, so the first frame is already the right size');
  assert.equal(stamp(null).dataset.prose, '16.5', 'nothing stored reads as the default');
  assert.equal(stamp('17').dataset.prose, '16.5', 'a size that is not a step is not honoured');
  assert.equal(stamp('99px; }').dataset.prose, '16.5', 'and nothing junk is echoed into the style attribute');
});

test('the stamp runs in <head> and reads the same key the page writes', () => {
  assert.ok(PAGE.indexOf("localStorage.getItem('sc:proseSize')") < PAGE.indexOf('<style>'),
    'ahead of the stylesheet, so the document is never drawn at the wrong size first');
  const page = prosePage();
  page.applyProse('18');
  assert.deepEqual(page.backing, { 'sc:proseSize': '18' }, 'one key, prefixed like every other preference');
  assert.doesNotMatch(PROSE_MODULE, /localStorage/, 'nothing in the block reaches storage around uiStore');
});

test('the button wraps through the four and the keys stop at the ends', () => {
  const page = prosePage();
  assert.equal(page.proseSize(), '16.5', 'an install that has never touched it rests at the default');
  page.cycleProse(); assert.equal(page.proseSize(), '18');
  page.cycleProse(); assert.equal(page.proseSize(), '20');
  page.cycleProse(); assert.equal(page.proseSize(), '15', 'the button wraps: it is the only step it has');
  // The keys do not wrap. ⌘- four times is a request to be smaller, not a request for 20px.
  page.applyProse('15');
  page.stepProse(-1, false); assert.equal(page.proseSize(), '15', 'and holds at the small end');
  page.applyProse('20');
  page.stepProse(1, false); assert.equal(page.proseSize(), '20', 'and at the large end');
});

test('a stamped size is where the cycle starts, and junk in the store is not', () => {
  assert.equal(prosePage({ stamped: '20' }).proseSize(), '20', 'the cycle reads the attribute the stamp left');
  assert.equal(prosePage({ stamped: '13' }).proseSize(), '16.5', 'an attribute naming no step is the default');
  const page = prosePage();
  page.applyProse('nonsense');
  assert.equal(page.proseSize(), '16.5', 'and applying junk lands on the default rather than on nothing');
  assert.equal(page.applied(), '16.5px');
});

test('every size change re-docks the cards', () => {
  // Every line in the document moved, so every card is level with the wrong pixel until it re-measures.
  // The same call the measure's cycle and the rail's drag make.
  const page = prosePage();
  page.cycleProse();
  page.stepProse(-1, false);
  assert.deepEqual(page.calls, ['relayoutDoc', 'relayoutDoc'], 'once per change, no more and no fewer');
});

test('the keys are taken in capture, and taken from the browser', () => {
  const page = prosePage();
  assert.equal(page.bound.length, 1, 'one listener');
  assert.equal(page.bound[0].type, 'keydown');
  assert.equal(page.bound[0].opts, true,
    'capture: the document is contenteditable and the keys have to be taken before it sees them');
  assert.ok(page.press('='), 'the browser zoom does not also fire');
  assert.equal(page.proseSize(), '18');
  assert.ok(page.press('+'), 'the shifted key means the same thing');
  assert.equal(page.proseSize(), '20');
  assert.ok(page.press('-')); assert.equal(page.proseSize(), '18');
  assert.ok(page.press('0')); assert.equal(page.proseSize(), '16.5', '⌘0 is back to the default');
  assert.ok(!page.press('=', {}), 'a bare = is typing and is left alone');
  assert.ok(!page.press('=', { metaKey: true, altKey: true }), 'and ⌥⌘= is somebody else\'s shortcut');
  page.setAsset(true);
  assert.ok(!page.press('='), 'an asset is scaled rather than set, so the keys do nothing there');
  assert.equal(page.proseSize(), '16.5');
});

test('the control sits with the theme and the width, and carries no label', () => {
  assert.match(PAGE, /id="proseToggle"[\s\S]{0,240}onclick="cycleProse\(\)"/);
  const btn = PAGE.match(/<button id="proseToggle"[\s\S]*?<\/button>/)[0];
  assert.ok(!/>[A-Za-z]/.test(btn.replace(/<svg[\s\S]*?<\/svg>/, '')),
    'an icon and a title, like every other button in that group');
  assert.match(btn, /title="Text size"/);
  assert.ok(PAGE.indexOf('id="measureToggle"') < PAGE.indexOf('id="proseToggle"')
    && PAGE.indexOf('id="proseToggle"') < PAGE.indexOf('id="typewriterToggle"'),
    'between the width and the typewriter, which is where the reading controls live');
  assert.match(PAGE, /const ps = \$\('proseToggle'\); if \(ps\) ps\.hidden = isAsset\(\);/,
    'and it goes with the measure on an asset');
});

test('one number, and the whole document is a multiple of it', () => {
  // The point of the feature: the body size moves and the vertical rhythm, the headings and the column
  // width move with it. A scale that only grew the body copy would be a document with the wrong air.
  const doc = STYLE.match(/\n {2}#doc \{([\s\S]*?)\n {2}\}/);
  assert.ok(doc, 'the #doc rule is still findable');
  assert.match(doc[1], /--doc-size:max\(var\(--prose-size\), var\(--prose-floor\)\)/,
    'the chosen step, floored by the breakpoint');
  assert.match(doc[1], /font-size:var\(--doc-size\)/);
  assert.match(doc[1], /max-width:calc\(var\(--measure\) \+ 88px\)/,
    'the measure is in em and resolves against that size, so the line holds its characters');
  // Every step of the vertical scale is the body line times something, and at the default it lands on
  // the numbers the reading column was tuned at.
  const WANT = { 0: [0.4, 6.6], 1: [0.8, 13.2], 2: [1.6, 26.4], 3: [2.4, 39.6], 4: [3.2, 52.8] };
  for (const [n, [mult, px]] of Object.entries(WANT)) {
    const m = doc[1].match(new RegExp(`--doc-space-${n}:calc\\(var\\(--doc-size\\) \\* ([\\d.]+)\\)`));
    assert.ok(m, `--doc-space-${n} is derived from the body size`);
    assert.equal(Number(m[1]), mult);
    assert.equal(Math.round(mult * 16.5 * 10) / 10, px, `and at 16.5 it is still ${px}px`);
  }
  assert.ok(!/--doc-space-\d:\d/.test(STYLE), 'nothing is left on a fixed pixel');
});

test('the headings are ratios of the body, at both breakpoints', () => {
  const size = (sel, where) => {
    const m = where.match(new RegExp(`${sel.replace('#', '#')} \\{ font-size:([\\d.]+)em`));
    assert.ok(m, `${sel} is sized as a ratio, not a pixel`);
    return Number(m[1]);
  };
  // 28 / 21 / 17 over 16.5 is what the reading column set, and the ratios are those numbers.
  for (const [sel, px] of [['#doc h1', 28], ['#doc h2', 21], ['#doc h3', 17]]) {
    assert.equal(Math.round(size(sel, STYLE) * 16.5), px, `${sel} still draws ${px}px at the default step`);
  }
  // The phone keeps tighter ratios of its own, over the 16px floor it reads there.
  for (const [sel, px] of [['#doc h1', 25], ['#doc h2', 19], ['#doc h3', 16.5]]) {
    assert.equal(Math.round(size(sel, MOBILE) * 16 * 10) / 10, px, `${sel} draws ${px}px on a phone`);
  }
});

test('the phone floors the step at 16, because #doc is editable', () => {
  // iOS Safari zooms into an editable under 16px and never zooms back out. The floor is a token in the
  // stylesheet rather than a clamp in the stamp: an inline style beats every media query, and a window
  // dragged across 780px has to re-clamp with nothing listening.
  assert.equal(LIGHT['--prose-floor'], '0px', 'no floor on a desktop, where 15px is a real choice');
  assert.match(MOBILE, /:root \{ --prose-floor:16px; \}/, 'and 16px below the breakpoint');
  assert.doesNotMatch(STAMP, /prose[\s\S]{0,400}matchMedia/, 'the stamp does not try to do it itself');
  assert.ok(!MOBILE_RULES.some(r => r.sel === '#doc' && /font-size:/.test(r.body)),
    'the mobile #doc rule sets no size of its own: the floor carries it');
});

// ---- type-to-format, over a jsdom #doc, driven by the real input events ----------------------------
// The rules block lifted out of the page and run whole, the THEME_MODULE pattern. Everything it reaches
// for is handed in, so the assertions are about the source that ships, not a re-implementation.
//
// What this covers that the turndown round-trip above cannot: a line the user OPENED WITH ENTER.
// Enter does not create a new .block — the browser splits inside the wrapper — so a .block holds
// several lines and the marker sits on the last one. Reading blockEl.firstElementChild checked the line
// above and `## Hello!` stayed literal until a reload re-lexed the file. Chrome's split, measured over
// CDP on 2026-09-13: a sibling <p> after a paragraph, a bare <div> after a heading.
const RULES_MODULE = (() => {
  const m = PAGE.match(/(function caretBlock\(\) \{[\s\S]*?addEventListener\('compositionend', runBlockRule\);)/);
  assert.ok(m, 'the input-rules block is still one run of source in the page');
  return m[1];
})();

function rulesPage(html) {
  const dom = new JSDOM('<!doctype html><html><body><div id="doc" contenteditable="true">'
    + html + '</div></body></html>');
  const { window } = dom, doc = window.document;
  const saves = [];
  const page = new Function('document', 'getSelection', 'NodeFilter', '$', 'scheduleSave', 'dirty',
    RULES_MODULE + '\nreturn { caretBlock, caretInner, tryBlockRule, runBlockRule, isDirty: () => dirty };')(
    doc, () => window.getSelection(), window.NodeFilter, (id) => doc.getElementById(id),
    () => saves.push(1), false);
  page.doc = doc; page.window = window; page.saves = saves;
  page.sel = () => window.getSelection();
  page.block = (i) => doc.querySelectorAll('#doc .block')[i];

  // Put the caret at the end of `el`, the way clicking into a line does.
  page.caretToEndOf = (el) => {
    const r = doc.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  // What Chrome does to the DOM when Enter is pressed at the end of a line: it splits INSIDE the .block
  // wrapper, leaving a sibling <p> after a paragraph and a bare <div> after a heading, and parks the
  // caret in it. jsdom implements no editing commands, so the split is performed here and the caret
  // placed exactly where the browser leaves it. Measured over CDP against real Chrome, see above.
  page.pressEnter = () => {
    const s = window.getSelection();
    let n = s.anchorNode; n = n.nodeType === 1 ? n : n.parentElement;
    const blockEl = n.closest('.block');
    let line = n; while (line.parentElement !== blockEl) line = line.parentElement;
    const opened = doc.createElement(/^H[1-6]$/.test(line.nodeName) ? 'div' : 'p');
    opened.appendChild(doc.createElement('br'));
    line.after(opened);
    const r = doc.createRange(); r.setStart(opened, 0); r.collapse(true);
    s.removeAllRanges(); s.addRange(r);
    return opened;
  };
  // The line the caret is on, and its character offsets — the same three moves the page makes, so the
  // harness measures the caret the way the code under test does.
  const lineOf = (node) => {
    let n = node.nodeType === 1 ? node : node.parentElement;
    const blockEl = n.closest('.block');
    while (n.parentElement !== blockEl) n = n.parentElement;
    return n;
  };
  const offsetIn = (el, node, off) => {
    const r = doc.createRange(); r.selectNodeContents(el); r.setEnd(node, off); return r.toString().length;
  };
  const setOffset = (el, off) => {
    const w = doc.createTreeWalker(el, window.NodeFilter.SHOW_TEXT);
    const r = doc.createRange(); let n, acc = 0, placed = false;
    while ((n = w.nextNode())) {
      if (acc + n.length >= off) { r.setStart(n, off - acc); r.collapse(true); placed = true; break; }
      acc += n.length;
    }
    if (!placed) { r.selectNodeContents(el); r.collapse(false); }
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  // Insert `text` at the caret the way the browser does — the placeholder <br> of an empty line goes,
  // the typed run merges into ONE text node (stripLead reads the first text node, so a run left split
  // across nine nodes would not behave like real typing), and the caret lands after what was inserted.
  const insertAtCaret = (text) => {
    const r0 = window.getSelection().getRangeAt(0);
    const line = lineOf(r0.startContainer);
    const at = offsetIn(line, r0.startContainer, r0.startOffset);
    r0.cloneRange().insertNode(doc.createTextNode(text));
    const last = line.lastChild;
    if (last && last.nodeName === 'BR' && line.textContent) last.remove();
    line.normalize();
    setOffset(line, at + text.length);
  };
  const fire = (init) => doc.getElementById('doc').dispatchEvent(
    new window.InputEvent('input', { bubbles: true, ...init }));

  // One character, the way the browser delivers it: the text lands, THEN `input` fires. The listener
  // the module registered on #doc is what runs — nothing here calls the rule directly.
  page.type = (text) => {
    for (const ch of text) { insertAtCaret(ch); fire({ inputType: 'insertText', data: ch }); }
  };
  // A paste: the whole run arrives at once and `input` fires with insertFromPaste and no `data`.
  page.paste = (text) => { insertAtCaret(text); fire({ inputType: 'insertFromPaste' }); };
  // Where the caret sits, as "NODENAME:offset of text", so a test can say it survived the swap.
  page.caret = () => {
    const s = window.getSelection();
    const n = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
    return n.nodeName + ':' + s.anchorOffset + ' of ' + JSON.stringify(s.anchorNode.textContent);
  };
  return page;
}

test('`## ` on a line opened with Enter converts live, caret at the end', () => {
  const page = rulesPage('<div class="block" data-i="0"><p>Everything else is second order.</p></div>');
  page.caretToEndOf(page.doc.querySelector('#doc p'));
  page.pressEnter();
  page.type('## Hello!');

  const block = page.block(0);
  assert.equal(block.children.length, 2, 'still ONE .block — the split happened inside it');
  assert.equal(block.lastElementChild.nodeName, 'H2', 'the line the caret is on became the heading');
  assert.equal(block.lastElementChild.textContent, 'Hello!', 'and the marker is gone from the text');
  assert.equal(block.firstElementChild.nodeName, 'P', 'the paragraph above is untouched');
  assert.equal(block.firstElementChild.textContent, 'Everything else is second order.');
  assert.equal(page.caret(), 'H2:6 of "Hello!"', 'the caret is at the end of the heading');
  assert.ok(page.isDirty() && page.saves.length, 'and the conversion scheduled a save');

  // Everything typed next flows into the heading, which is the point of keeping the caret.
  page.type(' there');
  assert.equal(block.lastElementChild.outerHTML, '<h2>Hello! there</h2>');
});

test('`### ` re-levels an h2 on a line opened with Enter after a heading', () => {
  // Chrome opens a bare <div> after a heading, not a <p>. The rule has to read that as a line.
  const page = rulesPage('<div class="block" data-i="0"><h2>1. Dark mode is the first fix</h2></div>');
  page.caretToEndOf(page.doc.querySelector('#doc h2'));
  assert.equal(page.pressEnter().nodeName, 'DIV', 'the browser leaves a bare div after a heading');
  page.type('### Sub');

  const block = page.block(0);
  assert.equal(block.children.length, 2);
  assert.equal(block.firstElementChild.outerHTML, '<h2>1. Dark mode is the first fix</h2>',
    'the heading above keeps its level');
  assert.equal(block.lastElementChild.outerHTML, '<h3>Sub</h3>');
  assert.equal(page.caret(), 'H3:3 of "Sub"');
});

test('`### ` re-levels an existing h2 in place', () => {
  const page = rulesPage('<div class="block" data-i="0"><h2>2. The reading column</h2></div>');
  const h2 = page.doc.querySelector('#doc h2');
  const r = page.doc.createRange(); r.selectNodeContents(h2); r.collapse(true);
  page.sel().removeAllRanges(); page.sel().addRange(r);
  page.type('### ');

  const block = page.block(0);
  assert.equal(block.children.length, 1, 'one line in, one line out');
  assert.equal(block.firstElementChild.outerHTML, '<h3>2. The reading column</h3>');
  assert.equal(page.caret(), 'H3:0 of "2. The reading column"', 'caret back at the start, where it was');
});

test('a marker pasted onto a line opened with Enter converts too', () => {
  // insertFromPaste carries no `data`, so a rule gated on the typed character would miss it.
  const page = rulesPage('<div class="block" data-i="0"><p>Everything else is second order.</p></div>');
  page.caretToEndOf(page.doc.querySelector('#doc p'));
  page.pressEnter();
  page.paste('- a list item');

  const block = page.block(0);
  assert.equal(block.lastElementChild.outerHTML, '<ul><li>a list item</li></ul>');
  assert.equal(block.firstElementChild.nodeName, 'P');
});

test('a blank line between the paragraph and the marker is still converted', () => {
  const page = rulesPage('<div class="block" data-i="0"><p>Everything else is second order.</p></div>');
  page.caretToEndOf(page.doc.querySelector('#doc p'));
  page.pressEnter(); page.pressEnter();
  page.type('## Hello!');

  const block = page.block(0);
  assert.deepEqual([...block.children].map(c => c.nodeName), ['P', 'P', 'H2'],
    'the blank line stays a blank line; only the line the caret is on converts');
});

test('the rule reads the caret line, never the block it happens to sit in', () => {
  // The regression in one assertion: a caret on the second line, a marker on the second line, and a
  // first line that matches nothing. Against firstElementChild this returns false.
  const page = rulesPage('<div class="block" data-i="0"><p>above</p><p>## below</p></div>');
  const second = page.doc.querySelectorAll('#doc p')[1];
  page.caretToEndOf(second);
  assert.equal(page.caretInner(page.block(0)), second, 'caretInner finds the line, not the block');
  assert.ok(page.runBlockRule(), 'and the rule fires on it');
  assert.equal(page.block(0).lastElementChild.outerHTML, '<h2>below</h2>');
});

test('an atomic block is never rewritten by an input rule', () => {
  // A rendered ```flow diagram carries its own source on __md; turning a line of it into a heading
  // would desync the block from the markdown it serializes back to.
  const page = rulesPage('<div class="block" data-i="0" data-atomic="1"><div>## not a heading</div></div>');
  page.caretToEndOf(page.doc.querySelector('#doc div div'));
  assert.equal(page.runBlockRule(), false, 'the rule declines an atomic block');
  assert.equal(page.block(0).innerHTML, '<div>## not a heading</div>', 'and leaves it byte for byte');
});

test('the converted line serializes to the marker it was typed from', () => {
  // The live DOM half of the round-trip meets the turndown half: convert through the real rule, then
  // run the block through the page's own turndown, and the file gets `## Hello!` under the paragraph.
  const page = rulesPage('<div class="block" data-i="0"><p>Everything else is second order.</p></div>');
  page.caretToEndOf(page.doc.querySelector('#doc p'));
  page.pressEnter();
  page.type('## Hello!');
  assert.equal(pageTd().turndown(page.block(0).innerHTML),
    'Everything else is second order.\n\n## Hello!');
});

// The block-format toolbar (the way OUT of a heading) has the same shape as type-to-format: it must
// act on the line the selection is on, not the block's first line. Codex's repro on PR 9: `First`,
// Enter, `## Second`, select Second, choose text: the H2 stayed; choosing H1 reformatted `First`.
test('the block-format toolbar reformats the selected line, not the first line of the block', () => {
  const m = PAGE.match(/(function setBlockFormat\(tag\) \{[\s\S]*?\n\})/);
  assert.ok(m, 'setBlockFormat is still one function in the page');
  const page = rulesPage('<div class="block"><p>First</p></div>');
  const { doc } = page;
  let dirty = false, saves = 0, hidden = 0;
  const setBlockFormat = new Function('document', 'getSelection', 'caretBlock', 'caretInner',
    'restoreSelection', 'hideTool', 'setStatus', 'scheduleSave',
    'let dirty = false;\n' + m[1] + '\nreturn setBlockFormat;')(
    doc, page.sel, page.caretBlock, page.caretInner, () => {}, () => { hidden++; }, () => {}, () => { saves++; });
  page.caretToEndOf(doc.querySelector('p'));
  page.pressEnter();
  page.type('## Second');
  const block = page.block(0);
  assert.equal(block.children[1].nodeName, 'H2', 'type-to-format made the second line an h2');
  // select the second line and choose "text"
  const r = doc.createRange(); r.selectNodeContents(block.children[1]);
  const s = page.sel(); s.removeAllRanges(); s.addRange(r);
  setBlockFormat('p');
  assert.equal(block.children[0].outerHTML, '<p>First</p>', 'the first line is untouched');
  assert.equal(block.children[1].outerHTML, '<p>Second</p>', 'the selected line became a paragraph');
  // and the other way: select it again, choose h1
  const r2 = doc.createRange(); r2.selectNodeContents(block.children[1]);
  s.removeAllRanges(); s.addRange(r2);
  setBlockFormat('h1');
  assert.equal(block.children[0].outerHTML, '<p>First</p>', 'still untouched');
  assert.equal(block.children[1].outerHTML, '<h1>Second</h1>', 'the selected line became an h1');
  assert.equal(hidden, 2, 'the toolbar closed each time'); assert.equal(saves, 2, 'and a save was scheduled');
});

// Restoring a comment is a new conversation turn, never an undo of a document edit.
test('restore keeps the conversation and suggestion decisions, survives stale PUTs and re-resolves', async () => {
  const file = 'restore.md', raw = 'The revised paragraph.\n';
  const archived = { id: 'restore1', kind: 'comment', by: 'alex', status: 'resolved',
    decidedAt: '2026-09-01T00:00:00.000Z', anchor: { quote: 'The revised paragraph.' },
    thread: [{ by: 'alex', text: 'Please revise this.', at: '1' }, { by: 'claude', text: 'Done.', at: '2' }] };
  const accepted = { id: 'restore-child', kind: 'suggestion', by: 'claude', status: 'accepted', replyTo: archived.id,
    decidedAt: archived.decidedAt, anchor: { quote: 'The original paragraph.' }, replacement: 'The revised paragraph.',
    thread: [{ by: 'alex', text: 'That works.', at: '3' }] };
  const rejected = { ...accepted, id: 'rejected-child', status: 'rejected', replacement: 'Other wording.' };
  fs.writeFileSync(path.join(dir, file), raw);
  fs.writeFileSync(path.join(dir, file + '.sidecar.json'), JSON.stringify({ items: [archived, accepted, rejected] }));
  const res = await post('/api/reopen', { path: file, id: archived.id });
  assert.equal(res.status, 200);
  const restored = (await res.json()).review.items[0];
  assert.equal(restored.status, 'open');
  assert.ok(restored.reopenedAt);
  assert.equal(restored.decidedAt, undefined);
  assert.deepEqual(restored.thread, archived.thread);
  assert.equal((await post('/api/reopen', { path: file, id: archived.id })).status, 409, 'double click does not create another turn');
  const stale = { ...archived, thread: [...archived.thread, { by: 'claude', text: 'A concurrent reply.', at: '4' }] };
  const merged = await put('/api/review', { path: file, review: { items: [stale, accepted, rejected] } }).then(j);
  assert.equal(merged.review.items[0].status, 'open', 'old resolved snapshot cannot close restored comment');
  assert.equal(merged.review.items[0].reopenedAt, restored.reopenedAt);
  assert.equal(merged.review.items[0].thread.length, 3, 'concurrent replies still merge');
  assert.deepEqual(merged.review.items.slice(1), [accepted, rejected]);
  assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), raw);
  assert.equal((await post('/api/reopen', { path: file, id: accepted.id })).status, 400);
  assert.equal((await post('/api/reopen', { path: file, id: rejected.id })).status, 400);
  assert.equal((await post('/api/reopen', { path: file, id: 'missing' })).status, 400);
  const saved = await fetch(`${BASE}/api/state?path=${file}`).then(j);
  assert.equal(saved.review.items[0].status, 'open', 'reload preserves restore');
  await post('/api/reject', { path: file, id: archived.id });
  const closed = await fetch(`${BASE}/api/state?path=${file}`).then(j);
  assert.equal(closed.review.items[0].status, 'resolved');
  const second = await post('/api/reopen', { path: file, id: archived.id }).then(j);
  assert.ok(second.review.items[0].reopenedAt > restored.reopenedAt, 'every restore starts a new generation');
  const after = await put('/api/review', { path: file, review: closed.review }).then(j);
  assert.equal(after.review.items[0].status, 'open', 'previous generation cannot resolve the next either');
});

test('restore with an obsolete quote wakes wait and reports its id plus the orphan', async () => {
  const file = 'restore-wait.md', abs = path.join(dir, file);
  fs.writeFileSync(abs, 'New wording.\n');
  fs.writeFileSync(abs + '.sidecar.json', JSON.stringify({ items: [{ id: 'orphan-restore', kind: 'comment', by: 'alex',
    status: 'resolved', decidedAt: '2026-09-01T00:00:00.000Z', matchedAt: '2026-09-01T00:00:00.000Z',
    anchor: { quote: 'Old wording.' }, thread: [{ by: 'claude', text: 'Edited.', at: '1' }] }] }));
  cliE(dir, { SIDECAR_AGENT: 'restore-test' }, 'digest', file);
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', abs, '--timeout', '5'],
    { env: { ...process.env, SIDECAR_AGENT: 'restore-test', SIDECAR_PORT: '4990' }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', d => out += d);
  const exited = new Promise(res => w.on('exit', res));
  await new Promise(res => setTimeout(res, 400));
  const response = await post('/api/reopen', { path: file, id: 'orphan-restore' }).then(j);
  assert.equal(response.review.items[0].status, 'orphaned');
  assert.equal(response.review.items[0].orphanReason, 'text-changed');
  assert.equal(await exited, 0);
  assert.match(out, /REOPENED orphan-restore/);
  assert.match(out, /ORPHANED/);
  assert.match(cliE(dir, { SIDECAR_AGENT: 'restore-test' }, 'digest', file), /nothing new/);
});

test('restore digest catches a resolve/reopen cycle even if the cursor last saw it open', () => {
  const { snapshot, computeDigest, renderDigest } = require('./lib/digest.js');
  const item = { id: 'cycle', kind: 'comment', status: 'open', by: 'alex', anchor: { quote: 'Text.' }, thread: [] };
  const before = snapshot({ items: [item] }, sha_of('Text.'));
  const d = computeDigest(before, { items: [{ ...item, reopenedAt: '2026-09-17T12:00:00.000Z' }] }, 'Text.', 'claude', 'Text.');
  assert.equal(d.empty, false);
  assert.match(renderDigest(d), /REOPENED cycle/);
});

test('restored comment generation survives either merge direction and partial agent replies', () => {
  const { mergeItem } = require('./lib/review.js');
  const old = { id: 'c', kind: 'comment', status: 'resolved', decidedAt: '2026-09-17T12:00:00.000Z' };
  const fresh = { id: 'c', kind: 'comment', status: 'open', reopenedAt: '2026-09-17T12:00:01.000Z' };
  for (const merged of [mergeItem(old, fresh), mergeItem(fresh, old), mergeItem(fresh, { id: 'c', thread: [{ text: 'Reply' }] })]) {
    assert.equal(merged.status, 'open'); assert.equal(merged.decidedAt, undefined);
    assert.equal(merged.reopenedAt, fresh.reopenedAt);
  }
  assert.equal(mergeItem(fresh, { ...fresh, status: 'resolved', decidedAt: '2026-09-17T12:00:02.000Z' }).status, 'resolved');
});

function restoreHarness(api) {
  const m = PAGE.match(/async function reopenItem\([^)]*\) \{[\s\S]*?\n\}/);
  const state = { review: { items: [{ id: 'c', kind: 'comment', status: 'resolved' }] } };
  const alerts = [], cardFold = new Map(), frames = [];
  let renders = 0;
  const make = new Function('api', 'state', 'alert', 'cardFold', 'renderSide', 'requestAnimationFrame', '$', 'CSS',
    `let FILE = 'doc.md', sideTab = 'archived'; ${m[0]}; return { reopenItem, tab: () => sideTab, navigate: () => FILE = 'other.md' };`);
  const fns = make(api, state, msg => alerts.push(msg), cardFold, () => renders++, fn => frames.push(fn),
    () => ({ querySelector: () => null }), { escape: x => x });
  return { ...fns, state, alerts, cardFold, frames, renders: () => renders };
}

test('restore UI waits for success and keeps the archive usable on request failure', async () => {
  const h = restoreHarness(async () => { throw new Error('offline'); });
  const before = structuredClone(h.state.review), button = { disabled: false };
  await h.reopenItem('c', button);
  assert.deepEqual(h.state.review, before);
  assert.equal(h.tab(), 'archived'); assert.equal(h.renders(), 0);
  assert.equal(button.disabled, false); assert.match(h.alerts[0], /restore failed: offline/);
});

test('restore UI selects Active and expands the same thread only on the original document', async () => {
  const review = { items: [{ id: 'c', kind: 'comment', status: 'open' }] };
  const h = restoreHarness(async () => ({ review }));
  await h.reopenItem('c', { disabled: false });
  assert.equal(h.state.review, review); assert.equal(h.tab(), 'active'); assert.equal(h.cardFold.get('c'), 'full');
  assert.equal(h.renders(), 1);
  let complete;
  const other = restoreHarness(() => new Promise(res => complete = res));
  const pending = other.reopenItem('c', { disabled: false });
  other.navigate(); complete({ review }); await pending;
  assert.equal(other.state.review.items[0].status, 'resolved'); assert.equal(other.renders(), 0);
});

test('settled nested suggestions render their history without decision controls', () => {
  const render = CARD_FN('nestedSugHtml', 'esc', 'whoCls', 'diffHtml', 'proseHtml', 'threadHtml')(
    x => x, () => 'agent', (q, r) => q + r, x => x, thread => thread.map(m => m.text).join(''));
  const dom = new JSDOM('<body></body>');
  for (const status of ['accepted', 'rejected']) {
    dom.window.document.body.innerHTML = render({ id: 's', by: 'claude', status, anchor: { quote: 'Old' }, replacement: 'New', thread: [{ text: 'Keep this history.' }] });
    assert.equal(dom.window.document.querySelector('button'), null);
    assert.ok(dom.window.document.querySelector('.badge.' + status));
    assert.match(dom.window.document.body.textContent, /Keep this history/);
  }
});


test('CLI resolve and reply --resolve close the restored generation', async () => {
  const file = 'restore-cli.md', abs = path.join(dir, file);
  fs.writeFileSync(abs, 'Some text.\n');
  fs.writeFileSync(abs + '.sidecar.json', JSON.stringify({ items: [{ id: 'cli-restore', kind: 'comment', by: 'alex',
    status: 'resolved', anchor: { quote: 'Some text.' }, thread: [] }] }));
  for (const args of [['resolve', file, 'cli-restore'], ['reply', file, 'cli-restore', 'Handled.', '--resolve']]) {
    const res = await post('/api/reopen', { path: file, id: 'cli-restore' });
    assert.equal(res.status, 200);
    const restored = (await res.json()).review.items[0];
    cli(dir, ...args);
    const saved = JSON.parse(fs.readFileSync(abs + '.sidecar.json')).items[0];
    assert.equal(saved.status, 'resolved');
    assert.equal(saved.reopenedAt, restored.reopenedAt);
  }
});


test('restoring a comment resumes a finished review and resists the old done session', async () => {
  const file = 'restore-done.md', abs = path.join(dir, file);
  fs.writeFileSync(abs, 'Some text.\n');
  const original = { items: [{ id: 'done-restore', kind: 'comment', by: 'alex', status: 'resolved',
    anchor: { quote: 'Some text.' }, thread: [] }], session: { done: true, state: 'idle', at: '2099-01-01T00:00:00.000Z' } };
  fs.writeFileSync(abs + '.sidecar.json', JSON.stringify(original));
  cliE(dir, { SIDECAR_AGENT: 'done-restore-test' }, 'digest', file);
  const result = await post('/api/reopen', { path: file, id: 'done-restore' }).then(j);
  assert.equal(result.review.session.done, false);
  assert.ok(result.review.session.at > original.session.at, 'new authority even if the previous clock was ahead');
  const merged = await put('/api/review', { path: file, review: original }).then(j);
  assert.equal(merged.review.session.done, false);
  assert.equal(merged.review.items[0].status, 'open');
  const output = cliE(dir, { SIDECAR_AGENT: 'done-restore-test' }, 'digest', file);
  assert.match(output, /REOPENED done-restore/);
  assert.match(output, /DONE: false/);
});


test('restore then reanchor survives a pre-restore browser snapshot while its unrelated reply merges', async () => {
  const file = 'restore-anchor.md', abs = path.join(dir, file);
  fs.writeFileSync(abs, 'Current paragraph.\n\nOther paragraph.\n');
  const old = { items: [
    { id: 'anchor-restore', kind: 'comment', by: 'alex', status: 'resolved', anchor: { quote: 'Original paragraph.' }, thread: [] },
    { id: 'other-thread', kind: 'comment', by: 'alex', status: 'open', anchor: { quote: 'Other paragraph.' }, thread: [] },
  ] };
  fs.writeFileSync(abs + '.sidecar.json', JSON.stringify(old));
  const res = await post('/api/reopen', { path: file, id: 'anchor-restore' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).review.items[0].status, 'orphaned');
  cli(dir, 'reanchor', file, 'anchor-restore', '--quote', 'Current paragraph.');
  const reanchored = JSON.parse(fs.readFileSync(abs + '.sidecar.json')).items[0];
  assert.equal(reanchored.status, 'open', 'explicit partial reanchor still takes effect');
  old.items[1].thread.push({ by: 'alex', at: '2026-09-17T12:00:00.000Z', text: 'An unrelated reply.' });
  await put('/api/review', { path: file, review: old });
  const result = await fetch(`${BASE}/api/state?path=${file}`).then(j);
  assert.equal(result.review.items[0].status, 'open');
  assert.deepEqual(result.review.items[0].anchor, reanchored.anchor);
  assert.equal(result.review.items[0].matchedAt, reanchored.matchedAt);
  assert.equal(result.review.items[0].orphanReason, undefined);
  assert.deepEqual(result.review.items[1].thread, old.items[1].thread);
});

test('older restore generations cannot merge obsolete element paths or liveness metadata', () => {
  const { mergeItem } = require('./lib/review.js');
  const current = { id: 'element-restored', kind: 'comment', status: 'open', reopenedAt: '2026-09-17T12:00:00.000Z',
    anchor: { quote: 'Current', element: { sel: '#current' } }, matchedAt: '2026-09-17T12:00:01.000Z' };
  const old = { id: current.id, kind: 'comment', status: 'resolved',
    anchor: { quote: 'Old', element: { sel: '#old', path: 'div:nth-child(1)', sig: 'Old' } },
    matchedAt: '2026-09-01T12:00:00.000Z', orphanReason: 'element-changed' };
  const merged = mergeItem(current, old);
  assert.deepEqual(merged.anchor, current.anchor);
  assert.equal(merged.matchedAt, current.matchedAt);
  assert.equal(merged.orphanReason, undefined);
  const partial = mergeItem(current, { id: current.id, anchor: { element: { path: 'div:nth-child(2)' } } });
  assert.equal(partial.anchor.element.path, 'div:nth-child(2)', 'fresh picker backfill still merges');
});

test('done reviewing completes a restored future-dated session through the real merge', async () => {
  const file = 'restore-finish.md', abs = path.join(dir, file);
  fs.writeFileSync(abs, 'Some text.\n');
  fs.writeFileSync(abs + '.sidecar.json', JSON.stringify({ items: [{ id: 'finish-restore', kind: 'comment', by: 'alex',
    status: 'resolved', anchor: { quote: 'Some text.' }, thread: [] }],
    session: { done: true, state: 'idle', at: '2099-01-01T00:00:00.000Z' } }));
  const restored = await post('/api/reopen', { path: file, id: 'finish-restore' }).then(j);
  assert.equal(restored.review.session.done, false);
  const oldSnapshot = structuredClone(restored.review);
  const client = { review: restored.review };
  const m = PAGE.match(/async function markDone\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(m);
  let rendered = false, announced = false;
  const markDone = new Function('state', 'api', 'FILE', 'renderSide', 'showBanner', 'alert', 'return ' + m[0])(
    client, async (verb, url, body) => {
      assert.equal(verb, 'PUT');
      const response = await put(url, body); assert.equal(response.status, 200); return response.json();
    }, file, () => rendered = true, () => announced = true, message => assert.fail(message));
  await markDone();
  assert.equal(client.review.session.done, true);
  assert.ok(client.review.session.at > oldSnapshot.session.at);
  assert.ok(rendered && announced);
  await put('/api/review', { path: file, review: oldSnapshot });
  const saved = await fetch(`${BASE}/api/state?path=${file}`).then(j);
  assert.equal(saved.review.session.done, true, 'a stale restored session cannot undo explicit completion');
});


test('digest reports the final resolution when a restore and resolution happen between snapshots', () => {
  const { snapshot, computeDigest, renderDigest } = require('./lib/digest.js');
  const raw = 'A paragraph.';
  for (const status of ['resolved', 'open']) {
    const item = { id: 'restore-cycle', kind: 'comment', status, by: 'alex', anchor: { quote: raw },
      reopenedAt: '2026-09-17T12:00:00.000Z', thread: [{ by: 'claude', text: 'Earlier reply.', at: '1' }] };
    const before = snapshot({ items: [item] }, sha_of(raw));
    const after = { items: [{ ...item, status: 'resolved', reopenedAt: '2026-09-17T12:01:00.000Z',
      decidedAt: '2026-09-17T12:02:00.000Z', thread: [...item.thread,
        { by: 'alex', text: 'I checked again. This is settled.', at: '2' },
        { by: 'claude', text: 'Acknowledged.', at: '3' }] }] };
    const d = computeDigest(before, after, raw, 'claude', raw);
    assert.deepEqual(d.reopened, [], 'the archived thread must not request an agent reply');
    assert.deepEqual(d.replies, []);
    assert.equal(d.decided.length, 1);
    assert.equal(d.decided[0].status, 'resolved');
    assert.deepEqual(d.decided[0].reasons, ['I checked again. This is settled.']);
    const output = renderDigest(d);
    assert.match(output, /RESOLVED/);
    assert.doesNotMatch(output, /REOPENED/);
    assert.match(output, /I checked again\. This is settled\./);
    assert.equal(computeDigest(d.snapshot, after, raw, 'claude', raw).empty, true, 'the completed cycle is consumed once');
  }
});

test('wait reports a completed restore cycle without marking the archived comment as replying', async () => {
  const file = 'restore-cycle-wait.md', abs = path.join(dir, file), agent = 'cycle-waiter';
  fs.writeFileSync(abs, 'A paragraph.\n');
  fs.writeFileSync(abs + '.sidecar.json', JSON.stringify({ items: [{ id: 'closed-cycle', kind: 'comment', by: 'alex',
    status: 'resolved', anchor: { quote: 'A paragraph.' }, thread: [] }] }));
  cliE(dir, { SIDECAR_AGENT: agent }, 'digest', file);
  const reopened = await post('/api/reopen', { path: file, id: 'closed-cycle' }).then(j);
  reopened.review.items[0].thread.push({ by: 'alex', text: 'Resolved after checking.', at: '2026-09-17T12:00:00.000Z' });
  await put('/api/review', { path: file, review: reopened.review });
  await post('/api/reject', { path: file, id: 'closed-cycle' });
  // The entire human cycle is already in the backlog when the watcher next looks.
  const w = spawn('node', [path.join(__dirname, 'server.js'), 'wait', abs, '--timeout', '5'],
    { env: { ...process.env, SIDECAR_AGENT: agent, SIDECAR_PORT: String(PORT) }, stdio: 'pipe' });
  let out = ''; w.stdout.on('data', d => out += d);
  const code = await new Promise(res => w.on('exit', res));
  assert.equal(code, 0);
  assert.match(out, /RESOLVED/); assert.match(out, /Resolved after checking\./);
  assert.doesNotMatch(out, /REOPENED/);
  const current = await fetch(`${BASE}/api/state?path=${file}`).then(j);
  assert.equal(current.presence.state, 'working');
  assert.deepEqual(current.presence.items, [], 'no replying light on the archived comment');
  assert.match(cliE(dir, { SIDECAR_AGENT: agent }, 'digest', file), /nothing new/);
});


test('digest includes new human replies when a restored comment becomes orphaned', () => {
  const { snapshot, computeDigest, renderDigest } = require('./lib/digest.js');
  const raw = 'Current paragraph.';
  const item = { id: 'orphan-reply', kind: 'comment', by: 'alex', status: 'resolved', anchor: { quote: 'Old paragraph.' },
    thread: [{ by: 'claude', text: 'Previous answer.', at: '1' }] };
  const before = snapshot({ items: [item] }, sha_of(raw));
  const review = { items: [{ ...item, status: 'orphaned', reopenedAt: '2026-09-17T12:00:00.000Z',
    orphanReason: 'text-changed', thread: [...item.thread,
      { by: 'alex', text: 'Please revisit the fee.', at: '2' },
      { by: 'alex', text: 'And keep the weekly office session.', at: '3' }] }] };
  const d = computeDigest(before, review, raw, 'claude', raw);
  assert.equal(d.reopened.length, 1); assert.equal(d.orphaned.length, 1);
  assert.deepEqual(d.replies.map(m => m.text), ['Please revisit the fee.', 'And keep the weekly office session.']);
  const output = renderDigest(d);
  assert.match(output, /REOPENED/); assert.match(output, /ORPHANED/);
  assert.match(output, /Please revisit the fee\./); assert.match(output, /And keep the weekly office session\./);
  assert.equal(computeDigest(d.snapshot, review, raw, 'claude', raw).empty, true);
});

test('a stale post-restore snapshot cannot undo repeated CLI reanchors and still carries replies and resolution', async () => {
  const file = 'restore-same-generation.md', abs = path.join(dir, file);
  fs.writeFileSync(abs, 'First paragraph.\n\nSecond paragraph.\n');
  fs.writeFileSync(abs + '.sidecar.json', JSON.stringify({ items: [{ id: 'restored-anchor', kind: 'comment', by: 'alex',
    status: 'resolved', anchor: { quote: 'Missing paragraph.' }, thread: [] }] }));
  let stale = (await post('/api/reopen', { path: file, id: 'restored-anchor' }).then(j)).review;
  const generation = stale.items[0].reopenedAt;
  let previousAnchorStamp = '';
  for (const quote of ['First paragraph.', 'Second paragraph.']) {
    cli(dir, 'reanchor', file, 'restored-anchor', '--quote', quote);
    const fresh = JSON.parse(fs.readFileSync(abs + '.sidecar.json')).items[0];
    assert.ok(fresh.reanchoredAt > previousAnchorStamp);
    assert.equal(fresh.reopenedAt, generation, 'reanchoring does not pretend the thread was restored again');
    previousAnchorStamp = fresh.reanchoredAt;
    stale.items[0].thread.push({ by: 'alex', text: 'Reply while viewing ' + stale.items[0].anchor.quote, at: quote });
    const merged = await put('/api/review', { path: file, review: stale }).then(j);
    assert.equal(merged.review.items[0].status, 'open', 'live status wins over the obsolete orphan snapshot');
    assert.equal(merged.review.items[0].anchor.quote, quote);
    assert.equal(merged.review.items[0].reanchoredAt, fresh.reanchoredAt);
    assert.equal(merged.review.items[0].orphanReason, undefined);
    assert.deepEqual(merged.review.items[0].thread, stale.items[0].thread);
    const reload = await fetch(`${BASE}/api/state?path=${file}`).then(j);
    assert.equal(reload.review.items[0].status, 'open');
    stale = structuredClone(merged.review);
  }
  // An actual resolve from a browser with older anchor knowledge must still close the thread.
  stale.items[0].anchor = { quote: 'Missing paragraph.' };
  delete stale.items[0].reanchoredAt;
  stale.items[0].status = 'resolved'; stale.items[0].decidedAt = new Date().toISOString();
  const closed = await put('/api/review', { path: file, review: stale }).then(j);
  assert.equal(closed.review.items[0].status, 'resolved');
  assert.equal(closed.review.items[0].anchor.quote, 'Second paragraph.');
  assert.equal(closed.review.items[0].reanchoredAt, previousAnchorStamp);
});

test('restored reanchor generations preserve terminal decisions and partial fresh anchor edits', () => {
  const { mergeItem } = require('./lib/review.js');
  const fresh = { id: 'c', kind: 'comment', status: 'open', reopenedAt: '2026-09-17T12:00:00.000Z',
    reanchoredAt: '2026-09-17T12:01:00.000Z', anchor: { quote: 'Current.' } };
  const stale = { ...fresh, status: 'orphaned', anchor: { quote: 'Old.' } }; delete stale.reanchoredAt;
  assert.equal(mergeItem(stale, fresh).status, 'open', 'newer anchor knowledge wins in either order');
  const partial = mergeItem(fresh, { id: 'c', anchor: { quote: 'Next.' }, reanchoredAt: '2026-09-17T12:02:00.000Z' });
  assert.equal(partial.anchor.quote, 'Next.');
  assert.equal(mergeItem({ ...fresh, status: 'resolved' }, stale).status, 'resolved', 'a stale orphan never reopens a resolved thread');
});


function assetFragmentHarness({ headerBottom, scrollY = 300, frameTop = -100, scale = 1,
    viewportHeight = 800, assetHeight = 1200, initialTail = '40vh', typewriter = false }) {
  const tailRule = STYLE.match(/body #doc\.asset\s*\{[^}]+\}/);
  const typewriterRule = STYLE.match(/body\.typewriter #doc\s*\{[^}]+\}/);
  assert.ok(tailRule, 'assets declare stable scroll room');
  const dom = new JSDOM('<!doctype html><style>#doc { padding-bottom:' + initialTail + '; }'
    + typewriterRule[0] + tailRule[0] + '</style><header></header><div id="doc" class="asset"></div>');
  dom.window.document.body.classList.toggle('typewriter', typewriter);
  dom.window.document.querySelector('header').getBoundingClientRect = () => ({ bottom: headerBottom });
  const frameEl = { contentWindow: {}, getBoundingClientRect: () => ({ top: frameTop, left: 0 }) };
  const framePageRect = CARD_FN('framePageRect', 'frameEl', 'frameScale')(frameEl, scale);
  const handler = PAGE.match(/window\.addEventListener\('message', \(e\) => \{[\s\S]*?\n\}\);/);
  assert.ok(handler, 'the asset message handler is present');
  let onMessage;
  const calls = [], actualScroll = [];
  const maxScroll = () => {
    // jsdom has no layout engine. Resolve the real padding rule and model the browser's scroll
    // bound: the bottom of the scaled frame plus document padding, less the viewport height.
    const tail = dom.window.getComputedStyle(dom.window.document.getElementById('doc')).paddingBottom;
    const padding = parseFloat(tail) * (tail.endsWith('vh') ? viewportHeight / 100 : 1);
    return Math.max(0, scrollY + frameTop + assetHeight * scale + padding - viewportHeight);
  };
  new Function('window', 'frameEl', 'framePageRect', 'document', 'scrollTo', 'scrollY', handler[0])(
    { addEventListener: (type, fn) => { assert.equal(type, 'message'); onMessage = fn; } },
    frameEl, framePageRect, dom.window.document, options => {
      calls.push(options); actualScroll.push(Math.max(0, Math.min(options.top, maxScroll())));
    }, scrollY);
  return { calls, actualScroll, maxScroll, dom, reveal: (rect, source = frameEl.contentWindow) => onMessage({ source, data: { type: 'sidecar:revealed', rect } }) };
}

test('asset fragment links place the target below the actual desktop or mobile header', () => {
  for (const [headerBottom, scale] of [[52, 1], [99, 0.5]]) {
    const h = assetFragmentHarness({ headerBottom, scale });
    const target = { top: 1200, left: 0, width: 400, height: 40 };
    h.reveal(target);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].behavior, 'smooth');
    const targetPageY = 300 - 100 + target.top * scale;
    assert.equal(targetPageY - h.calls[0].top, headerBottom + 12,
      'the heading lands twelve pixels below the measured sticky header, including mobile safe area');
    h.dom.window.close();
  }
});

test('asset fragment navigation clamps the document start and ignores missing or foreign targets', () => {
  const h = assetFragmentHarness({ headerBottom: 99, scrollY: 0, frameTop: 0 });
  h.reveal({ top: 20, left: 0, width: 100, height: 20 });
  assert.equal(h.calls[0].top, 0, 'a heading near the start never requests a negative scroll');
  h.reveal(null);
  h.reveal({ top: 900, left: 0, width: 100, height: 20 }, {});
  assert.equal(h.calls.length, 1, 'only a resolved target from the active frame can scroll');
  h.dom.window.close();
});


test('the last asset fragment reaches the header after the browser clamps to the document scroll limit', () => {
  for (const [headerBottom, viewportHeight, scale, initialTail] of [[52, 800, 1, '40vh'], [99, 844, 0.5, '42vh']]) {
    const h = assetFragmentHarness({ headerBottom, viewportHeight, scale, initialTail });
    const target = { top: 1180, left: 0, width: 400, height: 20 };
    const targetPageY = 300 - 100 + target.top * scale;
    const requested = targetPageY - headerBottom - 12;
    const oldLimit = 300 - 100 + 1200 * scale + parseFloat(initialTail) * viewportHeight / 100 - viewportHeight;
    assert.ok(oldLimit < requested, 'the previous reading tail would clamp this final heading too low');
    h.reveal(target);
    assert.equal(targetPageY - h.actualScroll[0], headerBottom + 12,
      'the final heading actually reaches the header offset after browser-style clamping');
    assert.equal(h.actualScroll[0], h.calls[0].top, 'the new room makes the requested position reachable');
    h.dom.window.close();
  }
});


test('Back restores a final asset fragment below the header on a fresh document view', () => {
  for (const [headerBottom, viewportHeight, scale, initialTail] of [[52, 800, 1, '40vh'], [99, 844, 0.5, '42vh']]) for (const typewriter of [false, true]) {
    const options = { headerBottom, viewportHeight, scale, initialTail, typewriter };
    const outgoing = assetFragmentHarness(options);
    const target = { top: 1180, left: 0, width: 400, height: 20 };
    outgoing.reveal(target);
    const savedY = outgoing.actualScroll[0];
    outgoing.dom.window.close();
    // Navigating away discards the asset DOM. Back creates a fresh one with its ordinary asset class,
    // so sufficient scroll room must exist before any new fragment click.
    const incoming = assetFragmentHarness(options);
    const doc = incoming.dom.window.document;
    Object.defineProperty(doc.documentElement, 'scrollHeight', { get: () => incoming.maxScroll() + viewportHeight });
    const calls = [], deferred = [];
    const funcs = ['applyPendingScroll', 'restoreScroll'].map(name => {
      const match = PAGE.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
      assert.ok(match); return match[0];
    }).join('\n');
    const restore = new Function('document', 'window', 'requestAnimationFrame', 'setTimeout',
      'let pendingScrollY = null;\n' + funcs + '\nreturn restoreScroll;')(
      doc, { innerHeight: viewportHeight, scrollTo: options => calls.push(Math.min(options.top, incoming.maxScroll())) },
      fn => deferred.push(fn), fn => deferred.push(fn));
    restore(savedY); deferred.forEach(fn => fn());
    assert.equal(calls[0], savedY, 'the saved position is reachable without a fragment navigation first');
    const targetPageY = 300 - 100 + target.top * scale;
    assert.equal(targetPageY - calls[0], headerBottom + 12, 'Back keeps the final heading below the app header');
    doc.getElementById('doc').classList.remove('asset');
    assert.equal(incoming.dom.window.getComputedStyle(doc.getElementById('doc')).paddingBottom, typewriter ? '58vh' : initialTail,
      'the additional tail belongs to HTML assets only');
    incoming.dom.window.close();
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   THE PAGE WIDTH AS A NUMBER (public/measure.js)
   Three named widths became one number in em, dragged on the document's own
   edge or set from a slider, stored under the key the names lived under.
   ──────────────────────────────────────────────────────────────────────────── */
const Measure = require('./public/measure.js');   // the SAME file index.html loads in <head>

test('the measure reads the three old names as the widths they were, and a number as itself', () => {
  assert.equal(Measure.KEY, 'sidecar.measure', 'the key the names lived under, so a saved choice survives');
  assert.equal(Measure.parse('narrow'), 29);
  assert.equal(Measure.parse('default'), 33);
  assert.equal(Measure.parse('wide'), 39);
  assert.equal(Measure.parse('45'), 45);
  assert.equal(Measure.parse('30.5'), 30.5);
  assert.equal(Measure.parse('30.3'), 30.5, 'half-em steps');
  assert.equal(Measure.parse(null), 33, 'nothing stored is the default');
  assert.equal(Measure.parse(''), 33);
  assert.equal(Measure.parse('constructor'), 33, 'a stored prototype name is not a width');
  assert.equal(Measure.parse('10'), 33, 'under the floor is not honoured');
  assert.equal(Measure.parse('99px; }'), 33, 'junk never reaches the style attribute');
  assert.ok(Measure.parse('1000') === 1000, 'and there is no ceiling: past the column it is the column');
  assert.equal(Measure.MIN, 26);
  assert.equal(Measure.DEFAULT, 33);
});

test('the stamp applies the measure before the first paint, and falls back without the module', () => {
  assert.ok(PAGE.indexOf('src="/measure.js"') < PAGE.indexOf('Measure.read(localStorage)'),
    'the module is loaded before the stamp that calls it');
  assert.ok(PAGE.indexOf('Measure.read(localStorage)') < PAGE.indexOf('<style>'), 'and both are ahead of the stylesheet');
  const run = (cell, withModule) => {
    const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
    new Function('localStorage', 'document', 'Themes', 'Measure', STAMP)(
      { getItem: (k) => (k in cell ? cell[k] : null) }, doc, Themes, withModule ? Measure : undefined);
    return doc.documentElement.style.getPropertyValue('--measure');
  };
  assert.equal(run({ 'sidecar.measure': 'wide' }, true), '39em', 'a name from before the upgrade');
  assert.equal(run({ 'sidecar.measure': '48.5' }, true), '48.5em', 'a number');
  assert.equal(run({}, true), '33em');
  assert.equal(run({ 'sidecar.measure': 'wide' }, false), '33em', 'no module: the default rather than no column');
  assert.doesNotMatch(PAGE, /data-measure|dataset\.measure/, 'the three named states are gone from the page');
  assert.doesNotMatch(PAGE, /cycleMeasure/, 'and so is the cycle');
});

test('a drag on the document edge is twice the pointer\'s travel, clamped to the column', () => {
  // A 1000px column centred on 500, 88px of gutters, 16.5px type. The default 33em puts the edge at
  // 500 + (33 × 16.5 + 88) / 2 = 816.25, and moving it one pixel widens the text by two.
  const full = Measure.fullEm(1000, 88, 16.5);
  assert.equal(full, 55.5, 'the widest measure that changes anything at this column');
  const m = { center: 500, gutter: 88, fontSize: 16.5, max: full };
  assert.equal(Measure.fromEdge({ ...m, x: 816.25 }), 33);
  assert.equal(Measure.fromEdge({ ...m, x: 900 }), 43);
  assert.equal(Measure.fromEdge({ ...m, x: 600 }), 26, 'the floor');
  assert.equal(Measure.fromEdge({ ...m, x: 5000 }), full, 'pinned at the column');
  assert.equal(Measure.fromEdge({ ...m, x: 900, fontSize: 0 }), 33, 'no type size to resolve against is the default');
  assert.ok(Measure.isFull(55.5, full));
  assert.ok(Measure.isFull(55, full), 'within an em of the column reads as full: a scrollbar moves the column that much');
  assert.ok(!Measure.isFull(50, full));
  assert.equal(Measure.step(33, 1, false, full), 34, 'one em a key');
  assert.equal(Measure.step(33, 1, true, full), 37, 'four with shift');
  assert.equal(Measure.step(26, -1, false, full), 26, 'held at the floor');
  assert.equal(Measure.step(55, 1, true, full), 55.5, 'and at the column');
  assert.equal(Measure.format(33.26), '33.5', 'stored on the half em');
  assert.equal(Measure.iconScale(33), 1, 'the icon rests at the default');
  assert.ok(Measure.iconScale(26) < 1 && Measure.iconScale(39) > 1, 'and moves in and out with the column');
  assert.equal(Measure.iconScale(200), 1.35, 'without drawing its rules off the button');
  const doc = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  assert.equal(Measure.boot(doc, { getItem: () => 'narrow' }), 29);
  assert.equal(doc.documentElement.style.getPropertyValue('--measure'), '29em');
  assert.equal(Measure.boot(doc, { getItem: () => { throw new Error('private mode'); } }), 33, 'a throwing store is the default');
});

test('the page writes the measure under its old key, and the edge follows every relayout', () => {
  assert.match(PAGE, /localStorage\.setItem\(Measure\.KEY, Measure\.format\(measureEm\)\)/,
    'one write, at the end of a drag, under the key the names used');
  assert.match(PAGE, /function relayoutDoc\(\) \{ if \(isAsset\(\)\) sizeFrame\(\); scheduleDock\(\); layoutDocGrip\(\); \}/,
    'the edge is placed by the same call every column change already makes');
  assert.match(PAGE, /<div id="docGrip" role="separator" aria-orientation="vertical"[^>]*tabindex="0"/,
    'a separator, operable from the keyboard like the two panel grips');
  assert.ok(PAGE.indexOf('id="measureToggle"') < PAGE.indexOf('id="measureRange"')
    && PAGE.indexOf('id="measureRange"') < PAGE.indexOf('id="proseToggle"'),
    'the icon opens the slider, in the slot the width has always had');
  assert.match(PAGE, /<input type="range" id="measureRange" min="26"/, 'the slider starts at the floor');
  assert.match(MOBILE, /#docGrip \{ display:none; \}/, 'no edge below the breakpoint, like the two panel grips');
  assert.match(STYLE, /body\.rail-dragging iframe, body\.nav-dragging iframe, body\.doc-dragging iframe \{ pointer-events:none; \}/,
    'an asset frame cannot swallow the drag');
  assert.match(STYLE, /#doc \{[\s\S]*?max-width:calc\(var\(--measure\) \+ 88px\)/,
    'the em still resolves against #doc\'s own size, so the type scale rule holds');
  const block = PAGE.slice(PAGE.indexOf('// ---------- the page width ----------'),
    PAGE.indexOf('// ---------- the document\'s type size ----------'));
  assert.match(block, /if \(!railResizable\(\) \|\| isAsset\(\)\) return;/, 'desktop and prose only, the rail\'s own guard');
  assert.match(block, /const ro = new ResizeObserver\(\(\) => layoutDocGrip\(\)\);\s+ro\.observe\(\$\('doc'\)\);\s+ro\.observe\(\$\('doc'\)\.parentElement\);/,
    'and the edge follows a size change nobody asked a relayout for, of the document or of its column');
  assert.match(PAGE, /scheduleDock\(\);\n  layoutDocGrip\(\);\s+\/\/ the column moved/, 'and a window resize re-places it');
  assert.match(block, /try \{ return Measure\.read\(localStorage\); \} catch \{ return Measure\.DEFAULT; \}/,
    'touching localStorage at all is guarded, as the stamp guards it');
});

/* ────────────────────────────────────────────────────────────────────────────
   A TABLE'S COLUMN WIDTHS (public/tablecols.js)
   A view preference: dragged on a header cell's edge, remembered per document
   and table ordinal, put back after every render, never in the markdown.
   ──────────────────────────────────────────────────────────────────────────── */
test('column widths parse strictly, store sparsely, and pin the row on the first move', () => {
  assert.deepEqual(TableCols.parse(''), {});
  assert.deepEqual(TableCols.parse('nope'), {});
  assert.deepEqual(TableCols.parse('[1]'), {});
  assert.deepEqual(TableCols.parse('{"a":{"0":100}}'), {}, 'a table is an ordinal');
  assert.deepEqual(TableCols.parse('{"0":{"1":120,"x":5,"2":"120","3":10}}'), { 0: { 1: 120 } },
    'a column is an ordinal, a width is an integer, and under the floor is dropped: it is echoed into a style');
  let w = TableCols.set({}, 0, 1, 120.4);
  assert.deepEqual(w, { 0: { 1: 120 } });
  w = TableCols.set(w, 0, 0, 10);
  assert.equal(TableCols.width(w, 0, 0), TableCols.MIN_COL, 'floored');
  assert.equal(TableCols.width(w, 2, 0), null);
  w = TableCols.reset(w, 0, 1);
  assert.deepEqual(w, { 0: { 0: 48 } });
  w = TableCols.reset(w, 0, 0);
  assert.deepEqual(w, {}, 'an emptied table leaves no key behind');
  assert.deepEqual(TableCols.reset({}, 3, 3), {});
  assert.equal(TableCols.serialize({}), '', 'nothing remembered stores nothing');
  assert.equal(TableCols.serialize({ 0: { 1: 120 } }), '{"0":{"1":120}}');
  assert.deepEqual(TableCols.fill({ 0: { 1: 300 } }, 0, [95, 191, 197, 61]), { 0: { 0: 95, 1: 300, 2: 197, 3: 61 } },
    'every column pinned where it measures, except the one already remembered');
  const before = { 0: { 1: 300 } };
  TableCols.set(before, 0, 2, 50);
  assert.deepEqual(before, { 0: { 1: 300 } }, 'set returns a new object rather than writing into the old one');
  assert.equal(TableCols.key('a/b.md'), 'tableCols:a/b.md', 'per document');
});

test('the grab zone is five pixels either side of a header cell\'s right edge, the last edge included', () => {
  const rects = [{ left: 0, right: 100, top: 0, bottom: 30 }, { left: 100, right: 250, top: 0, bottom: 30 },
    { left: 250, right: 300, top: 0, bottom: 30 }];
  assert.equal(TableCols.BAND, 5);
  assert.equal(TableCols.zone(rects, 98, 10), 0, 'the last pixels of a cell');
  assert.equal(TableCols.zone(rects, 104, 10), 0, 'and the first of the next belong to the same boundary');
  assert.equal(TableCols.zone(rects, 106, 10), -1);
  assert.equal(TableCols.zone(rects, 50, 10), -1, 'the middle of a cell is text');
  assert.equal(TableCols.zone(rects, 299, 10), 2, 'the last column\'s edge is how the table grows');
  assert.equal(TableCols.zone(rects, 100, 40), -1, 'outside the header row is not a boundary');
  assert.equal(TableCols.zone(rects, 98, 10, 1), -1, 'the band is a parameter');
  assert.equal(TableCols.resize(200, -30), 170);
  assert.equal(TableCols.resize(200, -500), TableCols.MIN_COL, 'a drag past the floor pins there');
});

test('apply puts a width and a floor on the header cell, and takes both off', () => {
  const { window } = new JSDOM('<!doctype html><div id="doc">'
    + '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    + '<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table></div>');
  const tables = [...window.document.querySelectorAll('table')];
  TableCols.apply(tables, { 0: { 1: 120 }, 1: { 0: 70 } });
  const ths = [...tables[0].querySelectorAll('th')];
  assert.equal(ths[0].getAttribute('style'), null, 'a column with nothing remembered carries nothing');
  assert.equal(ths[1].style.width, '120px');
  assert.equal(ths[1].style.minWidth, '120px', 'the floor is what lets the table grow past its container and scroll');
  assert.equal(TableCols.headerCells(tables[1]).length, 2, 'a table with no <thead> uses its first row');
  assert.equal(tables[1].querySelector('td').style.width, '70px');
  assert.equal(tables[0].querySelector('td').getAttribute('style'), null, 'body cells are never touched');
  TableCols.apply(tables, {});
  assert.equal(ths[1].getAttribute('style') || '', '', 'released: both properties gone');
  assert.equal(tables[1].querySelector('td').getAttribute('style') || '', '');
  assert.equal(ths[1].hasAttribute('data-sc-col'), false, 'and the mark goes with them');
  // A width an author wrote into a raw-HTML table is not this module's to remove: a release puts it
  // back, and a cell the module never set is never touched.
  ths[0].setAttribute('style', 'width: 30%; min-width: 80px;');
  ths[1].setAttribute('style', 'width: 12em;');
  TableCols.apply(tables, { 0: { 0: 200 } });
  assert.equal(ths[0].style.width, '200px');
  assert.equal(ths[1].style.width, '12em', 'nothing remembered for it, so its own width stays');
  TableCols.apply(tables, {});
  assert.equal(ths[0].style.width, '30%', 'released: the author\'s width is back');
  assert.equal(ths[0].style.minWidth, '80px', 'and the author\'s floor');
  assert.equal(ths[1].style.width, '12em');
  assert.equal(tables[0].querySelector('[data-sc-col]'), null);
});

test('the page re-applies the widths after every render, after the baselines, and never through the save path', () => {
  assert.match(PAGE, /<script src="\/tablecols\.js">/, 'the same file the tests require');
  const render = PAGE.match(/function renderDoc\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok(render.indexOf('b.md0 = toMd(el)') > -1 && render.indexOf('b.md0 = toMd(el)') < render.indexOf('applyTableCols()'),
    'widths go on after every block has its baseline, so a width can never read as an edit');
  assert.match(PAGE, /function applyTableCols\(\) \{\n  tableCols = TableCols\.parse\(uiStore\.get\(TableCols\.key\(FILE\), ''\)\);/,
    'read per document, so a swap loads the incoming document\'s widths');
  const block = PAGE.slice(PAGE.indexOf('// ---------- a table\'s column widths ----------'),
    PAGE.indexOf('// ---------- the page width ----------'));
  assert.ok(block.length > 0);
  // The comments name the save path to say it is not used; the code must not.
  const code = block.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /dirty|scheduleSave|saveDoc|flushSave/,
    'a resize is a view preference: nothing here reaches the editor\'s save path');
  assert.match(block, /e\.pointerType === 'touch'/, 'touch never sees a handle');
  assert.match(block, /e\.preventDefault\(\);\s+\/\/ no caret/, 'a press on a boundary places no caret');
  assert.match(block, /uiStore\.set\(TableCols\.key\(FILE\), TableCols\.serialize\(tableCols\)\)/, 'per document, under the sc: prefix');
  assert.match(block, /TableCols\.fill\(tableCols, hit\.t,/, 'the first move pins the rest of the row');
  assert.match(STYLE, /#doc th\.col-grip \{ cursor:col-resize; border-right-color:var\(--ink\); \}/,
    'the cue is the cell\'s own border in ink, which reflows nothing');
  assert.match(STYLE, /#doc td, #doc th \{[^}]*box-sizing:border-box;/, 'so the stored number is the width the eye measured');
  assert.match(STYLE, /#doc table \{ display:block; width:max-content; max-width:100%; overflow-x:auto;/,
    'a table wider than the column still scrolls in its own box');
});
