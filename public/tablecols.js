/* sidecar — a table's column widths, as a view preference. Loaded by the page via <script> and
   required by the Node tests, so what the page stores, applies and hit-tests is what the suite reads.

   GFM markdown has nowhere to write a column width, so a width the reader drags is REMEMBERED rather
   than saved: in localStorage, keyed by the document's path and the table's ordinal in it, and put
   back on the header cells after every render. Nothing here touches the markdown, the save path or
   the dirty flag; a test round-trips a document with resized columns through serialize and asserts
   the bytes did not move.

   The width goes on the header cell as an inline style, which is the whole mechanism: a cell width in
   an auto-layout table is the column's width, turndown reads a cell's content and never its
   attributes, and the document is contenteditable so no element is added to it. The grab zones are
   not elements either: the page hit-tests the pointer against the header row's rects with `zone`
   below and paints a class on the cell whose edge is under it.

   Everything here is pure: rects and plain objects in, plain objects out. */
(function (root) {
  const BAND = 5;        // px either side of a boundary that count as grabbing it
  const MIN_COL = 48;    // narrower than this and a cell shows nothing but its padding

  // The uiStore key, per document. The path is the identity: a review is per document and so is this.
  const key = (file) => 'tableCols:' + String(file || '');

  // The stored JSON → { [tableIndex]: { [colIndex]: px } }. Anything that is not that shape is dropped
  // rather than applied: a width is echoed into a style attribute, so junk stays out of it.
  function parse(json) {
    if (!json || typeof json !== 'string') return {};
    let v;
    try { v = JSON.parse(json); } catch (e) { return {}; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const t of Object.keys(v)) {
      if (!/^\d+$/.test(t) || !v[t] || typeof v[t] !== 'object' || Array.isArray(v[t])) continue;
      const cols = {};
      for (const c of Object.keys(v[t])) {
        const px = v[t][c];
        if (/^\d+$/.test(c) && Number.isInteger(px) && px >= MIN_COL) cols[c] = px;
      }
      if (Object.keys(cols).length) out[t] = cols;
    }
    return out;
  }
  // The other direction. Empty is the empty string rather than `{}`, so a document with nothing
  // remembered stores nothing.
  const serialize = (widths) => (Object.keys(widths || {}).length ? JSON.stringify(widths) : '');

  // Set and reset return a NEW object; the page swaps its reference and nothing holds a stale one.
  function set(widths, t, c, px) {
    const out = JSON.parse(JSON.stringify(widths || {}));
    out[t] = out[t] || {};
    out[t][c] = Math.max(MIN_COL, Math.round(px));
    return out;
  }
  function reset(widths, t, c) {
    const out = JSON.parse(JSON.stringify(widths || {}));
    if (out[t]) { delete out[t][c]; if (!Object.keys(out[t]).length) delete out[t]; }
    return out;
  }
  const width = (widths, t, c) => (widths && widths[t] && widths[t][c]) || null;
  // Every column of one table pinned at what it currently measures, except those already remembered.
  // Run on the first move of a drag: in an auto-layout table a fixed column takes its width out of
  // its unfixed neighbours before the table grows, so widening one column would fold the others to
  // their minimum. With the row pinned, the boundary the reader grabbed is the only thing that moves
  // and the table scrolls sideways for the rest, which is what the drag looked like it would do.
  function fill(widths, t, current) {
    let out = widths || {};
    current.forEach((px, c) => { if (!width(out, t, c) && px > 0) out = set(out, t, c, px); });
    return out;
  }

  // The cells a width goes on: the header row's, since every column has exactly one and it is the row
  // the grab zones sit on. A table marked has no <thead> only when it did not come from markdown.
  function headerCells(table) {
    const row = table.querySelector('thead tr') || table.querySelector('tr');
    return row ? [...row.children].filter(c => /^T[HD]$/.test(c.tagName)) : [];
  }
  // One cell's width, or its release. Both `width` and `min-width`, because in Chrome's auto layout a
  // cell's `width` alone is a preference the table's container can overrule: a column widened past
  // the column of prose was folded straight back, since the table is capped at 100% and its columns
  // share what is left. `min-width` is a floor the container cannot take from, so the table grows
  // past it and scrolls, which is what a wider column asked for. Measured in headless Chrome against
  // the live page before either was chosen. Narrowing stops at the cell's own min-content either
  // way, so a word never breaks.
  function setCell(cell, px) {
    if (px) { cell.style.width = px + 'px'; cell.style.minWidth = px + 'px'; }
    else { cell.style.removeProperty('width'); cell.style.removeProperty('min-width'); }
  }
  // Put the remembered widths on the tables, in document order, and take them off cells that have
  // none remembered. Runs after every render, which is what makes a width survive one.
  function apply(tables, widths) {
    tables.forEach((table, t) => {
      headerCells(table).forEach((cell, c) => setCell(cell, width(widths, t, c)));
    });
  }

  // Which column's right edge is under the pointer: the index, or -1. `rects` are the header cells'
  // bounding rects in column order. The zone straddles the boundary, so the pointer counts whether it
  // is over the last pixels of this cell or the first of the next; the last column's right edge is a
  // boundary too, since widening it is how the table grows.
  function zone(rects, x, y, band) {
    const b = band == null ? BAND : band;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (y < r.top || y > r.bottom) continue;
      if (Math.abs(x - r.right) <= b) return i;
    }
    return -1;
  }
  // The width a drag lands on: where it started plus how far the pointer went, floored.
  const resize = (startWidth, dx) => Math.max(MIN_COL, Math.round(startWidth + dx));

  const API = { BAND, MIN_COL, key, parse, serialize, set, reset, width, fill, headerCells, setCell, apply, zone, resize };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.TableCols = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
