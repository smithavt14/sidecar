/* margin test suite — spins the real server against a temp fixture dir and hits the real API.
   Run: npm test */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
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
const state = () => fetch(`${BASE}/api/state?path=doc.md`).then(j);
const put = (url, body) => fetch(`${BASE}${url}`, { method: 'PUT',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (url, body) => fetch(`${BASE}${url}`, { method: 'POST',
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-test-'));
  fs.writeFileSync(path.join(dir, 'doc.md'), DOC);
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: dir });
  proc = spawn('node', [path.join(__dirname, 'server.js'), dir],
    { env: { ...process.env, MARGIN_PORT: PORT }, stdio: 'pipe' });
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
  assert.deepEqual(texts, ['first human note', 'agent reply', 'second human note'], 'chronological by at');
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

test('tolerant anchor: quote without markdown tokens still matches', async () => {
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'doc.md.review.json'), 'utf8'));
  // file has "**bold** text"; quote it as visible text "bold text"
  review.items.push({ id: 'sug3', kind: 'suggestion', by: 'claude', status: 'pending',
    anchor: { quote: 'bold text', occurrence: 0 }, replacement: '**bold** prose' });
  fs.writeFileSync(path.join(dir, 'doc.md.review.json'), JSON.stringify(review));
  const r = await post('/api/accept', { path: 'doc.md', id: 'sug3' });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'), /\*\*bold\*\* prose/);
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
