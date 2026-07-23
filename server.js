#!/usr/bin/env node
/* sidecar — local review server. One file, one sidecar, filesystem is the sync layer. */
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

// ---------- `sidecar wait <file>` — the reactive-loop primitive (P1) ----------
// The agent backgrounds this after posting a draft. It fs-watches the sidecar + doc (no server needed,
// stays true to "the agent works through files") and returns the instant Alex does something: a new
// comment/reply, an accept/reject/resolve, a direct edit, or hitting "done". Wake-per-event, and it
// SLEEPS for free in between — the whole point (no polling, no token cost while Alex reviews). One run =
// one wake; the agent responds in-thread, then backgrounds another `sidecar wait`. `session.done` ends it.
function runWait(argv) {
  let file = null, timeoutSec = 900;   // 15-min backstop (Alex's call) so a background wait can't hang forever
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout') timeoutSec = Number(argv[++i]) || timeoutSec;
    else if (!file) file = argv[i];
  }
  if (!file) { console.error('usage: sidecar wait <file> [--timeout <seconds>]'); process.exit(2); }
  const abs = path.resolve(process.cwd(), file);
  // Fail loud: a relative path resolved from the wrong cwd would otherwise silently watch a nonexistent
  // file (and mis-key presence). Prefer an ABSOLUTE path; if relative, it must be relative to the served dir.
  if (!fs.existsSync(abs)) {
    console.error(`sidecar wait: no file at ${abs}\nPass an absolute path, or run from the served directory.`);
    process.exit(2);
  }
  const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const loadSafe = () => { try { return loadReview(abs); } catch { return { items: [] }; } };

  // Fixed baseline snapshot; every event is diffed against it. We exit on the first real delta, so a
  // fixed base is correct (no need to advance it).
  const base = (() => {
    const r = loadSafe(), items = {};
    for (const it of (r.items || [])) items[it.id] = { status: it.status, threadLen: (it.thread || []).length };
    return { items, docHash: sha(readSafe(abs)) };
  })();

  const clip = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  function emitDelta() {   // returns true (and prints a digest) iff there's something for the agent to act on
    const r = loadSafe(), lines = [];
    for (const it of (r.items || [])) {
      const q = clip(it.anchor && it.anchor.quote);
      const b = base.items[it.id];
      if (!b) {   // brand-new item since the wait began
        // A `flag: true` comment reads as a flag rather than a plain comment — a "look here" the agent
        // can spot without parsing anything. (The retired `run` concept had its own line here; gone now.)
        if (it.by === 'alex') { const m = (it.thread || []).slice(-1)[0], t = m ? m.text : '';
          lines.push(`- NEW ${it.flag ? 'flag' : it.kind} @ “${q}”: ${t}`); }
        continue;
      }
      for (const m of (it.thread || []).slice(b.threadLen)) if (m.by === 'alex') lines.push(`- REPLY @ “${q}”: ${m.text}`);
      if (b.status !== it.status && ['accepted', 'rejected', 'resolved'].includes(it.status)) lines.push(`- ${it.status.toUpperCase()} @ “${q}”`);
    }
    const done = !!(r.session && r.session.done);
    const docChanged = sha(readSafe(abs)) !== base.docHash;
    if (!lines.length && !docChanged && !done) return false;   // nothing actionable yet — keep sleeping
    let out = lines.length ? '## sidecar — your turn\n' + lines.join('\n') : '## sidecar — Alex finished';
    if (docChanged) { let diff = ''; try { diff = execFileSync('git', ['diff', '--', path.basename(abs)], { cwd: path.dirname(abs) }).toString().trim(); } catch {} if (diff) out += '\n\n### doc changes (git diff)\n```diff\n' + diff + '\n```'; }
    out += '\n\nDONE: ' + (done ? 'true' : 'false');
    console.log(out);
    return true;
  }

  // Best-effort presence: tell a running server "Claude is here" so the browser can show it. Purely
  // decorative and server-optional — if the POST fails (server down), the wait still works.
  const PORT = process.env.SIDECAR_PORT || 4880;
  const ping = (state, cb) => {   // cb fires once the POST settles (or 400ms elapses) so an exit-time ping can flush
    let settled = false; const fin = () => { if (!settled) { settled = true; cb && cb(); } };
    try {
      const body = JSON.stringify({ path: abs, state });
      const req = require('http').request({ host: '127.0.0.1', port: PORT, path: '/api/presence', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: `127.0.0.1:${PORT}` },
        }, (res) => { res.on('data', () => {}); res.on('end', fin); });
      req.on('error', fin); req.end(body); setTimeout(fin, 400);
    } catch { fin(); }
  };
  const leave = (code, pstate) => { clearInterval(beat); clearTimeout(timer); ping(pstate || 'idle', () => process.exit(code)); };

  // Something already actionable at startup (a delta, or done) → I'm about to handle it: show "working".
  if (emitDelta()) { ping('working', () => process.exit(0)); return; }

  ping('watching');
  const beat = setInterval(() => ping('watching'), 15000);   // heartbeat so a killed session goes stale, not stuck
  const timer = setTimeout(() => { console.log('still watching (no activity within ' + timeoutSec + 's)\n\nDONE: false'); leave(1, 'idle'); }, timeoutSec * 1000);
  const watcher = chokidar.watch([sidecarPath(abs), abs], { ignoreInitial: true });
  // Alex acted → the wait exits, but I'm now HANDLING it. Ping "working" (NOT idle) so the browser reads
  // "claude is working…" through my response window instead of "waiting for claude". Re-arming → "here".
  watcher.on('all', () => { if (emitDelta()) leave(0, 'working'); });
  process.on('SIGINT', () => leave(130, 'idle'));
}
if (process.argv[2] === 'wait') { runWait(process.argv.slice(3)); return; }   // subcommand: don't boot the server

// Boot-time code stamp (§6b): the whole "false orphan" incident was a launchd server running a matcher
// loaded hours before it was rewritten. Log the git sha + server.js mtime at startup, and surface it in
// /api/state, so "is the live server on current code?" is answerable at a glance.
const CODE_STAMP = (() => {
  let s = 'nogit'; try { s = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname }).toString().trim(); } catch {}
  let mt = ''; try { mt = fs.statSync(__filename).mtime.toISOString().slice(0, 19).replace('T', ' '); } catch {}
  return s + (mt ? ' · ' + mt : '');
})();

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
  // message. Messages have no id, so dedupe by the (by, at, text) tuple and keep INSERTION ORDER —
  // existing (already on disk) first, then the incoming new ones. A fresh reply is always appended last,
  // so insertion order is chronological WITHOUT trusting `at`, which an agent can stamp wrong (a guessed
  // timestamp put a reply above the comment it answered, 2026-07-22). Render order matches (threadHtml).
  const seen = new Set();
  const thread = [...(existing.thread || []), ...(incoming.thread || [])]
    .filter(m => { const k = JSON.stringify([m.by, m.at, m.text]); return seen.has(k) ? false : (seen.add(k), true); });
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
  try { diff = execFileSync('git', ['diff', '--', path.basename(abs)], { cwd: path.dirname(abs) }).toString(); } catch {}
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
