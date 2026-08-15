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

  const api = { LIVE, QUOTE_MAX, isLive, lastBy, lastAt, waiting, of, inbox, byNewest };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Turn = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
