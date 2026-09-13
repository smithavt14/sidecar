/* sidecar — typewriter scrolling: where the page has to sit for the caret's line to rest at 45% of
   the window.

   The whole computation is arithmetic over four numbers the browser already knows, so it lives here
   as a pure function rather than inline in the page: the page measures (a caret rect, the window, the
   scroll position, how far the document can scroll) and this decides. Same reason public/turn.js and
   public/stability.js are separate files: a rule worth getting right is worth a test that does not
   need a browser.

   Two things it owns that are easy to get wrong inline:

   - THE CLAMP. A caret in the first paragraph cannot sit at 45% of the window, because the page
     cannot scroll above zero, and a caret in the last line cannot either unless the document has
     room below it (#doc's 40vh bottom padding is where that room comes from). Both ends resolve to
     "scroll as far as the document allows", which is the clamp, and neither is a special case.

   - THE DEADBAND. A move of a pixel or two is invisible and it is also a scroll animation, so every
     arrow key inside one line would restart one. Under the deadband the answer is `null`: hold still.
     `null` rather than "the current scrollY" so the caller never issues a scroll it did not mean.

   45% rather than the middle, following iA Writer and Ulysses: the eye reads a line with the next few
   lines under it, and a caret pinned to the exact centre puts as much dead space below the sentence
   being written as above it. The caret's LINE is centred, not its top, so a wrapped heading at twice
   the body's line height settles where a body line does. */
(function (root) {
  'use strict';

  // Where the active line rests, as a fraction of the window's height.
  const RATIO = 0.45;
  // Below this many pixels, hold still (see above).
  const DEADBAND = 4;

  const num = (v) => typeof v === 'number' && isFinite(v);

  // { caretTop, caretHeight, viewportH, scrollY, maxScroll, ratio } → the scrollY the page should take,
  // or null for "already close enough, or the inputs say nothing".
  //
  // caretTop/caretHeight are VIEWPORT coordinates, straight off a Range's client rect, which is what
  // makes the result self-correcting: called again mid-animation it measures where the caret is now.
  function target(o) {
    o = o || {};
    const viewportH = o.viewportH;
    if (!num(viewportH) || viewportH <= 0) return null;
    if (!num(o.caretTop)) return null;
    const scrollY = num(o.scrollY) ? o.scrollY : 0;
    const height = num(o.caretHeight) && o.caretHeight > 0 ? o.caretHeight : 0;
    const ratio = num(o.ratio) ? Math.min(1, Math.max(0, o.ratio)) : RATIO;
    // The middle of the line, not its top: a heading is twice as tall as a body line and would
    // otherwise rest lower than one.
    const mid = o.caretTop + height / 2;
    const want = viewportH * ratio;
    let next = scrollY + (mid - want);
    const max = num(o.maxScroll) ? Math.max(0, o.maxScroll) : Infinity;
    next = Math.min(max, Math.max(0, next));
    return Math.abs(next - scrollY) < DEADBAND ? null : Math.round(next);
  }

  const API = { RATIO, DEADBAND, target };
  if (typeof module === 'object' && module.exports) module.exports = API; else root.Focus = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
