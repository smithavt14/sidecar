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
   filters on `.md`/`.review.json`, so it fires zero SSE noise. Delete it = full replay.

   The DOC baseline lives beside the cursor as `<file>.review.seen.base.<agent>` — the document text as
   of this agent's last look, written atomically whenever the cursor advances. The digest diffs current
   text against it (jsdiff, in-process), so the doc half answers the same question as the item half:
   "since MY last look." It used to shell out to `git diff`, whose baseline is HEAD — a different clock
   entirely: untracked docs and non-git dirs produced a "your turn" digest with an empty body, tracked
   docs re-sent every uncommitted hunk each turn, and a mid-review commit silently blanked the channel
   (the real reason the "don't commit mid-review" rule existed). `cursor.docHash` doubles as the
   baseline's checksum: a missing or mismatched baseline degrades to a flagged "no baseline" line,
   never a silent nothing. The baseline's extension is the agent name (sanitized), so the server's
   picker and watcher ignore it like the seen file, and both die together on delete = full replay. */
const fs = require('fs');
const crypto = require('crypto');
const { structuredPatch } = require('diff');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const clip = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

function seenPath(abs) { return abs + '.review.seen.json'; }

// The doc-baseline path. The agent name is the extension, sanitized so a weird SIDECAR_AGENT cannot
// smuggle in a markdown extension (the picker/watcher would see a fake doc) or a path separator.
function basePath(abs, agent) { return abs + '.review.seen.base.' + String(agent).replace(/[^\w-]/g, '_'); }

// The doc text as of this agent's last look, or null. Missing OR unreadable → null → the digest says
// "no baseline" out loud instead of diffing. NEVER throws, same contract as loadSeen.
function loadBaseline(abs, agent) {
  try { return fs.readFileSync(basePath(abs, agent), 'utf8'); } catch { return null; }
}

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
// independent markers). Atomic tmp+rename, mirroring lib/review.js saveReview. When `raw` (the doc
// text just digested) is passed, the baseline advances in the same call — cursor and baseline move
// together or not at all, which is what keeps --peek and wait's timeout exit from splitting them.
function saveSeen(abs, agent, cursor, raw) {
  const p = seenPath(abs);
  const all = loadSeen(abs) || {};
  all[agent] = cursor;
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, p);
  if (typeof raw === 'string') {
    const b = basePath(abs, agent);
    const bt = b + '.tmp';
    fs.writeFileSync(bt, raw);
    fs.renameSync(bt, b);
  }
}

// Unified hunks (the body of a ```diff fence) for baseline → current. In-process jsdiff, so it works
// identically for tracked, untracked, and non-git docs. structuredPatch, not createTwoFilesPatch,
// because the latter prepends Index/=== header noise the fence doesn't want.
function unifiedHunks(oldStr, newStr) {
  const p = structuredPatch('doc', 'doc', oldStr, newStr, '', '', { context: 3 });
  const lines = [];
  for (const h of p.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    lines.push(...h.lines);
  }
  return lines.join('\n');
}

// Diff current state against `cursor` (this agent's prior snapshot, or null for a full replay). Returns
// a structured delta + the fresh snapshot to advance to. renderDigest turns it into text; both `wait`
// and `digest` share it. `agent` scopes authorship: a card the agent itself wrote is not "news" —
// generalizes wait.js's old hardcoded `by === 'alex'` so the agent side is name-agnostic for strangers.
// `baseText` is the doc baseline (loadBaseline) — kept a parameter so this function stays disk-free.
function computeDigest(cursor, review, raw, agent, baseText) {
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
        news.push({ id: it.id, kind: it.flag ? 'flag' : it.kind, q, text: m ? m.text : (it.replacement || '') });
      }
      // The agent's own card is not news to it, but a message someone ELSE has already put on that card
      // is, and it used to fall in the gap: `suggest` (or `comment`) then `wait` leaves the card outside
      // the cursor, so the branch above skipped the item and took the human's reply down with it. Alex
      // asked a question on a fresh suggestion and `wait` slept through it to the timeout (reproduced
      // 2026-08-13, exit 1 on a reply sitting on disk), which is the exact silence the wait loop exists
      // to prevent. Reachable on any kind; threaded suggestion cards make it the common path.
      else for (const m of newHuman) replies.push({ id: it.id, q, text: m.text });
      continue;
    }
    for (const m of newHuman) replies.push({ id: it.id, q, text: m.text });   // existing item, new human message(s)
  }

  for (const id of Object.keys(cur.items)) if (!present.has(id)) removed.push(id);

  // Diff the doc only when there's a prior hash to diff against — a full replay has no reference, so it
  // reports review state and leaves the (possibly huge) initial read to `sidecar show`. The hash gates;
  // the baseline provides the content — and must itself hash to cursor.docHash, or it is some OTHER
  // version and diffing it would misreport. Stale/missing baseline → docPatch null → flagged loudly.
  const docChanged = !!(cur.docHash && cur.docHash !== docHash);
  let docPatch = null;
  if (docChanged && typeof baseText === 'string' && sha(baseText) === cur.docHash) docPatch = unifiedHunks(baseText, raw);
  const done = !!(review.session && review.session.done);
  const empty = !decided.length && !orphaned.length && !news.length && !replies.length && !removed.length && !docChanged;

  return { decided, orphaned, news, replies, removed, docChanged, docPatch, done, empty, noMarker,
           at: cursor && cursor.at, snapshot: snapshot(review, docHash) };
}

const orphanNote = (r) => r === 'never-matched' ? 'never matched — bad anchor' : 'text changed';

// The ONE renderer for both verbs. ids are always printed so the agent can reply/answer without a
// `show`. Order per the settled design: ACCEPTED/REJECTED/RESOLVED · ORPHANED · NEW/REPLY · REMOVED ·
// doc diff · DONE last.
function renderDigest(d) {
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
    if (d.docPatch) out += '\n\n### doc changes (since your last look)\n```diff\n' + d.docPatch + '\n```';
    else out += '\n\ndoc changed (no baseline to diff against — run `sidecar show` for the full state)';
  }
  out += '\n\nDONE: ' + (d.done ? 'true' : 'false');
  return out;
}

module.exports = { seenPath, basePath, loadBaseline, snapshot, loadSeen, saveSeen, computeDigest, renderDigest };
