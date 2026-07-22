/* sidecar — the markdown serialization / tight-diff round-trip, shared by the browser (loaded via
   <script>, called from index.html's save path) and Node tests (require'd against a jsdom DOM).
   Extracted verbatim from index.html so the exact same code that runs the live save path is what
   the test suite exercises — no re-implemented turndown config drifting out of sync with the page.

   Everything here is PURE: the DOM element, the block model, and the marked/turndown instances are
   passed in as PARAMETERS (the page closes over $('doc') / blocks / td / marked and forwards them),
   so a test can call these with a jsdom-built #doc and the real marked+turndown+gfm from npm. The
   turndown config (escape off, gfm plugin, tightList li-rule) stays in the caller and is passed as
   `td` — this module never constructs it, so both sides serialize through the identical instance. */
(function (root) {
  function toMd(node, td) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('mark.anchor').forEach(m => m.replaceWith(...m.childNodes)); // locate highlights never save
    // Strip any ​ caret-escape left by an inline input rule (see tryInlineRule); it's invisible and never saved.
    return td.turndown(clone.innerHTML).replace(/​/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }
  function renderedBlocks(doc) { return [...doc.querySelectorAll('.block')]; }

  // Tight-diff serialize: untouched blocks emit their ORIGINAL bytes (wraps intact); only edited blocks
  // are re-serialized. Change is detected by comparing each block's markdown to its render-time baseline
  // (md0), so cosmetic contenteditable DOM noise doesn't count.
  function serialize(doc, blocks, td) {
    const els = renderedBlocks(doc);
    const rendered = blocks.filter(b => b.token.type !== 'space');
    if (els.length === rendered.length) {
      let out = '', k = 0;
      for (const b of blocks) {
        if (b.token.type === 'space') { out += b.token.raw; continue; }
        const el = els[k++], md = toMd(el, td);
        if (md === b.md0) { out += b.token.raw; continue; }        // untouched → verbatim, original wrapping
        // Preserve this token's EXACT trailing newlines (often "" — the gap is a separate space token);
        // fabricating one here would inject a blank line on every edit.
        const trailing = b.token.raw.slice(b.token.raw.replace(/\n+$/, '').length);
        out += md + trailing;
      }
      return { md: out, tight: true };
    }
    // Block count changed (a paragraph merged/split/deleted, so blocks and els no longer line up).
    // NEVER re-serialize the whole doc through turndown here: that would run an UNTOUCHED table / task
    // list / strikethrough three blocks away back through turndown and risk corrupting it — the reported
    // data-loss bug. Instead, align each surviving DOM block to its original by content identity (md0):
    // matched blocks emit their EXACT original bytes (raw + trailing gap), only genuinely new/changed
    // blocks go through turndown. So an edit to one paragraph can never rewrite an untouched block.
    const origNS = [];                        // non-space originals, each carrying the gap that followed it
    let lead = '', cur = null;
    for (const b of blocks) {
      if (b.token.type === 'space') { if (cur) cur.sepAfter += b.token.raw; else lead += b.token.raw; }
      else { cur = { raw: b.token.raw, md0: b.md0, sepAfter: '' }; origNS.push(cur); }
    }
    let out = lead, oi = 0;
    for (const el of els) {
      const md = toMd(el, td);
      let m = -1;
      if (oi < origNS.length && origNS[oi].md0 === md) m = oi;    // in-order match (the common case)
      else for (let j = oi + 1; j < origNS.length; j++) if (origNS[j].md0 === md) { m = j; break; }  // skip deleted
      if (m !== -1) { out += origNS[m].raw + origNS[m].sepAfter; oi = m + 1; }   // untouched → exact bytes + gap
      else out += md + '\n\n';                                                   // new/changed → turndown, framed
    }
    // Only normalize the very end (one trailing newline); never collapse interior blank lines — a fenced
    // code block can legitimately contain them, and untouched blocks are emitted byte-for-byte above.
    return { md: out.replace(/\n+$/, '\n'), tight: false };
  }

  // After a tight save, re-lex the new markdown to refresh each block's raw/offsets/baseline in place
  // (DOM untouched, caret kept) so the next edit is measured against current state. Returns the new
  // blocks array; on the guard miss (token/element count disagree) returns the passed blocks unchanged,
  // so the caller's `blocks = reindex(...)` is always safe.
  function reindex(doc, blocks, markdown, marked, td) {
    const els = renderedBlocks(doc);
    const toks = marked.lexer(markdown);
    if (toks.filter(t => t.type !== 'space').length !== els.length) return blocks;
    const next = []; let off = 0, k = 0;
    for (const t of toks) {
      const start = off; off += t.raw.length;
      const b = { token: t, start, end: off };
      if (t.type !== 'space') b.md0 = toMd(els[k++], td);
      next.push(b);
    }
    return next;
  }

  const API = { toMd, renderedBlocks, serialize, reindex };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Serialize = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
