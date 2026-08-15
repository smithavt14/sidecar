/* sidecar — the directory panel's ordering, shared by the browser (loaded via <script>, called from
   index.html's renderNav) and the Node test suite (require'd directly).

   Everything here is PURE: a list of documents in, a new list out. No DOM, no fetch, no dependency,
   so the order the panel draws is the order a test can assert on directly. The panel's own code does
   nothing but paint what comes back. */
(function (root) {
  // Spine order: the two documents a folder is READ from, first and second, then everything else
  // alphabetically. summary.md says where the work stands and brief.md says what the work is, so a
  // reviewer opening a project folder wants those two at the top whatever else has landed since.
  // Alphabetical for the rest, because it is the only order that stays put while a folder grows.
  const SPINE = ['summary.md', 'brief.md'];
  const MODES = ['spine', 'updated', 'turn'];
  const LABELS = { spine: 'spine', updated: 'last updated', turn: 'waiting on you' };

  // A doc is { rel, name, mtime, turn? }. `name` is the basename; fall back to the tail of `rel` so a
  // caller holding only paths still sorts correctly.
  const nameOf = (d) => String((d && (d.name || d.rel)) || '').split('/').pop();
  const spineRank = (d) => { const i = SPINE.indexOf(nameOf(d).toLowerCase()); return i < 0 ? SPINE.length : i; };
  // Numeric collation so slice2 sorts before slice10. The raw comparison behind it is the tiebreak:
  // the collator calls "A.md" and "a.md" equal, and a sort whose order depends on what readdir
  // happened to return is a sort that changes under you for no reason.
  function cmpName(a, b) {
    const x = nameOf(a), y = nameOf(b);
    return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) || (x < y ? -1 : x > y ? 1 : 0);
  }
  const cmpSpine = (a, b) => spineRank(a) - spineRank(b) || cmpName(a, b);

  function sort(docs, mode) {
    const list = (docs || []).slice();
    if (mode === 'updated') return list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || cmpSpine(a, b));
    // "waiting on you" is the count of items on a doc whose turn is the HUMAN's. Nothing computes
    // `turn` yet — the badges are their own slice — and an absent count reads as 0 on every document,
    // so this mode currently resolves to spine order rather than to an arbitrary one. The ordering
    // hook is here so the switcher is a real choice the moment the counts arrive.
    if (mode === 'turn') return list.sort((a, b) => (b.turn || 0) - (a.turn || 0) || cmpSpine(a, b));
    return list.sort(cmpSpine);
  }

  const api = { SPINE, MODES, LABELS, sort, spineRank, cmpSpine };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Nav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
