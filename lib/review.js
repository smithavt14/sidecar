/* sidecar — the ONE review-file module: load, save, merge, orphan-annotate.

   Extracted from server.js so the CLI (lib/cli.js) and the HTTP server run the SAME merge logic
   instead of the agent reimplementing it by hand in prose. Same reasoning as public/anchor.js one
   layer down: a second implementation is a second set of bugs, and the two sides must agree
   byte-for-byte about what a merge does.

   Nothing here knows about express, argv, or the served root — callers resolve paths themselves. */
const fs = require('fs');
const Anchor = require('../public/anchor.js');   // the ONE shared content-anchor matcher

function sidecarPath(abs) { return abs + '.review.json'; }

function loadReview(abs) {
  const p = sidecarPath(abs);
  if (!fs.existsSync(p)) return { schema: 1, items: [] };   // genuinely absent → empty review
  // Present-but-unparseable must NOT masquerade as empty: a merge/write would then clobber a
  // corrupt sidecar with a subset and destroy items. Throw so callers surface it instead.
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveReview(abs, review) {
  const p = sidecarPath(abs);
  // Atomic write: a crash mid-write must not leave a truncated (corrupt) sidecar. Temp in same dir.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(review, null, 2));
  fs.renameSync(tmp, p);
}

// Content-anchor matching lives in the shared module so accept/format/orphan here and the client's
// highlight + occurrence code count occurrences the SAME way (same ws + markdown normalization).
const findAnchor = (raw, quote, occurrence = 0) => Anchor.findNth(raw, quote, occurrence);

// Is it safe to SPLICE over this raw span? Matching and splicing need different rules, and conflating
// them corrupts files.
//
// The matcher is deliberately block-tolerant: it strips line-start markers (`1.`, `-`, `##`, `>`) so a
// quote taken from the rendered document — where those markers are drawn by the browser, not selectable
// text — still finds its source. That is right for a COMMENT, which only needs to anchor and highlight.
//
// It is wrong for a SUGGESTION. Accept replaces the matched span's raw bytes, and a span that resolved
// across a block boundary contains structure the quote never showed: quote "Read the sidecar. Merge by
// id." against "1. **Read** the sidecar.\n2. **Merge** by id." resolves to a raw span starting inside
// the `**` and swallowing the `2. `, so accepting leaves "1. **REPLACED." — a dangling bold marker and
// a destroyed list. The human approved a clean word-diff and got mangled markdown.
//
// So: match loosely, splice strictly. Returns a human-readable reason, or null when the span is safe.
function spliceRisk(raw, start, end) {
  const span = raw.slice(start, end);
  const marker = span.match(/\n[ \t]*(#{1,6}|[-*+]|\d+\.|>)[ \t]/);
  if (marker) return `the matched span crosses a block boundary — it contains the line-start marker "${marker[1]}"`;
  if (/\n[ \t]*\n/.test(span)) return 'the matched span crosses a blank line, so it covers two separate blocks';
  // A span that begins or ends INSIDE inline markup leaves an unmatched opener behind when replaced.
  for (const mark of ['**', '__', '`']) {
    if ((span.split(mark).length - 1) % 2) return `the matched span contains an unbalanced "${mark}" — it starts or ends inside inline markup`;
  }
  // Single-character markers (*italic*, _italic_, ~~struck~~) can't be caught by parity: an unpaired
  // `*` is usually just multiplication, and `_` is usually snake_case, so counting would refuse
  // "2 * 3". What is actually dangerous is a span that SPLITS a marker run — the run opens outside
  // the span and closes inside it, or vice versa. Detect that directly: a marker character sitting
  // immediately outside the boundary whose twin is inside.
  const edge = (ch, inside) => ch && INLINE_MARK.includes(ch) && inside.includes(ch);
  if (start > 0 && edge(raw[start - 1], span))
    return `the matched span starts inside a "${raw[start - 1]}" run — replacing it would leave a dangling marker`;
  if (end < raw.length && edge(raw[end], span))
    return `the matched span ends inside a "${raw[end]}" run — replacing it would leave a dangling marker`;
  return null;
}
const INLINE_MARK = '*_`~';

// The other half of the same problem, and the one the original plan never looked at: spliceRisk
// validates the bytes being REMOVED, nothing validated the bytes being INSERTED. A replacement
// carrying its own block structure — a blank line, a heading, a list marker — injected into the
// middle of a block splits it, and the word-diff card shows characters, not structure, so the human
// approves something that reads fine and gets a list cut in half by a heading.
//
// Multi-block replacements are legitimate when the span IS a whole block (the skill documents
// replacing one paragraph with two). So the rule is not "no structure" but "structure only where the
// span already occupies a complete, unprefixed line".
function replacementRisk(raw, start, end, replacement) {
  const introducesBlocks = /\n[ \t]*\n/.test(replacement) || /\n[ \t]*(?:#{1,6}|[-*+]|\d+\.|>)[ \t]/.test(replacement);
  if (!introducesBlocks) {
    for (const mark of ['**', '__', '`']) {
      if ((replacement.split(mark).length - 1) % 2) return `the replacement contains an unbalanced "${mark}"`;
    }
    return null;
  }
  const atLineStart = start === 0 || raw[start - 1] === '\n';
  const atLineEnd = end === raw.length || raw[end] === '\n';
  if (!atLineStart || !atLineEnd)
    return 'the replacement introduces block structure (a blank line, heading, or list marker) but the span is only part of a line — it would split the block it sits in';
  // A span that IS a whole line still can't take block structure if that line is itself a list item
  // or quote: the marker stays behind and the injected blocks land inside the item.
  const lineStart = raw.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  if (/^[ \t]*(?:#{1,6}|[-*+]|\d+\.|>)[ \t]/.test(raw.slice(lineStart, end)))
    return 'the replacement introduces block structure, but the span sits inside a list item or blockquote — the injected blocks would break out of it';
  return null;
}

function annotateOrphans(raw, review) {
  // Known limitation (M4): occurrence is a positional index, so if one of several identical spans is
  // deleted, a surviving duplicate shifts into the orphaned item's index and it silently re-anchors to
  // the wrong copy instead of orphaning. Fixing that needs anchor context (prefix/suffix), not just N.
  let changed = false;
  for (const it of review.items) {
    if (['resolved', 'accepted', 'rejected'].includes(it.status)) continue;
    const hit = findAnchor(raw, it.anchor.quote, it.anchor.occurrence || 0);
    if (!hit && it.status !== 'orphaned') {
      it.status = 'orphaned';
      it.orphanedAt = new Date().toISOString();
      // WHY it orphaned, so the UI stops blaming the human for an edit they didn't make. An item that
      // never resolved once (`matchedAt` was never stamped) was mis-anchored from birth — a selection
      // spanning two blocks, or an agent quoting text that isn't in the file. Only an item that DID
      // resolve before can honestly be reported as "the text changed underneath it".
      it.orphanReason = it.matchedAt ? 'text-changed' : 'never-matched';
      changed = true;
    }
    if (hit && it.status === 'orphaned') {
      it.status = it.kind === 'suggestion' ? 'pending' : 'open';
      delete it.orphanedAt; delete it.orphanReason;
      changed = true;
    }
    // Stamp first successful resolution, so a later orphan can tell the two cases apart.
    if (hit && !it.matchedAt) { it.matchedAt = new Date().toISOString(); changed = true; }
  }
  return changed;
}

// Same-id review merge — the client always PUTs its ENTIRE (possibly stale) state.review, so a
// same-id item on disk may hold thread messages / a more-advanced status the client never saw
// (an agent appended them after the client loaded). Merge non-destructively instead of replacing.
const TERMINAL = new Set(['resolved', 'accepted', 'rejected']);
const statusRank = (s) => (TERMINAL.has(s) ? 2 : s === 'orphaned' ? 1 : 0);   // decided > orphaned > open/pending

// Pick the side representing the most-advanced/most-recent decision, so a stale write can never
// regress a decided card back to open, and orphaned can't clobber a real decision.
function reconcileStatus(existing, incoming) {
  const re = statusRank(existing.status), ri = statusRank(incoming.status);
  if (re !== ri) return re > ri ? existing : incoming;
  if (re === 2) return (incoming.decidedAt || '') >= (existing.decidedAt || '') ? incoming : existing; // later decision
  if (re === 1) return (incoming.orphanedAt || '') >= (existing.orphanedAt || '') ? incoming : existing;
  return incoming;   // both open/pending — incoming is the fresher edit
}

function mergeItem(existing, incoming) {
  // Scalars (replacement, note, anchor, flag, …): incoming is the fresher edit — take it when present.
  const merged = { ...existing, ...incoming };
  // Thread UNION — the crux: concurrent human+agent writes each carry their own reply, and a stale
  // client PUT would otherwise overwrite the on-disk thread and silently drop the other side's
  // message. Messages have no id, so dedupe by the (by, at, text) tuple and keep INSERTION ORDER —
  // existing (already on disk) first, then the incoming new ones. A fresh reply is always appended last,
  // so insertion order is chronological WITHOUT trusting `at`, which an agent can stamp wrong (a guessed
  // timestamp put a reply above the comment it answered, 2026-07-22). Render order matches (threadHtml).
  const seen = new Set();
  const thread = [...(existing.thread || []), ...(incoming.thread || [])]
    .filter(m => { const k = JSON.stringify([m.by, m.at, m.text]); return seen.has(k) ? false : (seen.add(k), true); });
  merged.thread = thread;
  // Status + its timestamp, carried together from whichever side won.
  const win = reconcileStatus(existing, incoming);
  merged.status = win.status;
  if (win.decidedAt !== undefined) merged.decidedAt = win.decidedAt; else delete merged.decidedAt;
  if (win.orphanedAt !== undefined) merged.orphanedAt = win.orphanedAt; else delete merged.orphanedAt;
  return merged;
}

module.exports = { sidecarPath, loadReview, saveReview, findAnchor, annotateOrphans, spliceRisk, replacementRisk,
                   mergeItem, reconcileStatus, statusRank, TERMINAL };
