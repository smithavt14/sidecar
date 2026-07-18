/* margin — the ONE content-anchor matcher, shared by server (accept/format/orphan) and client
   (occurrenceFor / highlight). Before this existed the server matched raw bytes with no whitespace
   normalization while the client normalized `\s+`→' ', so a quote spanning a soft line-break counted
   a different number of occurrences on each side — the highlight could point at one duplicate while
   /api/accept spliced another. Everything now flows through findNth / occurrenceAt so both sides
   agree on WHICH occurrence a quote resolves to, in the raw text, byte-for-byte.

   Two normalization knobs, applied identically to needle + haystack:
     - whitespace: any run of \s collapses to a single space (fixes the soft-line-break divergence)
     - markdown-tolerant (strip=true): the inline markers *_`~ are dropped, so a visible-text quote
       ("bold text") still matches its source ("**bold** text").
   Matching is two-phase: an EXACT pass (ws-normalized, markers kept) preserves precision for quotes
   that legitimately contain markers, then a tolerant pass (markers stripped) as a fallback. Offsets
   always map back to the ORIGINAL raw string. */
(function (root) {
  const MD = '*_`~';
  const isWord = (c) => /\w/.test(c);

  // Normalize `text`, returning the normalized string plus map[i] = index in `text` of norm[i].
  // A collapsed whitespace run maps to the first raw char of the run; since callers trim the needle,
  // a match never begins or ends on a collapsed space, so start/end map back exactly.
  function normalize(text, strip) {
    const chars = [], map = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (strip && MD.includes(ch)) { i++; continue; }
      if (/\s/.test(ch)) { const run = i; while (i < text.length && /\s/.test(text[i])) i++; chars.push(' '); map.push(run); continue; }
      chars.push(ch); map.push(i); i++;
    }
    return { norm: chars.join(''), map };
  }

  // All raw {start,end} spans where `quote` occurs under one normalization mode. Overlapping allowed
  // (from = at+1), matching the original matcher.
  function matchAll(raw, quote, strip) {
    const needle = normalize(quote, strip).norm.trim();
    if (!needle) return [];
    const { norm, map } = normalize(raw, strip);
    const hits = [];
    let from = 0, at;
    while ((at = norm.indexOf(needle, from)) !== -1) {
      const start = map[at], lastIdx = at + needle.length - 1;
      const end = lastIdx < map.length ? map[lastIdx] + 1 : raw.length;
      hits.push({ start, end });
      from = at + 1;
    }
    return hits;
  }

  // Effective neighbour char, skipping the inline markers that a tolerant match may sit inside
  // (so "bold" inside "**bold**" sees the space/newline outside the markers, not the `*`).
  function effBefore(raw, i) { i--; while (i >= 0 && MD.includes(raw[i])) i--; return i >= 0 ? raw[i] : ''; }
  function effAfter(raw, i) { while (i < raw.length && MD.includes(raw[i])) i++; return i < raw.length ? raw[i] : ''; }

  // Word-boundary rule (M1): a quote that STARTS/ENDS on a word char should not match mid-word — quote
  // "cat" must not anchor inside "category". Only the edges where the quote itself is a word char are
  // constrained, so a quote that legitimately starts/ends mid-word or on punctuation is left alone.
  function boundaryOk(raw, quote, hit) {
    const nq = normalize(quote, true).norm.trim();
    if (!nq) return true;
    if (isWord(nq[0]) && isWord(effBefore(raw, hit.start))) return false;
    if (isWord(nq[nq.length - 1]) && isWord(effAfter(raw, hit.end))) return false;
    return true;
  }

  // The canonical hit list: exact pass if it finds anything, else the tolerant pass; then PREFER the
  // word-boundary-clean hits, but fall back to the full set when none qualify (so a deliberately
  // mid-word quote still resolves). Both findNth and occurrenceAt count over this same list, which is
  // exactly why server and client can never disagree on occurrence numbering.
  function findAll(raw, quote) {
    let hits = matchAll(raw, quote, false);
    if (!hits.length) hits = matchAll(raw, quote, true);
    const bounded = hits.filter((h) => boundaryOk(raw, quote, h));
    return bounded.length ? bounded : hits;
  }

  // The Nth occurrence's raw span, or null. Same signature/behaviour the old server findAnchor exposed.
  function findNth(raw, quote, occurrence = 0) {
    return findAll(raw, quote)[occurrence] || null;
  }

  // Which occurrence a hit at `charOffset` in `raw` is: the span containing it, else the nearest by
  // start. Inverse of findNth — used to turn a UI selection's offset into an occurrence index.
  function occurrenceAt(raw, quote, charOffset) {
    const hits = findAll(raw, quote);
    if (!hits.length) return 0;
    const inside = hits.findIndex((h) => charOffset >= h.start && charOffset < h.end);
    if (inside !== -1) return inside;
    let best = 0, bd = Infinity;
    hits.forEach((h, n) => { const d = Math.abs(h.start - charOffset); if (d < bd) { bd = d; best = n; } });
    return best;
  }

  const API = { findNth, occurrenceAt, findAll, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Anchor = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
