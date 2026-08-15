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
const { SERVED_TYPES, FONT_TYPES, MAX_BYTES, saveAsset } = require('./lib/assets.js');
// The element anchor's shared rules — the sel validation this file runs on a write, and the Node-side
// liveness annotateOrphans resolves with (lib/element.js).
const Element = require('./lib/element.js');
// Whose turn is it — the ONE rule behind the panel's badges and the inbox, shared with the browser
// (public/turn.js, loaded there via <script>) so a count computed here and one computed there can
// never disagree.
const Turn = require('./public/turn.js');

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
// was missing from the picker and never fired a live-reload event. `docKind` now covers both kinds
// (markdown and .html assets), so the three gates — this picker walk, the watcher, and the verbs —
// stay one decision.
const isDoc = (p) => !!cli.docKind(p);
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
  if (!SERVED_TYPES[ext]) return res.status(400).json({ error: 'not an image or font' });
  let abs;
  try { abs = safePath(path.resolve(path.dirname(safePath(String(req.query.doc || ''))), src)); }
  catch { return res.status(403).json({ error: 'path escapes root' }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'not found' });
  // An SVG is a document, not just pixels: served same-origin it could carry script, and this origin
  // has the file read/write API on it. Inside an <img> nothing runs, but a user can also open this URL
  // directly — so deny everything the file might try to load or execute, and pin the type against sniffing.
  res.set('Content-Type', SERVED_TYPES[ext]);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  // A font is fetched by the ASSET FRAME, which is sandboxed without allow-same-origin and therefore
  // has an opaque origin. A CSS font fetch is always CORS-mode, so it arrives with `Origin: null` and
  // is dropped unless the response says otherwise — the frame would render the whole poster in a
  // fallback face. Images need none of this (an <img> is not CORS-gated), so the header goes on fonts
  // alone rather than on everything this route serves.
  if (FONT_TYPES[ext]) res.set('Access-Control-Allow-Origin', '*');
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
      else if (isDoc(e.name)) {
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

// ---------- one directory's documents, for the left panel ----------
// /api/files walks the WHOLE served tree and loads every review on the way — 474 documents in the
// vault this runs against, which is a payload the panel would then throw nearly all of away. The
// panel only ever shows one folder, so it asks for one folder: no recursion, no directories, and
// nothing that is not a document by the same `docKind` allowlist the picker and the watcher use.
// `path` is the DIRECTORY, relative to the served root; empty means the root itself.
//
// Every document also carries what is still open on it — the your-turn count the panel badges, and the
// live items themselves, which is what the Inbox lists. This is the only place that can see a document
// nobody has open, so the counting happens here rather than in the client, and it is the SAME function
// the client runs over the open document (public/turn.js).
//
// The sidecar is read RAW rather than through loadReview: the panel only needs to count, and
// loadReview also migrates the pre-1.7 `.review.*` names, which would fire a rename storm across a
// folder from a listing nobody asked to migrate. So a legacy-named or unparseable sidecar counts zero
// and the row still lists — the folder must draw whatever else is in it.
app.get('/api/dir', (req, res) => {
  const abs = safePath(String(req.query.path || ''));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'no such directory' });
  const docs = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('.') || !isDoc(e.name)) continue;
    const p = path.join(abs, e.name);
    // The document's own mtime, not the max with its sidecar's: this sorts by "last updated", which
    // is a claim about the DOCUMENT. /api/files says "last reviewed" and takes the max on purpose —
    // two different questions, so they read two different numbers rather than one shared fudge.
    let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
    let t = { turn: 0, open: 0, items: [] };
    try { t = Turn.of(JSON.parse(fs.readFileSync(sidecarPath(p), 'utf8')), AGENT); } catch (_) {}
    docs.push({ rel: path.relative(BASE_DIR, p), name: e.name, mtime, turn: t.turn, open: t.open, items: t.items });
  }
  // The panel walks up through `parent`; at the served root there is nowhere further up, and null
  // says so rather than handing back a path outside the root that safePath would then refuse.
  res.json({ dir: path.relative(BASE_DIR, abs), name: path.basename(abs),
    parent: abs === BASE_DIR ? null : path.relative(BASE_DIR, path.dirname(abs)), docs });
});

app.get('/api/state', (req, res) => {
  const abs = safePath(req.query.path);
  // Classify before reading. `?f=page.html` used to load through the markdown path unguarded, which is
  // how an HTML file got rendered as text with editable blocks over it; anything in NEITHER allowlist
  // (a .js, a .png) had the same door open. The kind rides along so the client knows which surface to
  // build, and `markdown` keeps its name for both kinds because every client build reads that field —
  // an asset's raw HTML arrives in it.
  const kind = cli.docKind(abs);
  if (!kind) return res.status(400).json({ error:
    `sidecar reviews markdown and html assets, not ${path.extname(abs) || 'extensionless files'}` });
  const markdown = fs.readFileSync(abs, 'utf8');
  const review = loadReview(abs);
  // Only persist when orphan states actually changed — an unconditional write here
  // feeds the fs-watcher, which tells the client to reload, which calls this again: a storm.
  if (annotateOrphans(markdown, review)) saveReview(abs, review);
  let diff = '';
  // execFileSync + args array: no shell is spawned, so a filename with $(...) or backticks can't inject.
  try { diff = execFileSync('git', ['diff', '--', path.basename(abs)], { cwd: path.dirname(abs), stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch {}
  res.json({ path: req.query.path, kind, pwd: pwdFor(abs), markdown, review, diff, hash: sha(markdown),
    presence: presenceFor(abs), code: CODE_STAMP, codeDir: CODE_DIR, version: VERSION,
    user: USER, agent: AGENT });
});

// Assets never reach here. They are read-only in the viewer: no contenteditable, no serialize
// round-trip, and the agent's own file writes are what change one. The guard is on the route rather
// than left to the UI, because "the client never sends it" is not a property anything enforces.
const READ_ONLY = (abs) => cli.docKind(abs) !== 'markdown'
  ? `${path.basename(abs)} is not an editable document — assets are read-only in the viewer` : null;

app.put('/api/save', (req, res) => {
  const abs = safePath(req.body.path);
  const ro = READ_ONLY(abs); if (ro) return res.status(400).json({ error: ro });
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
  // An element anchor's `sel` is echoed the same way (into the frame as a selector, and onto the card),
  // so it gets the same treatment: a value the CLI would refuse cannot arrive through the browser instead.
  // The `path` is echoed into a selector too and gets the same rule. Each half is checked WHEN PRESENT:
  // an element carrying neither a data-sc nor an id has no sel to store and anchors by path + signature
  // alone, which is the third resolution the picker (and CONTEXT.md) already describe. An anchor with
  // neither half references nothing at all.
  for (const it of incoming.items) {
    const el = it.anchor && it.anchor.element;
    if (!el) continue;
    if (el.sel !== undefined && !Element.validSel(el.sel)) return res.status(400).json({ error: `invalid element sel: ${el.sel}` });
    if (el.path !== undefined && !Element.validPath(el.path)) return res.status(400).json({ error: `invalid element path: ${el.path}` });
    if (el.sel === undefined && !el.path) return res.status(400).json({ error: 'element anchor needs a sel or a path' });
  }
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
  const ro = READ_ONLY(abs); if (ro) return res.status(400).json({ error: ro });
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
  if (!isDoc(p) && !p.endsWith('.sidecar.json')) return;
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
