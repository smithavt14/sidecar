/* sidecar — whose turn is it, per item, per document, per folder.

   The panel's badges and the inbox both need one answer to "what is still waiting on the human here",
   and the rail already had it in three different places. This is that answer, extracted: a review
   object in, counts and a flat list out. Pure — no fs, no DOM, no fetch — so the server can run it
   over a folder (server.js's /api/dir), the page can run it over the open document (index.html's
   navSelfUpdate), and the tests can run it over a literal.

   Both callers matter. The server is the only side that can see a document nobody has open, and the
   page is the only side that knows about a resolve half a second before the file watcher does. They
   have to agree, and the only way two answers agree reliably is by being one function.

   THE RULE, which is Alex's and is the whole point of the badge:

     A document's badge counts the items waiting on the HUMAN.
       · a live comment whose LATEST message is the agent's — it asked something and nobody answered
       · a pending suggestion — only the human can accept or reject one

     Everything else that is still live counts as open but not as your turn, and the panel draws it as
     a neutral dot: the agent owes the next move there.

   Three edges worth stating, because each was a real decision:

   - A comment with no thread falls back to its AUTHOR. `sidecar comment` writes a thread, but an item
     written straight into the JSON may not have one, and an agent's comment nobody has replied to is
     the clearest case of the human's turn there is.
   - Anyone who is not the agent is the human, keyed off the agent NAME rather than a literal — the
     same rule index.html's whoCls uses to colour a chip, so `alex`, the default `you` and any custom
     SIDECAR_USER all read as the human on both sides.
   - An ORPHANED suggestion is open but is NOT your turn. Its anchor is broken, and repairing it is
     `sidecar reanchor`, which is the agent's move. An orphaned COMMENT keeps the ordinary rule: the
     conversation on it is still whoever spoke last, broken anchor or not.

   Grace windows live on the client (public/stability.js) and are deliberately not consulted here.
   Server-side there is no such state, and an item inside its window is being SHOWN as open anyway, so
   counting stored `orphaned` as live is what keeps the badge and the rail saying the same number. */
(function (root) {
  'use strict';

  // Not settled: still on somebody's plate. Same triple /api/files has always counted.
  const LIVE = ['open', 'pending', 'orphaned'];

  // A quote is a whole sentence or more, and an inbox row shows one line of it. Cut server-side so a
  // folder of long anchors is not a payload the panel throws away — the same reasoning that keeps
  // /api/dir to one directory.
  const QUOTE_MAX = 160;

  const isLive = (it) => LIVE.indexOf(it && it.status) >= 0;
  const lastMsg = (it) => { const t = (it && it.thread) || []; return t.length ? t[t.length - 1] : null; };
  // Who spoke last on this item: the tail of its thread, or its author when it has none.
  function lastBy(it) { const m = lastMsg(it); return m ? m.by : (it && it.by); }
  // When it last moved. Used for "newest first" in the inbox only, so a missing timestamp sorts last
  // rather than being invented — insertion order is the tiebreak and it is already chronological.
  function lastAt(it) { const m = lastMsg(it); return (m && m.at) || (it && it.decidedAt) || ''; }

  function waiting(it, agent) {
    if (!isLive(it)) return false;
    if (it.kind === 'suggestion') return it.status === 'pending';
    return lastBy(it) === agent;
  }

  function snippet(s) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > QUOTE_MAX ? t.slice(0, QUOTE_MAX - 1) + '…' : t;
  }

  // One document's review → what the panel needs to know about it. `items` is the live set only, each
  // one carrying just enough to be recognised in a list: who, what kind, the span it is about, when it
  // last moved, and whose turn it is.
  function of(review, agent) {
    const items = [];
    let turn = 0;
    const all = (review && review.items) || [];
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      if (!isLive(it)) continue;
      const mine = waiting(it, agent);
      if (mine) turn++;
      items.push({
        id: it.id, kind: it.flag ? 'flag' : (it.kind || 'comment'), by: lastBy(it) || '',
        status: it.status, quote: snippet(it.anchor && it.anchor.quote),
        at: lastAt(it), i: i, turn: mine,
      });
    }
    return { turn: turn, open: items.length, items: items };
  }

  // Newest first, and `i` is what makes that total: two items written in the same second, or two with
  // no timestamp at all, fall back to their position in the file, which is insertion order and so is
  // already chronological. Without it the order depends on the sort's stability and shuffles between
  // renders for no reason the reader can see.
  const byNewest = (a, b) => String(b.at).localeCompare(String(a.at)) || (b.i - a.i);

  // The inbox: every live item in the folder, grouped by the document it is on. Documents with nothing
  // open are dropped entirely — an inbox is what is left to do, not a second copy of the file list.
  //
  // Groups lead with the ones waiting on the human (most first), then by whichever moved most recently,
  // then by the panel's own spine order, which arrives as the caller's ordering and is preserved by a
  // stable sort. Inside a group, newest first.
  function inbox(docs) {
    const groups = [];
    for (const d of (docs || [])) {
      const items = (d.items || []).slice().sort(byNewest);
      if (!items.length) continue;
      groups.push({ rel: d.rel, name: d.name, turn: d.turn || 0, open: items.length,
        at: items[0].at, items: items });
    }
    return groups.sort((a, b) => (b.turn - a.turn) || String(b.at).localeCompare(String(a.at)));
  }

  // What shape the review rail rests in, from the two counts the rail has already sorted out for
  // itself: its top-level active cards and its top-level archived ones.
  //
  //   'bare'  nothing either way. No review exists on this document yet, so the rail is a hairline
  //           edge and the document takes the width (index.html's body.rail-bare)
  //   'tabs'  everything settled. The tab bar stays, because the archive is a click away and its
  //           count is the only thing saying so, and nothing else is drawn
  //   'full'  something is open. The working surface
  //
  // Here rather than in the page because it is the same live/settled split this module already owns,
  // and because a rule about when a panel disappears is worth a test that does not need a browser.
  function rail(activeN, archivedN) {
    if (activeN > 0) return 'full';
    return archivedN > 0 ? 'tabs' : 'bare';
  }

  // ---------- how dense the rail is, and which cards rest collapsed ----------
  // A document under review used to wear every thread at full height whether or not any of them
  // wanted reading. Two states, toggled from the rail's tab bar and persisted under `sc:railDensity`:
  //
  //   'full'     every card is a full card, which is what sidecar has always drawn
  //   'compact'  the default: a thread whose next move is the HUMAN's stays full, everything else
  //              rests as a pill level with its anchor
  //
  // A third, 'hidden', drew no cards and no marks. It was a second control for shutting the panel,
  // beside the header's own, so it went; a stored 'hidden' reads as the default like any other value
  // no control can name.
  const DENSITIES = ['full', 'compact'];
  const DENSITY_REST = 'compact';
  // Anything that is not one of the two is the default, the same way navsort reads a stored key:
  // a preference written by an older build (or by a human editing localStorage) must not be able to
  // leave the rail in a state no control can name.
  function density(raw) { return DENSITIES.indexOf(raw) >= 0 ? raw : DENSITY_REST; }
  function nextDensity(cur) { return DENSITIES[(DENSITIES.indexOf(density(cur)) + 1) % DENSITIES.length]; }

  // Does this card rest COLLAPSED, before the human has touched it? The manual override lives in the
  // page (a Map for the page's lifetime); this is the rule it starts from, and the rule is the same
  // one the badge already runs: `waiting` is "the next move is the human's".
  //
  //   · claude asked something and nobody answered → full
  //   · a pending suggestion, which only the human can accept or reject → full
  //   · a flag → full. It is the one item written to be looked at
  //   · an orphan → full. It is the card that is WRONG about the document, and the -1 rank exists to
  //     put it where it will be seen; collapsing it to a pill would undo that in the same breath
  //   · a thread whose last word is the human's, waiting on the agent → collapsed
  //   · anything settled → collapsed, which is every card on the archived tab
  //
  // Only 'compact' collapses anything: 'full' is the promise that nothing is folded.
  function startCollapsed(it, agent, dens) {
    if (density(dens) !== 'compact') return false;
    if (!isLive(it)) return true;
    if (it && it.status === 'orphaned') return false;
    if (it && it.flag) return false;
    return !waiting(it, agent);
  }

  // ---------- a long thread folds in its middle ----------
  // A working conversation between a human and an agent runs to ten messages of several paragraphs
  // each, and the card drew every one of them at full height. The card-level clip (index.html's
  // CARD_CAP) is a pixel cap, so what it hides is the END of the thread: the newest messages, which
  // are the ones being read. The middle goes instead.
  //
  //   · the opening comment, which is what the thread is about
  //   · one row saying how many replies are hidden
  //   · the last two replies. The newest is usually an answer and the one before it is the question it
  //     answers, so the pair reads as an exchange where a single message reads as half of one
  //
  // Four messages or fewer draw whole, so the shortest thread a fold touches is five and the fewest it
  // ever hides is two: a row that stands in for one message costs a row and saves a row.
  //
  // `expanded` is the reader's own choice, held in the page for its lifetime (index.html's threadOpen),
  // and it is passed in rather than read here for the same reason the density's manual override is:
  // this module is pure, and both callers have to get the same answer from the same numbers.
  //
  // The row always sits BETWEEN head and tail, in both states. An expanded thread draws every message
  // and still carries the row after its opening comment, where the count sat, so opening the fold
  // changes the label under the pointer rather than moving the control to the foot of the thread.
  const THREAD_HEAD = 1;
  const THREAD_TAIL = 2;
  function foldThread(messages, expanded) {
    const all = (messages || []).slice();
    // `foldable` is true whether or not the fold is applied right now, because an expanded thread still
    // needs the row: it is what folds it back up.
    const foldable = all.length > THREAD_HEAD + THREAD_TAIL + 1;
    if (!foldable) return { head: all, hiddenCount: 0, tail: [], foldable: false };
    if (expanded) return { head: all.slice(0, THREAD_HEAD), hiddenCount: 0, tail: all.slice(THREAD_HEAD), foldable: true };
    return {
      head: all.slice(0, THREAD_HEAD),
      hiddenCount: all.length - THREAD_HEAD - THREAD_TAIL,
      tail: all.slice(all.length - THREAD_TAIL),
      foldable: true,
    };
  }

  // The one line a collapsed card shows on hover: the last thing said on it. The thread's tail, or
  // the suggestion's note, or the quote it is anchored to. A suggestion nobody has replied to has
  // no message at all, and a pill with an empty preview is worse than one with the span it is about.
  function peek(it) {
    const m = lastMsg(it);
    const t = (m && m.text) || (it && it.note) || (it && it.anchor && it.anchor.quote) || '';
    return snippet(String(t).split(/\n/).find(l => l.trim()) || '');
  }

  const api = { LIVE, QUOTE_MAX, DENSITIES, DENSITY_REST, THREAD_HEAD, THREAD_TAIL, isLive, lastBy,
    lastAt, waiting, of, inbox, byNewest, rail, density, nextDensity, startCollapsed, foldThread, peek };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Turn = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
