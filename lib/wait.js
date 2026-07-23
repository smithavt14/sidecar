/* sidecar — `sidecar wait <file>`: the reactive-loop primitive (P1).

   Moved verbatim out of server.js when the CLI grew its other verbs (lib/cli.js). Deliberately
   server-independent: it fs-watches the files directly, so it works with nothing running. The only
   thing it talks to a server about is decorative presence.

   NOTE its digest is a DELTA — it reports the single event that woke it. Anything the human does
   while the agent is composing a response stacks up unreported. `sidecar show` is the complete view;
   use it every pass. (Five stacked comments were missed exactly this way on 2026-07-22.) */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const chokidar = require('chokidar');
const { loadReview, sidecarPath } = require('./review.js');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

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
    if (docChanged) { let diff = ''; try { diff = execFileSync('git', ['diff', '--', path.basename(abs)], { cwd: path.dirname(abs), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {} if (diff) out += '\n\n### doc changes (git diff)\n```diff\n' + diff + '\n```'; }
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

module.exports = runWait;
