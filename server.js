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
// Where a review's images live and what counts as one — shared with the CLI's --image (lib/assets.js).
const { IMAGE_TYPES, MAX_BYTES, saveAsset } = require('./lib/assets.js');

// A terminal-style pwd for the doc: absolute path with $HOME collapsed to ~.
function pwdFor(abs) {
  const home = os.homedir();
  return abs === home || abs.startsWith(home + path.sep) ? '~' + abs.slice(home.length) : abs;
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// Canonicalize ROOT through symlinks at boot. safePath's containment check compares against
// BASE_DIR verbatim, and `sidecar wait` realpaths its file before pinging /api/presence — a server
// launched via a symlinked dir (/tmp, /var/folders on macOS) would otherwise reject every one of
// those pings as "escapes root" and presence silently never lights.
const ROOT = (() => { const r = path.resolve(process.argv[2] || '.');
  try { return fs.realpathSync(r); } catch { return r; } })();
const PORT = process.env.SIDECAR_PORT || 4880;
const rootIsFile = fs.existsSync(ROOT) && fs.statSync(ROOT).isFile();
const BASE_DIR = rootIsFile ? path.dirname(ROOT) : ROOT;

// Identity names — same env family as the CLI's SIDECAR_AGENT (lib/cli.js). AGENT is the name
// stamped on the agent's own cards; USER is the human's, stamped by the browser on comments/replies.
// The UI colors identity by these (agent = yellow, the human = ink), so both ride /api/state.
const AGENT = process.env.SIDECAR_AGENT || 'claude';
const USER = process.env.SIDECAR_USER || 'you';

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
// One extension list for the whole tool. The picker and the file watcher below both used a bare
// `.endsWith('.md')`, which silently disagreed with the CLI's allowlist: a `.mdx` the CLI accepted
// was missing from the picker and never fired a live-reload event.
const isMarkdown = (p) => cli.MARKDOWN.includes(path.extname(p).toLowerCase());
// `--help`/`-h` normalize to the `help` verb. Bare `sidecar` still serves the cwd — `npm start` and
// the launchd job depend on that, so the banner below carries the pointer instead.
const arg0 = process.argv[2];
const verb = (arg0 === '--help' || arg0 === '-h') ? 'help' : arg0;
if (cli.isCommand(verb)) { cli.run(verb, process.argv.slice(3)); return; }
if (arg0 === '--version' || arg0 === '-v') {
  try { console.log(require('./package.json').version); } catch { console.log('?'); }
  return;
}
// A bare path is a directory to serve, but an unrecognized FLAG is a typo. Falling through booted a
// server on it, which then died on EADDRINUSE with an unhandled 'error' dump (`sidecar --version`).
if (typeof arg0 === 'string' && arg0.startsWith('-')) {
  console.error(`sidecar: unknown option "${arg0}"\ntry:  sidecar help`);
  process.exit(1);
}

// Boot-time code stamp (§6b): the whole "false orphan" incident was a launchd server running a matcher
// loaded hours before it was rewritten. Log the git sha + server.js mtime at startup, and surface it in
// /api/state, so "is the live server on current code?" is answerable at a glance.
const CODE_STAMP = (() => {
  let s = 'nogit'; try { s = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  let mt = ''; try { mt = fs.statSync(__filename).mtime.toISOString().slice(0, 19).replace('T', ' '); } catch {}
  return s + (mt ? ' · ' + mt : '');
})();
// A stamp is only comparable against another stamp from the SAME installation. `doctor` runs from
// whichever copy of the CLI is on PATH — for an npm/npx user that is never the server's copy, so
// comparing stamps blind reported STALE at every such user, permanently. Ship the install dir and
// the package version too, so the CLI can tell "different install" from "same install, old code".
const CODE_DIR = __dirname;
const VERSION = (() => { try { return require('./package.json').version || '?'; } catch { return '?'; } })();

// ---------- api ----------
// ---------- images referenced by a document, or attached to its review ----------
// A relative `![](./flow.png)` is relative to the DOCUMENT, but the page is served from `/?f=…`, so the
// browser resolves it against the app root and 404s. The client hands over both halves and resolution
// happens here, through the same safePath the file API uses — one confinement check, not two.
// A comment's image is the same shape: the body holds `![](doc.md.sidecar.assets/ab12….png)`, relative
// to the document, and arrives here through exactly this route. Attachments needed no serving code.
app.get('/assets', (req, res) => {
  const src = String(req.query.src || '');
  // Only a relative path off the document. A URL or an absolute path would make this route a general
  // file-read primitive for anything the served root contains, image extension or not.
  if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src)) return res.status(400).json({ error: 'relative image paths only' });
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_TYPES[ext]) return res.status(400).json({ error: 'not an image' });
  let abs;
  try { abs = safePath(path.resolve(path.dirname(safePath(String(req.query.doc || ''))), src)); }
  catch { return res.status(403).json({ error: 'path escapes root' }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'not found' });
  // An SVG is a document, not just pixels: served same-origin it could carry script, and this origin
  // has the file read/write API on it. Inside an <img> nothing runs, but a user can also open this URL
  // directly — so deny everything the file might try to load or execute, and pin the type against sniffing.
  res.set('Content-Type', IMAGE_TYPES[ext]);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(abs);
});

// Paste, drop, or pick an image in a comment box → the bytes land here and become a file next to the
// review. Raw body rather than base64-in-JSON: a screenshot is megabytes and base64 inflates it by a
// third, on a path where the browser already holds the exact bytes. `express.json` above only parses
// application/json, so an octet-stream body reaches this handler untouched.
app.post('/api/asset', express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
  let doc;
  try { doc = safePath(String(req.query.doc || '')); }
  catch { return res.status(403).json({ error: 'path escapes root' }); }
  // Confined AND real: without this an upload could create `<anything>.sidecar.assets/` anywhere under
  // the root, which is a write primitive dressed up as an attachment.
  if (!fs.existsSync(doc) || !fs.statSync(doc).isFile()) return res.status(404).json({ error: 'no such document' });
  try {
    const { rel } = saveAsset(doc, req.body);
    // Hand back the markdown too, so the client never re-derives the reference format. One producer.
    res.json({ ok: true, src: rel, markdown: `![](${rel})` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/files', (req, res) => {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (isMarkdown(e.name)) {
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
    presence: presenceFor(abs), code: CODE_STAMP, codeDir: CODE_DIR, version: VERSION,
    user: USER, agent: AGENT });
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
// Ephemeral + in-memory, written by `sidecar wait` via POST /api/presence and read back in /api/state.
// In-memory, NOT the sidecar, so it never contends with review writes and never lands in git. A
// missing/stale (no heartbeat) or idle entry reads as "not here".
// Keyed per (realpath, agent), one record each: two agents on one file hold independent state, so
// agent B's watching heartbeat can never wipe agent A's "working" record or the item ids it carries
// (the per-thread "replying" marks in the browser). Records carry `items` — the thread ids the
// agent's wait exit said it now has in hand.
const presence = {};   // realpath → { agentName → { state, at, items } }
const PRESENCE_TTL = 40000;    // "watching" is heartbeated every 15s, so a short TTL keeps it honest
const WORKING_TTL = 180000;    // "working" has NO heartbeat (the wait already exited while the agent composes),
                               // so give it a generous window; it's overwritten by the next "watching"/"idle".
// Key presence by the file's REAL path: the wait-side ping and the browser-side read can reach the
// same doc under different spellings of one file (a symlinked /tmp vs /private/tmp on macOS, or an
// aliased dir). Without collapsing them to the canonical path they land in different buckets and the
// presence dot silently never lights. realpathSync throws if the file doesn't exist yet — fall back
// to the resolved path so a not-yet-created doc still keys consistently on both sides.
function realKey(abs) { try { return fs.realpathSync(abs); } catch { return abs; } }
// Merge the live per-agent records into one readout. The header state is the STRONGEST live claim —
// working outranks watching regardless of recency, so one agent composing while another heartbeats
// "watching" cannot flap the header. Items union across agents, each mark naming its agent (the
// browser needs the name to clear the mark once that agent's reply lands). `until` is when the
// record goes stale with no further ping — sent so the browser can expire marks on its own clock
// instead of showing a dead agent as working forever.
function presenceFor(abs) {
  const rec = presence[realKey(abs)];
  if (!rec) return null;
  const now = Date.now();
  const rank = (p) => p.state === 'working' ? 1 : 0;
  let best = null; const items = [];
  for (const agent of Object.keys(rec)) {
    const p = rec[agent];
    if (p.state === 'idle') continue;
    const until = p.at + (p.state === 'working' ? WORKING_TTL : PRESENCE_TTL);
    if (until <= now) continue;
    if (!best || rank(p) > rank(best) || (rank(p) === rank(best) && p.at > best.at)) best = { ...p, until };
    for (const id of p.items || []) items.push({ id, agent, until });
  }
  return best ? { state: best.state, at: best.at, until: best.until, items } : null;
}
app.post('/api/presence', (req, res) => {
  let abs; try { abs = safePath(req.body.path); } catch { return res.json({ ok: true }); }   // unknown file → ignore (fail-safe)
  const agent = String(req.body.agent || AGENT);
  const rec = (presence[realKey(abs)] ||= {});
  // Three readings of `items`, and the third is what keeps a long turn visible. An array replaces this
  // agent's marks; an EMPTY array clears them, which is the wait's heartbeat saying it holds nothing;
  // an ABSENT field means "refresh my clock, leave my marks alone". Every CLI write verb sends that
  // third form, because a working record expires after WORKING_TTL with nothing heartbeating it and a
  // five-minute reply used to outlive its own marks. Present but not an array is malformed: treat it
  // as the clear, which is what this route did for every shape before the distinction existed.
  const items = Array.isArray(req.body.items) ? req.body.items.map(String)
    : ('items' in req.body ? [] : ((rec[agent] || {}).items || []));
  rec[agent] = { state: req.body.state || 'watching', at: Date.now(), items };
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
  if (!isMarkdown(p) && !p.endsWith('.sidecar.json')) return;
  const rel = path.relative(BASE_DIR, p.replace(/\.sidecar\.json$/, ''));
  for (const c of clients) c.write(`data: ${JSON.stringify({ event, rel })}\n\n`);
});

// Terminal error handler — thrown errors (safePath escape, corrupt sidecar JSON.parse) become JSON,
// never an HTML stack trace leaking absolute paths. Route bodies are synchronous, so Express funnels
// their throws here automatically.
app.use((err, req, res, next) => { res.status(err.status || 400).json({ error: err.message }); });

const server = app.listen(PORT, '127.0.0.1', () => {
  const f = rootIsFile ? `/?f=${encodeURIComponent(path.relative(BASE_DIR, ROOT))}` : '/';
  console.log(`sidecar ready → http://localhost:${PORT}${f}  [code ${CODE_STAMP}]`);
  // The startup line is the one moment a first-time reader is definitely looking, and a running
  // server is worth little until the agent on the other side knows the verbs.
  console.log(`agent needs the protocol → npx skills add smithavt14/sidecar   (or: sidecar skill)`);
});

// Starting a second server on a taken port is the likeliest startup failure, and Node's default for
// it is an unhandled 'error' event with a stack dump. Say what happened, and where the other one is.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`sidecar: port ${PORT} is already in use — a server is probably already running.\n` +
      `  check it:      sidecar doctor\n` +
      `  or use another port:  SIDECAR_PORT=4881 sidecar <dir>`);
  } else {
    console.error(`sidecar: ${e.message}`);
  }
  process.exit(1);
});
