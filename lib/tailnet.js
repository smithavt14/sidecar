/* Who may reach this server from another device: the person running it, plus anyone they name.

   The server binds 127.0.0.1, so the only way in from off the machine is a local proxy, and the one
   sidecar documents is `tailscale serve`. Before this module, a tailnet hostname in SIDECAR_HOSTS let
   EVERY device on the tailnet read and write the served root, devices shared in from other accounts
   included. Now a request that came through a proxy needs a Tailscale identity, and that identity has
   to be the owner of this machine's Tailscale login or a login listed in SIDECAR_ALLOW_USERS.

   What `tailscale serve` does to a proxied request, checked against Tailscale 1.98.9 on 2026-10-05
   (ipn/ipnlocal/serve.go, and a live mapping echoing what arrived):
   - the Host header passes through VERBATIM, a client-chosen `Host: localhost:4880` included, so Host
     alone cannot say a request is local;
   - X-Forwarded-For, X-Forwarded-Host and X-Forwarded-Proto are always set, and a client's own copies
     (and `Forwarded`) are removed first;
   - Tailscale-User-Login, -Name and -Profile-Pic are deleted from what the client sent and then set
     from Tailscale's own lookup of the source node, so a client cannot forge them. A tagged node gets
     none, and Funnel traffic gets none but `Tailscale-Funnel-Request: ?1`;
   - a login that is not plain ASCII arrives RFC 2047 Q-encoded (`=?utf-8?q?...?=`).
   A raw `tailscale serve --tcp` forward adds none of this and passes a client's headers through
   untouched, so neither locality nor an identity header means anything on a port one points at. It is
   looked for in Tailscale's serve config instead (tcpForwards below), and while one exists, or while
   a running Tailscale's serve config cannot be read, the server refuses every request. */
const { execFile } = require('child_process');

// Any one of these on a request means something forwarded it. Tailscale always sets the first two;
// the rest are other proxies' spellings, and an identity header no local client has a reason to send.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip',
  'tailscale-user-login', 'tailscale-user-name', 'tailscale-funnel-request', 'tailscale-headers-info'];
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Local means: the socket is loopback, the Host is the loopback name the CLI and a local browser send,
// and nothing on the request says a proxy carried it. The Host test alone is not enough (Tailscale
// passes a forged one through), and the header test alone would let a raw TCP forwarder look local to
// a browser that sends its tailnet Host; together a proxied request is caught by either.
function isLocal(req, port) {
  const h = req.headers;
  if (!LOOPBACK_ADDRS.has(req.socket && req.socket.remoteAddress)) return false;
  if (h.host !== `127.0.0.1:${port}` && h.host !== `localhost:${port}`) return false;
  return !PROXY_HEADERS.some((k) => k in h);
}

// Logins compare without case: they are email-shaped, and an allowlist is typed by hand.
const norm = (s) => String(s || '').trim().toLowerCase();
const parseUsers = (s) => String(s || '').split(',').map(norm).filter(Boolean);

// RFC 2047 encoded-words, the Q form Go's mime.QEncoding writes. Adjacent words are one value split
// for length, so the whitespace between them is not part of it.
function decodeHeader(v) {
  if (typeof v !== 'string' || !v.includes('=?')) return v || '';
  return v.replace(/\?=\s+=\?/g, '?==?').replace(/=\?utf-8\?q\?([^?]*)\?=/gi, (_, q) => {
    const bytes = [];
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c === '_') bytes.push(0x20);
      else if (c === '=' && /^[0-9a-f]{2}$/i.test(q.slice(i + 1, i + 3))) { bytes.push(parseInt(q.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(c.charCodeAt(0));
    }
    return Buffer.from(bytes).toString('utf8');
  });
}

// `tailscale status --json` → { ok, owner }. `ok` is false only when the text is not status JSON at
// all; a Tailscale that is stopped, logged out or tagged is a real answer, and its answer is "no
// owner". User IDs are int64 and outgrow a JS number, which would make two users' keys collide, so
// they are quoted before parsing. A tagged machine belongs to no person, so only SIDECAR_ALLOW_USERS
// gets in.
function parseStatus(text) {
  let j;
  try { j = JSON.parse(String(text).replace(/("(?:UserID|ID)"\s*:\s*)(\d+)/g, '$1"$2"')); } catch { return { ok: false, running: false, owner: null }; }
  if (!j || typeof j !== 'object' || !('BackendState' in j)) return { ok: false, running: false, owner: null };
  if (j.BackendState !== 'Running') return { ok: true, running: false, owner: null };
  if (!j.Self || (Array.isArray(j.Self.Tags) && j.Self.Tags.length)) return { ok: true, running: true, owner: null };
  const u = (j.User || {})[String(j.Self.UserID)];
  return { ok: true, running: true, owner: u && u.LoginName ? norm(u.LoginName) : null };
}
const ownerFromStatus = (text) => parseStatus(text).owner;

// A raw TCP forward is the one way off the tailnet that `isLocal` cannot see: `tailscale serve --tcp`
// (or `--tls-terminated-tcp`) hands a peer's bytes to the port untouched, so a peer that sends
// `Host: localhost:PORT` and nothing else looks exactly like the CLI. Nothing on the request can tell
// them apart, so the forward is found in Tailscale's own config instead. Checked against 1.98.9: a
// forward appears as `TCP.<port>.TCPForward` ("127.0.0.1:4880", "localhost:4880", "::1:4880"
// unbracketed), with `TerminateTLS` beside it for the TLS-terminated kind, and the same shape nests
// under `Foreground.<session>` and `Services.<name>`, so the whole document is walked. Any target on
// this port counts, whatever its host: Tailscale also accepts a hostname target, and a name mapped to
// 127.0.0.1 in /etc/hosts reaches this server as surely as a literal does. The accepted false positive
// is a forward to the same port number on another machine, which blocks this server too.
function tcpForwards(text, port) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return null; }
  const found = [];
  (function walk(o, key) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.TCPForward === 'string') {
      const i = o.TCPForward.lastIndexOf(':');
      if (i >= 0 && o.TCPForward.slice(i + 1) === String(port))
        found.push(`${o.TerminateTLS ? 'tls-terminated-tcp' : 'tcp'} port ${key} → ${o.TCPForward}`);
    }
    for (const [k, v] of Object.entries(o)) walk(v, k);
  })(j, '?');
  return found;
}

// Where the CLI may be. A launchd or systemd job gets a short PATH, and on a Mac the CLI often lives
// only inside the app bundle (or in /usr/local/bin, which launchd's default PATH leaves out), so PATH
// alone misses it exactly where sidecar runs as a service. SIDECAR_TAILSCALE names it outright.
function candidates(env) {
  if (env.SIDECAR_TAILSCALE) return [env.SIDECAR_TAILSCALE];
  return ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
}

const run = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { timeout: 3000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (err, stdout) => resolve(err ? null : stdout));
});

// One look at Tailscale: { ok, running, owner, forwards }. `ok` false means no CLI ran or none said
// anything parseable, which is Tailscale not installed or not answering. `forwards` is only read from a
// RUNNING Tailscale, since a stopped one forwards nothing; there it is null when the serve config could
// not be read, which is not the same as reading it and finding nothing. Never throws or rejects.
async function lookup(port, env = process.env) {
  for (const bin of candidates(env)) {
    const out = await run(bin, ['status', '--json']);
    if (out == null) continue;
    const st = parseStatus(out);
    if (!st.ok) continue;
    if (!st.running) return { ok: true, running: false, owner: null, forwards: [] };
    const serve = await run(bin, ['serve', 'status', '--json']);
    return { ok: true, running: true, owner: st.owner, forwards: serve == null ? null : tcpForwards(serve, port) };
  }
  return { ok: false, running: false, owner: null, forwards: [] };
}

// What a look says about raw TCP forwards onto the port, given the state before it. `found` when the
// serve config lists one; `unknown` when Tailscale is running and its serve config could not be read,
// which is treated as `found`; `none` when the config lists none or Tailscale reports itself not
// running. A look where no CLI answered at all proves nothing, and never clears a block: a status
// command that failed or timed out does not mean the daemon stopped forwarding. From `none` it means
// `unknown` once Tailscale has ever been seen running here (`seenRunning`), since a forward could be
// added while the CLI is failing; on a machine where it never has, Tailscale is simply not installed
// and `none` stands.
function forwardState(r, prev = 'none', seenRunning = false) {
  if (!r || !r.ok) return prev === 'none' && seenRunning ? 'unknown' : prev;
  if (!r.running) return 'none';
  if (!Array.isArray(r.forwards)) return 'unknown';
  return r.forwards.length ? 'found' : 'none';
}

// How long a look at Tailscale stays good. A request arriving after that waits for a fresh one before
// it is trusted, local or not, so a raw forward added while sidecar runs goes unseen for at most this
// long plus one lookup. The background timer (RETRY_KNOWN_MS by default) keeps an idle server current.
const FRESH_MS = 2000;
const RETRY_KNOWN_MS = 30000;

// The decision, with the lookup and the clock passed in so it can be tested without Tailscale. A
// request first `settle()`s, which waits for any look in flight or starts one when the last is older
// than FRESH_MS; every check after that reads the settled state and never looks again, so nothing a
// look finds can arrive between the block check and the identity check.
function createGate({ allowUsers = [], lookup: look, now = Date.now, onOwner = () => {}, onForwards = () => {} } = {}) {
  const allowed = new Set(allowUsers.map(norm).filter(Boolean));
  let owner = null, forwards = [], fwd = 'none', seenRunning = false, lastTry = -Infinity, inflight = null;

  function refresh() {
    if (inflight) return inflight;
    lastTry = now();
    inflight = Promise.resolve().then(look).catch(() => null).then((r) => {
      // The owner is whatever this look said, and a look that failed says nobody: keeping the last
      // answer would let a former owner, or the owner of a machine since tagged, stay in. The cost is
      // a denial for the real owner until the next look.
      const o = r && r.ok ? r.owner : null;
      if (o !== owner) { owner = o; onOwner(o); }
      const state = forwardState(r, fwd, seenRunning);
      if (r && r.ok && r.running) seenRunning = true;
      const list = state === 'found' ? (r && r.ok && Array.isArray(r.forwards) ? r.forwards : forwards) : [];
      if (state !== fwd || list.join('\n') !== forwards.join('\n')) { fwd = state; forwards = list; onForwards(fwd, forwards.slice()); }
      inflight = null;
      return owner;
    });
    return inflight;
  }

  async function settle() {
    if (inflight) await inflight;
    else if (now() - lastTry >= FRESH_MS) await refresh();
  }

  // Every request must be refused while a raw TCP forward onto the port may exist: it passes a peer's
  // bytes through untouched, so neither a local-looking request nor an identity header can be believed.
  const blocked = () => fwd !== 'none';

  // A remote request: true when its Tailscale identity is on the allowlist or is the settled owner.
  function allows(headers) {
    if ('tailscale-funnel-request' in headers) return false;   // the public internet, never a tailnet user
    const login = norm(decodeHeader(headers['tailscale-user-login']));
    return !!login && (allowed.has(login) || login === owner);
  }

  return { settle, refresh, blocked, allows, owner: () => owner, forwardState: () => fwd, forwards: () => forwards.slice() };
}

module.exports = { isLocal, decodeHeader, parseStatus, ownerFromStatus, tcpForwards, forwardState, lookup, parseUsers,
  createGate, FRESH_MS, RETRY_KNOWN_MS };
