/* sidecar — the presence ping, shared by `sidecar wait` (lib/wait.js) and every CLI write verb
   (lib/cli.js).

   Decorative and server-optional by design: presence is what the human's browser shows about the
   agent's side of the loop, so a failed POST (no server running) leaves the command that made it
   completely unaffected.

   One protocol, read three ways by the server (server.js, POST /api/presence):
     items: [a, b]  replace the thread ids this agent holds
     items: []      clear them (the watching heartbeat, and the wait's own exits)
     items absent   keep whatever the record already holds, refresh state and the clock
   The write verbs send the third form. The ids in hand are the wait's to declare, and a write in the
   middle of a turn only needs to say "still here" before the 180s working window runs out. */
const http = require('http');

// `cb` fires once the POST settles or 400ms elapses, so an exit-time ping can flush before the
// process goes away.
function ping(abs, state, items, cb) {
  let settled = false, timer = null;
  const fin = () => { if (settled) return; settled = true; clearTimeout(timer); cb && cb(); };
  try {
    // Port and agent are read per call, not at module load, so one process that reads its env late
    // still pings where the caller meant.
    const port = process.env.SIDECAR_PORT || 4880;
    const agent = process.env.SIDECAR_AGENT || 'claude';
    // `agent` keys the server's per-agent presence record. Omitting `items` entirely is the whole
    // point of the third form above, so the field is spread in only when it is a real array.
    const body = JSON.stringify({ path: abs, state, agent, ...(Array.isArray(items) ? { items } : {}) });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/presence', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: `127.0.0.1:${port}` },
      }, (res) => { res.on('data', () => {}); res.on('end', fin); });
    req.on('error', fin);
    req.end(body);
    // 400ms flush window. The timer is unref'd because a CLI write verb pings on its way out and must
    // never sit idle waiting on a decoration; the socket keeps the loop alive while it is genuinely
    // in flight, so the timeout still fires when a server accepts the connection and then hangs.
    timer = setTimeout(fin, 400);
    if (timer.unref) timer.unref();
  } catch { fin(); }
}

// The same ping across a whole FOLDER, for `sidecar wait --dir`. Presence is keyed per document on
// the server (server.js keys it by realpath), and the folder wait is genuinely present on all of them,
// so it says so on each — the human opening any document in the folder sees "claude is here" rather
// than only on whichever one the wait happened to name.
//
// Sending N pings instead of teaching the server a directory key is the deliberate cheaper half: a
// folder holds a handful of documents, the pings are loopback POSTs a heartbeat apart, and a server
// already running old code keeps working. `cb` fires once every ping has settled or given up.
function pingMany(entries, cb) {
  if (!entries.length) { cb && cb(); return; }
  let left = entries.length;
  const fin = () => { if (--left === 0) cb && cb(); };
  for (const e of entries) ping(e.path, e.state, e.items, fin);
}

module.exports = { ping, pingMany };
