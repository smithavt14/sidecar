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
   - a login that is not plain ASCII arrives RFC 2047 Q-encoded (`=?utf-8?q?...?=`). */
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

// `tailscale status --json` → this machine's login name, or null. User IDs are int64 and outgrow a
// JS number, which would make two users' keys collide, so they are quoted before parsing. A tagged
// machine belongs to no person, so it has no owner and only SIDECAR_ALLOW_USERS gets in.
function ownerFromStatus(text) {
  let j;
  try { j = JSON.parse(String(text).replace(/("(?:UserID|ID)"\s*:\s*)(\d+)/g, '$1"$2"')); } catch { return null; }
  if (!j || j.BackendState !== 'Running' || !j.Self) return null;
  if (Array.isArray(j.Self.Tags) && j.Self.Tags.length) return null;
  const u = (j.User || {})[String(j.Self.UserID)];
  return u && u.LoginName ? norm(u.LoginName) : null;
}

// Where the CLI may be. A launchd or systemd job gets a short PATH, and on a Mac the CLI often lives
// only inside the app bundle (or in /usr/local/bin, which launchd's default PATH leaves out), so PATH
// alone misses it exactly where sidecar runs as a service. SIDECAR_TAILSCALE names it outright.
function candidates(env) {
  if (env.SIDECAR_TAILSCALE) return [env.SIDECAR_TAILSCALE];
  return ['tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
}

const run = (bin) => new Promise((resolve) => {
  execFile(bin, ['status', '--json'], { timeout: 3000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (err, stdout) => resolve(err ? null : stdout));
});

// Never throws and never rejects: Tailscale being absent, stopped or logged out is an ordinary state.
async function resolveOwner(env = process.env) {
  for (const bin of candidates(env)) {
    const out = await run(bin);
    if (out == null) continue;
    const owner = ownerFromStatus(out);
    if (owner) return owner;
  }
  return null;
}

// How long to wait before asking Tailscale again. Short while the owner is unknown, since Tailscale
// may simply have started after sidecar did; longer once known, where a fresh look only matters if the
// machine switched accounts, and a stranger knocking repeatedly should not spawn a process each time.
const RETRY_UNKNOWN_MS = 2000;
const RETRY_KNOWN_MS = 30000;

// The decision, with the lookup and the clock passed in so it can be tested without Tailscale.
function createGate({ allowUsers = [], resolve = () => resolveOwner(), now = Date.now, onOwner = () => {} } = {}) {
  const allowed = new Set(allowUsers.map(norm).filter(Boolean));
  let owner = null, lastTry = -Infinity, inflight = null;

  function refresh() {
    if (inflight) return inflight;
    lastTry = now();
    inflight = Promise.resolve().then(resolve).catch(() => null).then((o) => {
      if (o && o !== owner) { owner = o; onOwner(o); }
      inflight = null;
      return owner;
    });
    return inflight;
  }

  const ok = (login) => !!login && (allowed.has(login) || login === owner);

  // A remote request: true when its Tailscale identity is the owner or on the allowlist.
  async function allows(headers) {
    if ('tailscale-funnel-request' in headers) return false;   // the public internet, never a tailnet user
    const login = norm(decodeHeader(headers['tailscale-user-login']));
    if (!login) return false;
    if (ok(login)) return true;
    if (inflight) { await inflight; return ok(login); }
    if (now() - lastTry >= (owner ? RETRY_KNOWN_MS : RETRY_UNKNOWN_MS)) { await refresh(); return ok(login); }
    return false;
  }

  return { allows, refresh, owner: () => owner };
}

module.exports = { isLocal, decodeHeader, ownerFromStatus, resolveOwner, parseUsers, createGate,
  RETRY_UNKNOWN_MS, RETRY_KNOWN_MS };
