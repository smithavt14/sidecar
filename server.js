#!/usr/bin/env node
/* sidecar — local review server. One file, one sidecar, filesystem is the sync layer. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const chokidar = require('chokidar');
// Review-file load/save/merge lives in lib/review.js so the CLI runs the SAME logic (see lib/cli.js).
const { sidecarPath, loadReview, saveReview, findAnchor, annotateOrphans, spliceRisk, replacementRisk, mergeItem } = require('./lib/review.js');

// A terminal-style pwd for the doc: absolute path with $HOME collapsed to ~.
function pwdFor(abs) {
  const home = os.homedir();
  return abs === home || abs.startsWith(home + path.sep) ? '~' + abs.slice(home.length) : abs;
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = process.env.SIDECAR_PORT || 4880;
const rootIsFile = fs.existsSync(ROOT) && fs.statSync(ROOT).isFile();
const BASE_DIR = rootIsFile ? path.dirname(ROOT) : ROOT;

const app = express();

// Host allowlist — binding to loopback is NOT authentication: on a tailnet/LAN the port is
// reachable, and a browser on any origin can DNS-rebind to 127.0.0.1. Reject unexpected Host
// headers. SIDECAR_HOSTS (comma-separated) is how a user opts their own tailnet hostname in.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`,
  ...(process.env.SIDECAR_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)]);
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

// ---------- subcommands ----------
// `sidecar <verb> …` (wait, show, comment, suggest, …) is the agent's whole interface — see lib/cli.js.
// Dispatch BEFORE express/ROOT setup: under a subcommand argv[2] is the verb, so ROOT/BASE_DIR below
// would resolve to garbage. CLI commands resolve their own paths against cwd instead of safePath.
const cli = require('./lib/cli.js');
if (cli.isCommand(process.argv[2])) { cli.run(process.argv[2], process.argv.slice(3)); return; }

// Boot-time code stamp (§6b): the whole "false orphan" incident was a launchd server running a matcher
// loaded hours before it was rewritten. Log the git sha + server.js mtime at startup, and surface it in
// /api/state, so "is the live server on current code?" is answerable at a glance.
const CODE_STAMP = (() => {
  let s = 'nogit'; try { s = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname }).toString().trim(); } catch {}
  let mt = ''; try { mt = fs.statSync(__filename).mtime.toISOString().slice(0, 19).replace('T', ' '); } catch {}
  return s + (mt ? ' · ' + mt : '');
})();

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
        const scPath = sidecarPath(abs);
        const hasReview = fs.existsSync(scPath);
        // "last reviewed" = the most recent change to the doc OR its sidecar (an edit, accept, or comment
        // bumps one of the two), so a document you touched five minutes ago sorts to the top.
        let mtime = fs.statSync(abs).mtimeMs;
        if (hasReview) { try { mtime = Math.max(mtime, fs.statSync(scPath).mtimeMs); } catch (_) {} }
        files.push({ rel, open, hasReview, mtime });
      }
    }
  })(BASE_DIR);
  files.sort((a, b) => b.mtime - a.mtime);   // most-recently-reviewed first
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
  try { diff = execFileSync('git', ['diff', '--', path.basename(abs)], { cwd: path.dirname(abs), stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch {}
  res.json({ path: req.query.path, pwd: pwdFor(abs), markdown, review, diff, hash: sha(markdown),
    presence: presenceFor(abs), code: CODE_STAMP });
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
  // Coordination field `session` (turn state + the terminal `done`). Last-writer-wins by its `at`, so a
  // stale client PUT (the client echoes back the WHOLE review it loaded) can't regress a fresher session.
  const pickByAt = (a, b) => (!a ? b : !b ? a : (b.at || '') >= (a.at || '') ? b : a);
  const session = pickByAt(current.session, incoming.session);
  if (session) merged.session = session;
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
  // Last line of defence before bytes change. The matcher is block-tolerant so comments can anchor
  // across blocks; splicing across one destroys structure the human never saw in the diff.
  const risk = spliceRisk(raw, hit.start, hit.end) || replacementRisk(raw, hit.start, hit.end, it.replacement);
  if (risk) return res.status(409).json({ error: `refusing to apply — ${risk}. Re-anchor this suggestion to a single block.` });
  const next = raw.slice(0, hit.start) + it.replacement + raw.slice(hit.end);
  fs.writeFileSync(abs, next);
  it.status = 'accepted'; it.decidedAt = new Date().toISOString();
  // A suggestion written to answer a comment (replyTo) closes that comment when accepted — the ask was
  // fulfilled. Guarded so it never regresses an already-decided parent.
  if (it.replyTo) {
    const parent = review.items.find(i => i.id === it.replyTo);
    if (parent && !['resolved', 'accepted', 'rejected'].includes(parent.status)) { parent.status = 'resolved'; parent.decidedAt = it.decidedAt; }
  }
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

// ---------- presence (P1): "is the agent watching this file right now?" ----------
// Ephemeral + in-memory (keyed by absolute path), written by `sidecar wait` via POST /api/presence and
// read back in /api/state. In-memory, NOT the sidecar, so it never contends with review writes and never
// lands in git. A missing/stale (>40s, no heartbeat) or idle entry reads as "not here".
const presence = {};
const PRESENCE_TTL = 40000;    // "watching" is heartbeated every 15s, so a short TTL keeps it honest
const WORKING_TTL = 180000;    // "working" has NO heartbeat (the wait already exited while the agent composes),
                               // so give it a generous window; it's overwritten by the next "watching"/"idle".
function presenceFor(abs) {
  const p = presence[abs];
  if (!p || p.state === 'idle') return null;
  const ttl = p.state === 'working' ? WORKING_TTL : PRESENCE_TTL;
  return Date.now() - p.at < ttl ? { state: p.state, at: p.at } : null;
}
app.post('/api/presence', (req, res) => {
  let abs; try { abs = safePath(req.body.path); } catch { return res.json({ ok: true }); }   // unknown file → ignore (fail-safe)
  presence[abs] = { state: req.body.state || 'watching', at: Date.now() };
  const rel = path.relative(BASE_DIR, abs);
  for (const c of clients) c.write(`data: ${JSON.stringify({ event: 'presence', rel })}\n\n`);
  res.json({ ok: true });
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
  console.log(`sidecar ready → http://localhost:${PORT}${f}  [code ${CODE_STAMP}]`);
});
