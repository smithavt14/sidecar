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
  if (j.BackendState !== 'Running' || !j.Self) return { ok: true, running: false, owner: null };
  if (Array.isArray(j.Self.Tags) && j.Self.Tags.length) return { ok: true, running: true, owner: null };
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
// under `Foreground.<session>` and `Services.<name>`, so the whole document is walked.
const LOOPBACK_TARGET = (host) => host === '' || host === 'localhost' || host === '::1' || host === '::'
  || host === '0.0.0.0' || host === '::ffff:127.0.0.1' || /^127\./.test(host);
function tcpForwards(text, port) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return null; }
  const found = [];
  (function walk(o, key) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.TCPForward === 'string') {
      const i = o.TCPForward.lastIndexOf(':');
      const host = o.TCPForward.slice(0, Math.max(i, 0)).replace(/^\[|\]$/g, '').toLowerCase();
      if (i >= 0 && o.TCPForward.slice(i + 1) === String(port) && LOOPBACK_TARGET(host))
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

// What a look says about raw TCP forwards onto the port. `none` when Tailscale is absent or not
// running (nothing can forward) or its serve config lists none; `found` when it lists one; `unknown`
// when Tailscale is running and its serve config could not be read, which is treated as `found`.
function forwardState(r) {
  if (!r || !r.ok || !r.running) return 'none';
  if (!Array.isArray(r.forwards)) return 'unknown';
  return r.forwards.length ? 'found' : 'none';
}

// How long a look at Tailscale stays good. Short while there is no owner, since Tailscale may simply
// have started after sidecar did; longer once there is one, where a fresh look catches an account
// switch or a new forward, and a stranger knocking repeatedly should not spawn a process each time.
const RETRY_UNKNOWN_MS = 2000;
const RETRY_KNOWN_MS = 30000;

// The decision, with the lookup and the clock passed in so it can be tested without Tailscale.
function createGate({ allowUsers = [], lookup: look, now = Date.now, recheckMs = RETRY_KNOWN_MS,
  onOwner = () => {}, onForwards = () => {} } = {}) {
  const allowed = new Set(allowUsers.map(norm).filter(Boolean));
  let owner = null, forwards = [], fwd = 'none', lastTry = -Infinity, inflight = null;

  function refresh() {
    if (inflight) return inflight;
    lastTry = now();
    inflight = Promise.resolve().then(look).catch(() => null).then((r) => {
      // The owner is whatever this look said, and a look that failed says nobody: keeping the last
      // answer would let a former owner, or the owner of a machine since tagged, stay in. The cost is
      // a denial for the real owner until the next look, two seconds later at most.
      const o = r && r.ok ? r.owner : null;
      if (o !== owner) { owner = o; onOwner(o); }
      // The forward reading is whatever this look said too, `unknown` included: a running Tailscale
      // whose serve config cannot be read might be forwarding, and is treated as forwarding.
      const state = forwardState(r);
      const list = state === 'found' ? r.forwards : [];
      if (state !== fwd || list.join('\n') !== forwards.join('\n')) { fwd = state; forwards = list; onForwards(fwd, forwards.slice()); }
      inflight = null;
      return owner;
    });
    return inflight;
  }
  const stale = () => now() - lastTry >= (owner ? recheckMs : RETRY_UNKNOWN_MS);

  // A remote request: true when its Tailscale identity is on the allowlist, or is the owner as of a
  // look that is still current. The allowlist never waits; an owner match on a stale look does.
  async function allows(headers) {
    if ('tailscale-funnel-request' in headers) return false;   // the public internet, never a tailnet user
    const login = norm(decodeHeader(headers['tailscale-user-login']));
    if (!login) return false;
    if (allowed.has(login)) return true;
    if (inflight) await inflight;
    else if (stale()) await refresh();
    return login === owner;
  }

  // Whether every request must be refused: a raw TCP forward onto the port passes a peer's bytes
  // through untouched, so neither a local-looking request nor an identity header can be believed
  // while one may exist. Looked at again here, two seconds apart at most, so the server comes back
  // soon after the forward is removed or the serve config is readable again.
  async function blocked() {
    if (fwd === 'none') return false;
    if (inflight) await inflight;
    else if (now() - lastTry >= RETRY_UNKNOWN_MS) await refresh();
    return fwd !== 'none';
  }

  return { allows, refresh, blocked, owner: () => owner, forwardState: () => fwd, forwards: () => forwards.slice() };
}

module.exports = { isLocal, decodeHeader, parseStatus, ownerFromStatus, tcpForwards, forwardState, lookup, parseUsers,
  createGate, RETRY_UNKNOWN_MS, RETRY_KNOWN_MS };
