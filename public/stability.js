/* sidecar — anchor stability: what the RAIL shows while the DOCUMENT is being rewritten underneath it.

   The rail docks every card level with the text it is about, so the card's position is a function of
   the document. That is right until an agent edits the document, at which point three separate things
   happen within a few seconds: the anchored sentence stops matching, the item is stamped `orphaned`
   and takes the -1 rank that floats it to the top of the rail, and then `sidecar reanchor` lands and
   it snaps back down. Rendered instantly, all three, the middle one is a card teleporting out from
   under a human who was typing a reply into it.

   Nothing here re-anchors anything. Silent re-anchoring picks the wrong target (lib/review.js says
   why, at annotateOrphans), and this file exists precisely so that the honest answer, "the anchor is
   gone", can be delivered a beat later and in place instead of instantly and somewhere else.

   Three rules, and they compose:

   1. FREEZE. A card whose reply box has the caret, or holds text not yet sent, is pinned to where it
      sat when that started. It does not move for anything until the box is blurred and empty. Other
      cards flow around it.
   2. LAST KNOWN POSITION. Every card that docks against a real mark records the rank and the pixel it
      landed on. When its anchor stops matching, it holds that position rather than taking -1. The
      memory is this page's, for this document: it dies on a document swap, and a cold load of an
      already-orphaned item has nothing remembered and behaves exactly as it always did.
   3. GRACE. A card does not visibly go orphaned until its anchor has failed to match for GRACE_MS.
      An edit and its reanchor usually round-trip inside that, so the pair renders as one move rather
      than as a break and a repair. lib/element.js defers an element orphan on the same reasoning: a
      false orphan costs the human a rescue, a late one costs nothing.

   Two orphan reasons opt out, for opposite reasons. `never-matched` is a bad anchor from birth, an
   agent quoting text that is not in the file, and there is nothing to protect: no position was ever
   held and the point of the -1 rank is to put the broken thing where it will be seen. `element-changed`
   is an asset's element anchor, where the browser picker has a DOM, is the better-informed authority,
   and has already done its own deferring before it says the element is gone.

   Time is passed in rather than read, so every decision here is a pure function of arguments and
   recorded state, and the tests can run the clock themselves. */
(function (root) {
  'use strict';

  // Seven seconds. The round trip this covers is: the agent writes the file, chokidar pushes the
  // change, the client re-renders, and then the agent's NEXT tool call runs `sidecar reanchor`. The
  // gap that matters is the model's turnaround between those two calls, a few seconds in practice.
  // Seven leaves margin over that without leaving a genuinely broken anchor unreported for long
  // enough to matter: the human is still reading the paragraph it was attached to.
  const GRACE_MS = 7000;

  // The reasons that skip the grace window and the position memory both. See the header.
  const IMMEDIATE = ['never-matched', 'element-changed'];

  function create(opts) {
    const o = opts || {};
    const grace = o.graceMs == null ? GRACE_MS : o.graceMs;
    // id → { everLive, failedAt, rank, top, pin }
    //   everLive  this page has seen the anchor match at least once (so a cold load is distinguishable)
    //   failedAt  when it most recently STOPPED matching, null while it matches
    //   rank/top  the last position it held against a real mark
    //   pin       the frozen position, while a reply is being typed into it
    const recs = new Map();
    const rec = (id) => {
      let r = recs.get(id);
      if (!r) recs.set(id, r = { everLive: false, failedAt: null, rank: null, top: null, pin: null });
      return r;
    };

    return {
      graceMs: grace,

      // ---- observation: called once per item per render, with the matcher's verdict ----
      observe(id, matched, now) {
        const r = rec(id);
        if (matched) { r.everLive = true; r.failedAt = null; }
        else if (r.failedAt == null) r.failedAt = now;
        return r;
      },
      // The rank and the pixel are recorded SEPARATELY because they are learned at different moments:
      // the rank when the rail sorts, the top when the card is placed against its mark one layout later.
      noteRank(id, rank) { if (rank >= 0) rec(id).rank = rank; },
      noteTop(id, top) { if (top != null && isFinite(top)) rec(id).top = top; },

      // ---- the decision the card renders ----
      // `dead` is what the FILE says (status orphaned, or the asset frame reporting the element gone);
      // this is what the CARD shows. Deliberately read-only: an item that has never been observed (a
      // nested reply-suggestion, which is not docked and never ranked) must not gain a record here and
      // then be evicted by keep() on the next pass.
      showOrphaned(id, dead, reason, now) {
        if (!dead) return false;
        if (IMMEDIATE.indexOf(reason) >= 0) return true;
        const r = recs.get(id);
        if (!r || !r.everLive) return true;   // cold load: it arrived broken, nothing to protect
        if (r.failedAt == null) return false; // the file says gone, our own matcher still finds it: no flash
        return now - r.failedAt >= grace;
      },
      // Milliseconds until the earliest card would flip, so the page can arm one timer for it. Nothing
      // else re-renders on its own once the file has stopped changing, and a grace that expires without
      // a render is a card that stays open forever on a dead anchor.
      // A window that has ALREADY expired is not pending and must report nothing. Returning 0 for one
      // reads as "render immediately", and since the record survives the render (the anchor is still
      // broken), the next arm returns 0 again: a card nobody repaired spins the rail in a render loop
      // for as long as the tab is open. Caught in live testing, where a hidden tab's 1s timer clamp was
      // the only thing making it look like a heartbeat instead of a fire.
      nextFlip(now) {
        let soonest = null;
        for (const r of recs.values()) {
          if (!r.everLive || r.failedAt == null) continue;
          const left = grace - (now - r.failedAt);
          if (left <= 0) continue;
          if (soonest == null || left < soonest) soonest = left;
        }
        return soonest;
      },

      // ---- where the card goes ----
      // `live` is the position the document gives it right now, or -1 / null when the anchor matches
      // nothing. A pin wins over everything, including a live mark: that is what freezing means.
      rankFor(id, live, reason) {
        const r = recs.get(id);
        if (r && r.pin) return r.pin.rank;
        if (live >= 0) return live;
        if (IMMEDIATE.indexOf(reason) >= 0) return -1;
        return r && r.rank != null ? r.rank : -1;
      },
      topFor(id, live, reason) {
        const r = recs.get(id);
        if (r && r.pin) return r.pin.top;
        if (live != null) return live;
        if (IMMEDIATE.indexOf(reason) >= 0) return null;
        return r && r.top != null ? r.top : null;
      },

      // ---- freeze ----
      // Pinning is idempotent on purpose: the first snapshot is the one that matters, and syncFreeze
      // runs on every dock, so re-pinning would quietly re-baseline the card to wherever it drifted.
      pin(id, top, rank) {
        const r = rec(id);
        if (!r.pin) r.pin = { top: top, rank: rank == null ? (r.rank == null ? -1 : r.rank) : rank };
        return r.pin;
      },
      unpin(id) { const r = recs.get(id); if (r) r.pin = null; },
      isPinned(id) { const r = recs.get(id); return !!(r && r.pin); },
      pinnedTop(id) { const r = recs.get(id); return r && r.pin ? r.pin.top : null; },

      // ---- lifecycle ----
      // Everything remembered is about one item on one document. An item that has left the active list
      // (resolved, accepted, dropped) is never docked again, and holding its position would mean a
      // resolved-then-reopened card snapping to a place the document no longer has.
      keep(ids) {
        const live = new Set(ids);
        for (const id of [...recs.keys()]) if (!live.has(id)) recs.delete(id);
      },
      reset() { recs.clear(); },
      size() { return recs.size; },
    };
  }

  const API = { create, GRACE_MS, IMMEDIATE };
  if (typeof module === 'object' && module.exports) module.exports = API; else root.Stability = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
