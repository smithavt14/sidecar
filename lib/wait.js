/* sidecar — `sidecar wait <file>`: the reactive-loop primitive (P1), now watch/presence/timeout
   plumbing over lib/digest.js (P2).

   Moved verbatim out of server.js when the CLI grew its other verbs (lib/cli.js). Deliberately
   server-independent: it fs-watches the files directly, so it works with nothing running. The only
   thing it talks to a server about is decorative presence.

   The digest is no longer an in-memory delta of one wake — it seeds its baseline FROM the persisted
   cursor (lib/digest.js), so `wait` blocks until something the agent HASN'T SEEN, not just something
   that happens after launch. Consequence: launched with an unseen backlog it returns immediately with
   it. It shares one renderer with `sidecar digest`, and advances the cursor on a digest-emitting exit
   (never on a timeout exit). No cursor present → baseline is the current state → old behavior (wake on
   the next change). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { loadReview, sidecarPath } = require('./review.js');
const { snapshot, computeDigest, renderDigest, loadSeen, saveSeen, loadBaseline } = require('./digest.js');
const { ping: pingPresence } = require('./presence.js');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const AGENT = process.env.SIDECAR_AGENT || 'claude';

function runWait(argv) {
  let file = null, timeoutSec = 900;   // 15-min backstop (Alex's call) so a background wait can't hang forever
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout') timeoutSec = Number(argv[++i]) || timeoutSec;
    else if (!file) file = argv[i];
  }
  if (!file) { console.error('usage: sidecar wait <file> [--timeout <seconds>]'); process.exit(2); }
  const raw0 = path.resolve(process.cwd(), file);
  // Fail loud: a relative path resolved from the wrong cwd would otherwise silently watch a nonexistent
  // file (and mis-key presence). Prefer an ABSOLUTE path; if relative, it must be relative to the served dir.
  if (!fs.existsSync(raw0)) {
    console.error(`sidecar wait: no file at ${raw0}\nPass an absolute path, or run from the served directory.`);
    process.exit(2);
  }
  // Canonicalize through symlinks BEFORE keying presence: on macOS /tmp is a symlink to /private/tmp,
  // and the server keys presence by its own realpath — an un-realpath'd key silently no-ops presence
  // (the server-side half of this fix lives in server.js). Also used for watching/reading so both agree.
  const abs = (() => { try { return fs.realpathSync(raw0); } catch { return raw0; } })();

  const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const loadSafe = () => { try { return loadReview(abs); } catch { return { items: [] }; } };

  // Baseline = the persisted cursor for this agent, else a snapshot of the current state. Seeding from
  // the cursor is what makes an unseen backlog surface immediately; seeding from current state (no
  // cursor) preserves the original "wake on the next change" semantics.
  const baseline = (loadSeen(abs) || {})[AGENT] || snapshot(loadSafe(), sha(readSafe(abs)));
  const baseDone = !!((loadSafe().session || {}).done);   // a done that flips true DURING the wait should wake it

  let leaving = false, watcher = null, beat = null, timer = null;

  // Prints the digest and advances the cursor iff there's something unseen (or done just flipped).
  // Returns true when it emitted. Never emits twice: the caller guards with `leaving`.
  // NOTE: `baseline` above is the CURSOR snapshot; loadBaseline() is the doc-text baseline it diffs
  // against. saveSeen gets `raw` so the doc baseline advances with the cursor — and the timeout exit
  // below advances neither, on purpose.
  // Returns null when nothing was unseen; otherwise the ids now in hand, for the exit ping. Only
  // `news` and `replies` — the categories that get an answer. A decided or orphaned item marks
  // nothing: "claude is replying" on an accepted suggestion would be a status light that lies.
  function emit() {
    const raw = readSafe(abs);
    const d = computeDigest(baseline, loadSafe(), raw, AGENT, loadBaseline(abs, AGENT));
    if (d.empty && !(d.done && !baseDone)) return null;   // nothing unseen yet — keep sleeping
    console.log(renderDigest(d));
    saveSeen(abs, AGENT, d.snapshot, raw);
    return [...new Set([...d.news, ...d.replies].map(x => x.id).filter(Boolean))];
  }

  // Best-effort presence: tell a running server "Claude is here" so the browser can show it. Purely
  // decorative and server-optional — if the POST fails (server down), the wait still works.
  // `items` are the thread ids in hand (the browser marks those cards "replying"). Every ping from
  // here sends an EXPLICIT list, empty when empty-handed: the wait is the authority on what this
  // agent holds, so its heartbeat clearing a stale mark is the point, and `[]` is what says so. A CLI
  // write verb pings the same route with the field omitted, which means "leave my marks alone".
  const ping = (state, items, cb) => pingPresence(abs, state, items || [], cb);
  // `leaving` guard: an accept touches the doc AND the sidecar → two chokidar events. leave() is async
  // (a ≤400ms presence ping precedes process.exit), so without a synchronous flag the second event
  // re-entered emit() and the digest printed twice (2026-07 double-print bug). Set it before the async
  // ping; the watcher handler checks it first.
  const leave = (code, pstate, items) => {
    if (leaving) return; leaving = true;
    clearInterval(beat); clearTimeout(timer);
    if (watcher) watcher.close();
    ping(pstate || 'idle', items, () => process.exit(code));
  };

  // Something already unseen at startup (a backlog, or done) → I'm about to handle it: show "working".
  { const ids = emit(); if (ids) { ping('working', ids, () => process.exit(0)); return; } }

  ping('watching');
  beat = setInterval(() => { if (!leaving) ping('watching'); }, 15000);   // heartbeat so a killed session goes stale, not stuck
  timer = setTimeout(() => {   // TIMEOUT exit: emit() never ran, so the cursor is deliberately NOT advanced
    console.log('still watching (no activity within ' + timeoutSec + 's)\n\nDONE: false'); leave(1, 'idle');
  }, timeoutSec * 1000);
  watcher = chokidar.watch([sidecarPath(abs), abs], { ignoreInitial: true });
  // Alex acted → the wait exits, but I'm now HANDLING it. Ping "working" (NOT idle) so the browser reads
  // "claude is working…" through my response window instead of "waiting for claude", and send the woken
  // ids so the cards themselves read "replying". Re-arming → "here", empty-handed.
  watcher.on('all', () => { if (leaving) return; const ids = emit(); if (ids) leave(0, 'working', ids); });
  process.on('SIGINT', () => leave(130, 'idle'));
}

module.exports = runWait;
