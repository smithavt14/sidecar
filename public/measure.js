/* sidecar — the reading measure as a number. Loaded in <head> ahead of the pre-paint stamp (the same
   way themes.js is) and required by the Node tests, so the migration from the three named widths, the
   floor, and the arithmetic a drag runs are one copy the page and the suite both read.

   The measure is the width of the TEXT in em, resolved against #doc's own type size, so a reader who
   steps the type up keeps the same number of characters on a line. It used to be one of three names
   (narrow, default, wide); it is a number now, stored under the same key, and the three names still
   read as the widths they were so nobody's saved preference moves on upgrade.

   There is no ceiling. The document fills its column when the measure is wider than the column, and
   what "full width" means depends on the window, so a drag clamps to the column it can see and a
   stored value larger than that column is simply the column. Everything here is pure: the page hands
   in the pixels it measured and takes a number back. */
(function (root) {
  const KEY = 'sidecar.measure';
  const MIN = 26;          // under this a line of Geist at 16.5px is about 50 characters and stops reading as prose
  const DEFAULT = 33;      // the reading column's own width: 545px and 66 characters at 16.5px
  const LEGACY = { narrow: 29, default: 33, wide: 39 };   // the three names the header used to cycle

  // The stored value → em. A legacy name maps to the width it was; a number is honoured down to the
  // floor and up without limit; anything else (nothing stored, junk, `constructor`) is the default.
  // hasOwnProperty rather than a truth test, for the reason the old stamp used it: a stored
  // `constructor` resolves up the prototype chain and would set the column's width to a function.
  function parse(stored) {
    if (typeof stored !== 'string') return DEFAULT;
    if (Object.prototype.hasOwnProperty.call(LEGACY, stored)) return LEGACY[stored];
    const n = Number(stored);
    if (!Number.isFinite(n) || n < MIN) return DEFAULT;
    return Math.round(n * 2) / 2;
  }
  function read(storage) {
    let v = null;
    try { v = storage.getItem(KEY); } catch (e) {}
    return parse(v);
  }
  // Half-em steps, which is about 8px at the default size: fine enough that a drag never visibly
  // snaps, coarse enough that the stored value is a number someone can read back.
  const clamp = (em, max) => Math.max(MIN, Math.min(max == null ? Infinity : max, Math.round(em * 2) / 2));
  const format = (em) => String(clamp(em));

  // How wide the column is, in em of the document's type, once the two reading gutters are taken off.
  // This is the largest measure that changes anything at this window: past it the document is the column.
  function fullEm(colWidth, gutter, fontSize) {
    if (!(fontSize > 0)) return DEFAULT;
    return Math.max(MIN, Math.round(((colWidth - gutter) / fontSize) * 2) / 2);
  }
  // Within an em of the column counts as full. The column itself moves by a scrollbar's width when
  // the document gets shorter as it gets wider, so a drag that pinned at the edge can read a fraction
  // under the edge a frame later; a label that flipped between "full" and "82em" on that would be lying
  // about nothing.
  const isFull = (em, full) => em >= full - 1;

  // The drag. The document is centred in its column, so its right edge moving one pixel widens the
  // text by two: the measure is twice the pointer's distance from the column's centre, less the two
  // gutters, in em of the document's type. Clamped to the column, so the handle stops at the edge and
  // a stored width is always one the reader has seen applied.
  function fromEdge({ center, x, gutter, fontSize, max }) {
    if (!(fontSize > 0)) return DEFAULT;
    const width = 2 * (x - center) - gutter;
    return clamp(width / fontSize, max);
  }
  // Keyboard on the handle: one em a step, four with shift. Bounded the same way a drag is.
  function step(em, dir, big, max) { return clamp(em + dir * (big ? 4 : 1), max); }

  // The header icon's two rules sit where the column's edges do: narrower than the default and they
  // move in, wider and they move out. Bounded so a full-width column does not draw the rules off the
  // button.
  function iconScale(em) { return Math.max(0.55, Math.min(1.35, Math.round((1 + (em - DEFAULT) * 0.03) * 100) / 100)); }

  // What the pre-paint stamp runs: read, apply, return. The page has no other way to know the number
  // before its own script has loaded.
  function boot(document, storage) {
    const em = read(storage);
    document.documentElement.style.setProperty('--measure', em + 'em');
    return em;
  }

  const API = { KEY, MIN, DEFAULT, LEGACY, parse, read, clamp, format, fullEm, isFull, fromEdge, step, iconScale, boot };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Measure = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
