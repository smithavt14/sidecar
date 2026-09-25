/* sidecar: folded sections, as a view preference. Loaded by the page via <script> and required by the
   Node tests, so what the page hides, stores and restores is what the suite reads.

   A heading folds everything after it up to the next heading of the same or a higher level: an h2
   takes its h3s with it, and the next h2 or h1 ends it. Markdown has nowhere to write "folded", so a
   fold is REMEMBERED rather than saved, in localStorage per document, the way tablecols.js keeps a
   column width. Nothing here touches the markdown, the save path or the dirty flag; a test
   round-trips a folded document through serialize and asserts the bytes did not move.

   A fold is keyed by the heading's text and its occurrence among headings with the same text, never
   by its block index. Every external change re-renders the document (an agent's edit, an accepted
   suggestion, a catch-up after a dropped connection), and an index moves the moment a paragraph is
   added above it, while "the second heading reading Notes" survives that. A heading whose text
   changed loses its fold, which is the honest answer: it is no longer the heading that was folded.

   Everything here is pure: arrays of levels, texts and flags in, arrays and plain objects out. The
   page reads levels and texts off the DOM, so the same functions answer mid-edit. */
(function (root) {
  const MAX_TEXT = 400;   // a heading longer than this is a paragraph somebody marked up; key its head

  // The uiStore key, per document. The path is the identity: a review is per document and so is this.
  const key = (file) => 'folds:' + String(file || '');

  // A heading's text as a key: whitespace collapsed, the editor's zero-width caret escape dropped (it is
  // never saved, so a heading typed into must key the same as it will after a reload), and capped.
  function norm(text) {
    return String(text == null ? '' : text).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  }

  // The stored JSON → { [heading text]: [occurrence, ...] }. Anything that is not that shape is dropped
  // rather than applied, the same strictness tablecols.js keeps: a value from storage is a value
  // somebody else's code may have written.
  function parse(json) {
    if (!json || typeof json !== 'string') return {};
    let v;
    try { v = JSON.parse(json); } catch (e) { return {}; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // No prototype, here and in fromFolded: a heading is free text, and "constructor" or "__proto__"
    // would otherwise land on an inherited property instead of a list.
    const out = Object.create(null);
    for (const t of Object.keys(v)) {
      if (!t || t.length > MAX_TEXT || !Array.isArray(v[t])) continue;
      const ns = [...new Set(v[t].filter(n => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
      if (ns.length) out[t] = ns;
    }
    return out;
  }
  // Empty is the empty string rather than `{}`, so a document with nothing folded stores nothing.
  const serialize = (folds) => (Object.keys(folds || {}).length ? JSON.stringify(folds) : '');

  // Where each heading's section ends, exclusive: the index of the next heading at its level or above,
  // or the end of the document. `levels[i]` is 0 for a block that is not a heading and 1–6 for one.
  // One pass with a stack of open headings, so a long document costs one walk rather than one per heading.
  function ends(levels) {
    const out = levels.map(() => -1), open = [];
    levels.forEach((lv, i) => {
      if (!lv) return;
      while (open.length && levels[open[open.length - 1]] >= lv) out[open.pop()] = i;
      open.push(i);
    });
    while (open.length) out[open.pop()] = levels.length;
    return out;
  }
  // Whether heading `h` has anything to fold. Every heading carries a chevron and can be folded; one
  // followed directly by its next sibling (or by the end of the document) hides nothing, so the page
  // draws no dots after it, which would claim something was held back.
  function foldable(levels, h, end) {
    const e = end || ends(levels);
    return !!levels[h] && e[h] > h + 1;
  }

  // For every block, the heading whose fold hides it, or -1 when it is visible. The OUTERMOST fold wins,
  // since a folded h3 inside a folded h2 is itself hidden and the h2 is what is on screen: that is the
  // heading a card anchored anywhere inside docks beside. A heading with nothing under it is never
  // counted as folded, whatever `folded` says.
  function hiddenBy(levels, folded) {
    const e = ends(levels), out = levels.map(() => -1);
    let cur = -1;
    for (let i = 0; i < levels.length; i++) {
      if (cur !== -1 && i < e[cur]) { out[i] = cur; continue; }
      cur = -1;
      if (folded[i] && foldable(levels, i, e)) cur = i;
    }
    return out;
  }

  // Every heading whose section contains block `i`, outermost first. What a jump to an anchor has to
  // unfold before it scrolls, and what the edit guard unfolds before it lets a range through.
  function containing(levels, i) {
    const e = ends(levels), out = [];
    for (let h = 0; h < i; h++) if (levels[h] && e[h] > i) out.push(h);
    return out;
  }

  // Each heading's key, { text, n }, where n counts earlier headings with the same text; null for a
  // block that is not a heading. The level is not part of it: a heading re-levelled from ## to ### is
  // still the section the reader folded.
  function keys(texts, levels) {
    const seen = new Map();
    return levels.map((lv, i) => {
      if (!lv) return null;
      const text = norm(texts[i]);
      const n = seen.get(text) || 0;
      seen.set(text, n + 1);
      return { text, n };
    });
  }
  // The stored folds → a flag per block.
  function foldedFrom(folds, texts, levels) {
    const f = folds || {};
    return keys(texts, levels).map(k => !!(k && k.text && Object.prototype.hasOwnProperty.call(f, k.text) &&
      Array.isArray(f[k.text]) && f[k.text].includes(k.n)));
  }
  // A flag per block → the stored folds. Written from the live document every time, so a heading typed
  // into while folded is re-keyed by its new text, and a heading that is gone takes its fold with it.
  function fromFolded(texts, levels, folded) {
    const out = Object.create(null);
    keys(texts, levels).forEach((k, i) => {
      if (!k || !k.text || !folded[i]) return;
      (out[k.text] = out[k.text] || []).push(k.n);
    });
    return out;
  }
  // Every heading at `level`: what an Alt-click folds or unfolds together.
  function atLevel(levels, level) {
    const out = [];
    levels.forEach((lv, i) => { if (lv === level) out.push(i); });
    return out;
  }

  const API = { MAX_TEXT, key, norm, parse, serialize, ends, foldable, hiddenBy, containing, keys, foldedFrom, fromFolded, atLevel };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Collapse = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
