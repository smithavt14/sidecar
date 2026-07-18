#!/usr/bin/env node
/* margin — local review server. One file, one sidecar, filesystem is the sync layer. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const chokidar = require('chokidar');
const Anchor = require('./public/anchor.js');   // the ONE shared content-anchor matcher (client loads the same file)

// A terminal-style pwd for the doc: absolute path with $HOME collapsed to ~.
function pwdFor(abs) {
  const home = os.homedir();
  return abs === home || abs.startsWith(home + path.sep) ? '~' + abs.slice(home.length) : abs;
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = process.env.MARGIN_PORT || 4880;
const rootIsFile = fs.existsSync(ROOT) && fs.statSync(ROOT).isFile();
const BASE_DIR = rootIsFile ? path.dirname(ROOT) : ROOT;

const app = express();

// Host allowlist — binding to loopback is NOT authentication: on a tailnet/LAN the port is
// reachable, and a browser on any origin can DNS-rebind to 127.0.0.1. Reject unexpected Host
// headers. MARGIN_HOSTS (comma-separated) is how a user opts their own tailnet hostname in.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`,
  ...(process.env.MARGIN_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)]);
app.use((req, res, next) => ALLOWED_HOSTS.has(req.headers.host) ? next() : res.status(403).json({ error: 'host not allowed' }));

app.use(express.json({ limit: '10mb' }));
// App shell must never be cached — a stale index.html shows a ghost UI after upgrades.
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store') }));
app.use('/lib', express.static(path.join(__dirname, 'node_modules'), { maxAge: '1d' }));

// ---------- helpers ----------
function safePath(rel) {
  const abs = path.resolve(BASE_DIR, rel);
  // startsWith(BASE_DIR) alone lets sibling-prefix dirs through (/a/b passes /a/bb) — require an
  // exact match or a real path-separator boundary.
  if (abs !== BASE_DIR && !abs.startsWith(BASE_DIR + path.sep)) throw new Error('path escapes root');
  return abs;
}
function sidecarPath(abs) { return abs + '.review.json'; }
function loadReview(abs) {
  const p = sidecarPath(abs);
  if (!fs.existsSync(p)) return { schema: 1, items: [] };   // genuinely absent → empty review
  // Present-but-unparseable must NOT masquerade as empty: a merge/write would then clobber a
  // corrupt sidecar with a subset and destroy items. Throw so callers surface it instead.
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveReview(abs, review) {
  const p = sidecarPath(abs);
  // Atomic write: a crash mid-write must not leave a truncated (corrupt) sidecar. Temp in same dir.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(review, null, 2));
  fs.renameSync(tmp, p);
}

// Content-anchor matching lives in the shared module so accept/format/orphan here and the client's
// highlight + occurrence code count occurrences the SAME way (same ws + markdown normalization).
const findAnchor = (raw, quote, occurrence = 0) => Anchor.findNth(raw, quote, occurrence);
function annotateOrphans(raw, review) {
  // Known limitation (M4): occurrence is a positional index, so if one of several identical spans is
  // deleted, a surviving duplicate shifts into the orphaned item's index and it silently re-anchors to
  // the wrong copy instead of orphaning. Fixing that needs anchor context (prefix/suffix), not just N.
  let changed = false;
  for (const it of review.items) {
    if (['resolved', 'accepted', 'rejected'].includes(it.status)) continue;
    const hit = findAnchor(raw, it.anchor.quote, it.anchor.occurrence || 0);
    if (!hit && it.status !== 'orphaned') { it.status = 'orphaned'; it.orphanedAt = new Date().toISOString(); changed = true; }
    if (hit && it.status === 'orphaned') { it.status = it.kind === 'suggestion' ? 'pending' : 'open'; delete it.orphanedAt; changed = true; }
  }
  return changed;
}

// Same-id review merge — the client always PUTs its ENTIRE (possibly stale) state.review, so a
// same-id item on disk may hold thread messages / a more-advanced status the client never saw
// (an agent appended them after the client loaded). Merge non-destructively instead of replacing.
const TERMINAL = new Set(['resolved', 'accepted', 'rejected']);
const statusRank = (s) => (TERMINAL.has(s) ? 2 : s === 'orphaned' ? 1 : 0);   // decided > orphaned > open/pending
// Pick the side representing the most-advanced/most-recent decision, so a stale write can never
// regress a decided card back to open, and orphaned can't clobber a real decision.
function reconcileStatus(existing, incoming) {
  const re = statusRank(existing.status), ri = statusRank(incoming.status);
  if (re !== ri) return re > ri ? existing : incoming;
  if (re === 2) return (incoming.decidedAt || '') >= (existing.decidedAt || '') ? incoming : existing; // later decision
  if (re === 1) return (incoming.orphanedAt || '') >= (existing.orphanedAt || '') ? incoming : existing;
  return incoming;   // both open/pending — incoming is the fresher edit
}
function mergeItem(existing, incoming) {
  // Scalars (replacement, note, anchor, flag, …): incoming is the fresher edit — take it when present.
  const merged = { ...existing, ...incoming };
  // Thread UNION — the crux: concurrent human+agent writes each carry their own reply, and a stale
  // client PUT would otherwise overwrite the on-disk thread and silently drop the other side's
  // message. Messages have no id, so dedupe by the (by, at, text) tuple; stable-sort by `at`.
  const seen = new Set();
  const thread = [...(existing.thread || []), ...(incoming.thread || [])]
    .filter(m => { const k = JSON.stringify([m.by, m.at, m.text]); return seen.has(k) ? false : (seen.add(k), true); })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));   // V8 sort is stable → chrono, ties keep insertion order
  merged.thread = thread;
  // Status + its timestamp, carried together from whichever side won.
  const win = reconcileStatus(existing, incoming);
  merged.status = win.status;
  if (win.decidedAt !== undefined) merged.decidedAt = win.decidedAt; else delete merged.decidedAt;
  if (win.orphanedAt !== undefined) merged.orphanedAt = win.orphanedAt; else delete merged.orphanedAt;
  return merged;
}

// ---------- api ----------
app.get('/api/files', (req, res) => {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) {
        const rel = path.relative(BASE_DIR, abs);
        const review = loadReview(abs);
        const open = review.items.filter(i => ['open', 'pending', 'orphaned'].includes(i.status)).length;
        files.push({ rel, open, hasReview: fs.existsSync(sidecarPath(abs)) });
      }
    }
  })(BASE_DIR);
  files.sort((a, b) => b.open - a.open || a.rel.localeCompare(b.rel));
  res.json({ files, defaultFile: rootIsFile ? path.relative(BASE_DIR, ROOT) : null });
});

app.get('/api/state', (req, res) => {
  const abs = safePath(req.query.path);
  const markdown = fs.readFileSync(abs, 'utf8');
  const review = loadReview(abs);
  // Only persist when orphan states actually changed — an unconditional write here
  // feeds the fs-watcher, which tells the client to reload, which calls this again: a storm.
  if (annotateOrphans(markdown, review)) saveReview(abs, review);
  let diff = '';
  // execFileSync + args array: no shell is spawned, so a filename with $(...) or backticks can't inject.
  try { diff = execFileSync('git', ['diff', '--', path.basename(abs)], { cwd: path.dirname(abs) }).toString(); } catch {}
  res.json({ path: req.query.path, pwd: pwdFor(abs), markdown, review, diff, hash: sha(markdown) });
});

app.put('/api/save', (req, res) => {
  const abs = safePath(req.body.path);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  // Optimistic lock: if the client says what it based its edit on, refuse to clobber a newer file.
  if (req.body.baseHash && sha(current) !== req.body.baseHash) {
    return res.status(409).json({ error: 'file changed on disk since load', hash: sha(current) });
  }
  // Preserve the file's existing line-ending style. The client renders with marked, which normalizes
  // token.raw to LF, so the content it PUTs is all-LF even for untouched blocks — writing it verbatim
  // would silently rewrite a CRLF file to LF on the first save. Detect the on-disk EOL and re-apply it:
  // normalize incoming CRLF→LF first, then (for a CRLF file) LF→CRLF, so we never emit \r\r\n.
  const crlf = /\r\n/.test(current);   // dominant EOL; brand-new/empty file defaults to LF
  const normalized = req.body.content.replace(/\r\n/g, '\n').replace(/\n/g, crlf ? '\r\n' : '\n');
  fs.writeFileSync(abs, normalized);
  // hash is the sha of what we actually wrote, so the client's next baseHash matches on-disk.
  res.json({ ok: true, hash: sha(normalized) });
});

app.put('/api/review', (req, res) => {
  const abs = safePath(req.body.path);
  // Merge by id, never replace wholesale: if the agent added items between the client's
  // load and this write, a full overwrite would silently delete them.
  const current = loadReview(abs);
  const incoming = req.body.review || { items: [] };
  // ids are echoed into the DOM by the client — reject anything but word/hyphen to close a stored-XSS vector.
  for (const it of incoming.items) if (!/^[\w-]+$/.test(it.id || '')) return res.status(400).json({ error: 'invalid item id' });
  const byId = new Map(current.items.map(i => [i.id, i]));
  // Same id → non-destructive merge (union thread, keep the more-advanced status); new id → insert.
  for (const it of incoming.items) byId.set(it.id, byId.has(it.id) ? mergeItem(byId.get(it.id), it) : it);
  const merged = { schema: current.schema || incoming.schema || 1, items: [...byId.values()] };
  saveReview(abs, merged);
  res.json({ ok: true, review: merged });
});

app.post('/api/accept', (req, res) => {
  const abs = safePath(req.body.path);
  const raw = fs.readFileSync(abs, 'utf8');
  const review = loadReview(abs);
  const it = review.items.find(i => i.id === req.body.id);
  if (!it || it.kind !== 'suggestion') return res.status(400).json({ error: 'no such suggestion' });
  // Idempotency guard: a double-click / retry must not splice the replacement in twice.
  if (it.status !== 'pending') return res.status(409).json({ error: 'already decided' });
  const hit = findAnchor(raw, it.anchor.quote, it.anchor.occurrence || 0);
  if (!hit) { it.status = 'orphaned'; saveReview(abs, review); return res.status(409).json({ error: 'anchor not found — orphaned' }); }
  const next = raw.slice(0, hit.start) + it.replacement + raw.slice(hit.end);
  fs.writeFileSync(abs, next);
  it.status = 'accepted'; it.decidedAt = new Date().toISOString();
  saveReview(abs, review);
  res.json({ ok: true });
});

app.post('/api/reject', (req, res) => {
  const abs = safePath(req.body.path);
  const review = loadReview(abs);
  const it = review.items.find(i => i.id === req.body.id);
  if (!it) return res.status(400).json({ error: 'no such item' });
  // Idempotency guard: don't re-decide an already-settled card (reject also resolves open comments).
  if (['accepted', 'rejected', 'resolved'].includes(it.status)) return res.status(409).json({ error: 'already decided' });
  it.status = it.kind === 'suggestion' ? 'rejected' : 'resolved';
  it.decidedAt = new Date().toISOString();
  saveReview(abs, review);
  res.json({ ok: true });
});

// Apply inline formatting from the UI at a verified content anchor — same safety as accept:
// re-anchor on current disk content, refuse (409) if the text has moved, mutate only the span.
function toggleWrap(raw, start, end, mark) {
  const inner = raw.slice(start, end);
  const before = raw.slice(Math.max(0, start - mark.length), start);
  const after = raw.slice(end, end + mark.length);
  if (inner.length >= mark.length * 2 && inner.startsWith(mark) && inner.endsWith(mark))
    return { start, end, text: inner.slice(mark.length, -mark.length) };   // unwrap inside selection
  if (before === mark && after === mark)
    return { start: start - mark.length, end: end + mark.length, text: inner }; // unwrap just outside
  return { start, end, text: mark + inner + mark };                        // wrap
}
app.post('/api/format', (req, res) => {
  const abs = safePath(req.body.path);
  const raw = fs.readFileSync(abs, 'utf8');
  const { quote, occurrence = 0, op, url } = req.body;
  const hit = findAnchor(raw, quote, occurrence || 0);
  if (!hit) return res.status(409).json({ error: 'anchor not found — text changed' });
  let seg;
  if (op === 'bold') seg = toggleWrap(raw, hit.start, hit.end, '**');
  else if (op === 'italic') seg = toggleWrap(raw, hit.start, hit.end, '_');
  else if (op === 'link') {
    const inner = raw.slice(hit.start, hit.end);
    const u = /[()\s]/.test(url || '') ? `<${url}>` : (url || '');
    seg = { start: hit.start, end: hit.end, text: `[${inner}](${u})` };
  } else return res.status(400).json({ error: 'unknown op' });
  const next = raw.slice(0, seg.start) + seg.text + raw.slice(seg.end);
  fs.writeFileSync(abs, next);
  res.json({ ok: true, hash: sha(next) });
});

// ---------- events (fs watch -> SSE) ----------
const clients = new Set();
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
chokidar.watch(BASE_DIR, {
  ignored: (p) => p.includes('node_modules') || path.basename(p).startsWith('.git'),
  ignoreInitial: true, depth: 6,
}).on('all', (event, p) => {
  if (!p.endsWith('.md') && !p.endsWith('.review.json')) return;
  const rel = path.relative(BASE_DIR, p.replace(/\.review\.json$/, ''));
  for (const c of clients) c.write(`data: ${JSON.stringify({ event, rel })}\n\n`);
});

// Terminal error handler — thrown errors (safePath escape, corrupt sidecar JSON.parse) become JSON,
// never an HTML stack trace leaking absolute paths. Route bodies are synchronous, so Express funnels
// their throws here automatically.
app.use((err, req, res, next) => { res.status(err.status || 400).json({ error: err.message }); });

app.listen(PORT, '127.0.0.1', () => {
  const f = rootIsFile ? `/?f=${encodeURIComponent(path.relative(BASE_DIR, ROOT))}` : '/';
  console.log(`margin ready → http://localhost:${PORT}${f}`);
});
