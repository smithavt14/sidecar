/* sidecar — the persistent last-seen cursor and the shared digest renderer (P2).

   `sidecar wait`'s digest used to be a delta of ONE wake, baselined in memory at launch: anything the
   human did while the agent was composing a reply stacked up unreported, and SKILL.md compensated with
   "run `sidecar show` every pass" (whose output grows with the review). Five stacked comments were
   buried exactly this way on 2026-07-22.

   The fix is a persistent cursor in a sibling `<file>.review.seen.json`, keyed by agent name, holding
   `{ "<agent>": { docHash, items: { id: { status, threadLen } }, at } }`. `wait` and `digest` both
   diff current state against it and advance it on a reported look — so the loop is "block/report until
   something you HAVEN'T SEEN," across restarts, instead of "since I started watching."

   Comparison is threadLen + status, NEVER timestamps: threads order by insertion (lib/review.js
   mergeItem), and agent clocks proved untrustworthy (a guessed `at` once put a reply above the comment
   it answered). Missing OR corrupt cursor → treated as absent → full-state summary, flagged. The seen
   file is agent workspace state, not review content: it is never committed, and the server watcher
   filters on `.md`/`.review.json`, so it fires zero SSE noise. Delete it = full replay. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const clip = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

function seenPath(abs) { return abs + '.review.seen.json'; }

// The cursor: the reduced state we compare the next look against. status + threadLen per id, plus the
// doc hash and the moment it was taken. No timestamps of the messages themselves (see file header).
function snapshot(review, docHash) {
  const items = {};
  for (const it of (review.items || [])) items[it.id] = { status: it.status, threadLen: (it.thread || []).length };
  return { docHash, items, at: new Date().toISOString() };
}

// The whole seen file (all agents), or null. Missing OR corrupt → null → caller treats as absent and
// shows everything, flagged. NEVER throws: a half-written or hand-mangled cursor must degrade to a full
// replay, not crash the loop.
function loadSeen(abs) {
  try {
    const all = JSON.parse(fs.readFileSync(seenPath(abs), 'utf8'));
    return (all && typeof all === 'object' && !Array.isArray(all)) ? all : null;
  } catch { return null; }
}

// Advance THIS agent's cursor, preserving every other agent's (two agents reviewing one doc hold
// independent markers). Atomic tmp+rename, mirroring lib/review.js saveReview.
function saveSeen(abs, agent, cursor) {
  const p = seenPath(abs);
  const all = loadSeen(abs) || {};
  all[agent] = cursor;
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, p);
}

// Diff current state against `cursor` (this agent's prior snapshot, or null for a full replay). Returns
// a structured delta + the fresh snapshot to advance to. renderDigest turns it into text; both `wait`
// and `digest` share it. `agent` scopes authorship: a card the agent itself wrote is not "news" —
// generalizes wait.js's old hardcoded `by === 'alex'` so the agent side is name-agnostic for strangers.
function computeDigest(cursor, review, raw, agent) {
  const docHash = sha(raw);
  const noMarker = !cursor;
  const cur = cursor || { items: {}, docHash: null };
  const items = review.items || [];
  const present = new Set(items.map(it => it.id));

  const decided = [], orphaned = [], news = [], replies = [], removed = [];

  for (const it of items) {
    const q = clip(it.anchor && it.anchor.quote);
    const b = cur.items[it.id];
    const priorLen = b ? b.threadLen : 0;
    const newHuman = (it.thread || []).slice(priorLen).filter(m => m.by !== agent);   // by !== AGENT, not 'alex'
    const statusChanged = !b || b.status !== it.status;

    if (statusChanged && ['accepted', 'rejected', 'resolved'].includes(it.status)) {
      // the decision, with any human thread messages IN FULL — those are the reasons, and clipping them
      // loses the one thing the agent needs to act (why it was rejected, what to try next).
      decided.push({ status: it.status, q, reasons: newHuman.map(m => m.text) });
      continue;
    }
    if (statusChanged && it.status === 'orphaned') { orphaned.push({ q, reason: it.orphanReason }); continue; }
    if (!b) {
      // NEW since the cursor. Surface items authored by someone OTHER than this agent (the agent's own
      // cards it already knows); on a full replay show everything so the summary is complete.
      if (noMarker || it.by !== agent) {
        const m = (it.thread || []).slice(-1)[0];
        news.push({ kind: it.flag ? 'flag' : it.kind, q, text: m ? m.text : (it.replacement || '') });
      }
      continue;
    }
    for (const m of newHuman) replies.push({ q, text: m.text });   // existing item, new human message(s)
  }

  for (const id of Object.keys(cur.items)) if (!present.has(id)) removed.push(id);

  // Diff the doc only when there's a prior hash to diff against — a full replay has no reference, so it
  // reports review state and leaves the (possibly huge) working diff to `sidecar show`.
  const docChanged = !!(cur.docHash && cur.docHash !== docHash);
  const done = !!(review.session && review.session.done);
  const empty = !decided.length && !orphaned.length && !news.length && !replies.length && !removed.length && !docChanged;

  return { decided, orphaned, news, replies, removed, docChanged, done, empty, noMarker,
           at: cursor && cursor.at, snapshot: snapshot(review, docHash) };
}

const orphanNote = (r) => r === 'never-matched' ? 'never matched — bad anchor' : 'text changed';

// The ONE renderer for both verbs. ids are always printed so the agent can reply/answer without a
// `show`. Order per the settled design: ACCEPTED/REJECTED/RESOLVED · ORPHANED · NEW/REPLY · REMOVED ·
// git diff · DONE last.
function renderDigest(d, abs) {
  if (d.empty) return `nothing new${d.at ? ` since ${d.at}` : ''}\n\nDONE: ${d.done ? 'true' : 'false'}`;
  const lines = [];
  for (const x of d.decided) { lines.push(`- ${x.status.toUpperCase()} @ “${x.q}”`); for (const r of x.reasons) lines.push(`    ${r}`); }
  for (const x of d.orphaned) lines.push(`- ORPHANED @ “${x.q}”${x.reason ? ` [${orphanNote(x.reason)}]` : ''}`);
  for (const x of d.news) lines.push(`- NEW ${x.kind} @ “${x.q}”: ${x.text}`);
  for (const x of d.replies) lines.push(`- REPLY @ “${x.q}”: ${x.text}`);
  for (const id of d.removed) lines.push(`- REMOVED ${id}`);

  let out = d.noMarker ? '## sidecar — showing everything (no last-seen marker)' : '## sidecar — your turn';
  if (lines.length) out += '\n' + lines.join('\n');
  if (d.docChanged) {
    let diff = '';
    try { diff = execFileSync('git', ['diff', '--', path.basename(abs)], { cwd: path.dirname(abs), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
    if (diff) out += '\n\n### doc changes (git diff)\n```diff\n' + diff + '\n```';
  }
  out += '\n\nDONE: ' + (d.done ? 'true' : 'false');
  return out;
}

module.exports = { seenPath, snapshot, loadSeen, saveSeen, computeDigest, renderDigest };
