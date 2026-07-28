/* sidecar — the flow-diagram renderer for ```flow fences, shared by the browser (loaded via <script>,
   called from index.html's renderDoc) and the Node test suite (require'd directly).

   Everything here is PURE and DOM-free: parse+layout+render are string in, string out, so a test can
   assert on the SVG without jsdom and the browser gets the identical bytes. Text widths are ESTIMATED
   from character counts rather than measured, which is why boxes bias wide — see sizeOf().

   Why not mermaid: 83.5 MB unpacked across 1,171 files (11.16.0), in a tool whose whole published
   tarball is 17 files and which has no build step. The syntax below is a deliberate SUBSET of
   mermaid's flowchart syntax — `A --> B`, `A -->|label| B`, `{decision}`, `%%` comments, TD/LR — so
   what people already know transfers, and swapping in the real thing later stays possible.

   The document is the source of truth for the picture, and a comment on a node anchors to that node's
   LABEL TEXT in the fence (see nodes[].at). That is the whole reason this is a fence and not inline
   SVG: turndown round-trips a fence byte-for-byte, and the anchor matcher already reaches inside one
   (test.js "matcher pin: a comment can still anchor to text inside a fenced code block"). */
(function (root) {
  const NODE_H = 40, V_GAP = 46, H_GAP = 28, PAD = 12, MIN_W = 92, BULGE = 46;

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // A label's box size. No DOM here, so width is estimated at 7.6px/char + padding against the 13px
  // UI sans. Over-estimating is safe (the text is centre-anchored and just gets more air); under-
  // estimating spills text outside the box, so the constant leans high on purpose.
  function sizeOf(label, decision) {
    const w = Math.max(MIN_W, Math.round(label.length * 7.6) + 34);
    return { w: decision ? w + 24 : w, h: NODE_H };   // a diamond needs slack to clear its points
  }

  // One arrow: `-->`, `--->`, with an optional `|label|` immediately after. Global — a line may chain
  // (`A --> B --> C`), and the segments between arrows are the nodes.
  const ARROW = /--+>\s*(?:\|([^|]*)\|)?/g;

  function parse(src) {
    const model = { dir: 'TD', nodes: [], edges: [], errors: [] };
    const byLabel = new Map();
    let offset = 0;

    // `at` is the label's character offset within `src`, which is what lets a click on a box anchor to
    // THAT mention of it rather than to some earlier line that happens to share the word.
    const node = (label, at) => {
      const decision = /^\{.*\}$/.test(label);
      const text = decision ? label.slice(1, -1).trim() : label;
      if (!text) return null;
      let n = byLabel.get(text);
      if (!n) {
        n = { label: text, decision, at: at + (decision ? 1 : 0), idx: model.nodes.length };
        byLabel.set(text, n); model.nodes.push(n);
      }
      if (decision) n.decision = true;   // `{X}` anywhere wins, so shape doesn't depend on mention order
      return n;
    };

    for (const line of src.split('\n')) {
      const lineStart = offset; offset += line.length + 1;
      const body = line.trim();
      if (!body || body.startsWith('%%')) continue;
      if (/^(direction\s*:?\s*)?(TD|TB|LR)$/i.test(body)) { model.dir = /LR/i.test(body) ? 'LR' : 'TD'; continue; }

      // Split the line into label segments and the arrows between them, tracking each segment's real
      // offset in `src` so `at` survives leading whitespace and chained arrows alike.
      const segs = []; const labels = [];
      ARROW.lastIndex = 0;
      let cursor = 0, m;
      while ((m = ARROW.exec(line))) { segs.push([cursor, m.index]); labels.push(m[1] ? m[1].trim() : ''); cursor = ARROW.lastIndex; }
      segs.push([cursor, line.length]);

      const parsed = segs.map(([a, b]) => {
        const slice = line.slice(a, b);
        const lead = slice.length - slice.replace(/^\s+/, '').length;
        return node(slice.trim(), lineStart + a + lead);
      });
      if (parsed.some(n => !n)) { model.errors.push(body); continue; }
      for (let i = 0; i < parsed.length - 1; i++) model.edges.push({ from: parsed[i], to: parsed[i + 1], label: labels[i] });
    }
    return model;
  }

  // Longest-path ranking over the DAG left after back edges are removed. Cycles are ordinary in UX
  // flows ("invalid → back to step 1"), and ranking THROUGH one walks every node down a level per
  // pass: the loop below would push each node |V| ranks deep and scatter them into a tall ladder with
  // empty rows between. So a DFS drops the edges that close a cycle first; they still draw, as a line
  // that climbs back up.
  function rank(model) {
    const outs = new Map(model.nodes.map(n => [n, []]));
    for (const e of model.edges) outs.get(e.from).push(e);
    const seen = new Map(), back = new Set();
    const walk = (n) => {
      seen.set(n, 1);
      for (const e of outs.get(n)) {
        if (seen.get(e.to) === 1) back.add(e);            // target is still on the stack → closes a cycle
        else if (!seen.has(e.to)) walk(e.to);
      }
      seen.set(n, 2);
    };
    for (const n of model.nodes) if (!seen.has(n)) walk(n);

    const forward = model.edges.filter(e => !back.has(e));
    const r = new Map(model.nodes.map(n => [n, 0]));
    for (let pass = 0; pass < model.nodes.length; pass++) {
      let moved = false;
      for (const e of forward) if (r.get(e.to) < r.get(e.from) + 1) { r.set(e.to, r.get(e.from) + 1); moved = true; }
      if (!moved) break;
    }
    for (const e of model.edges) e.back = back.has(e);
    return r;
  }

  function layout(model) {
    const r = rank(model);
    // Group by rank, then COMPACT: an empty rank would be a hole in a sparse array, and `Math.max(...)`
    // over a hole is NaN — which propagates silently into the viewBox and renders nothing at all.
    const byRank = new Map();
    for (const n of model.nodes) (byRank.get(r.get(n)) || byRank.set(r.get(n), []).get(r.get(n))).push(n);
    const ranks = [...byRank.keys()].sort((a, b) => a - b).map(k => byRank.get(k));
    for (const n of model.nodes) Object.assign(n, sizeOf(n.label, n.decision));

    const vertical = model.dir === 'TD';
    // An empty fence has no ranks, and the depth sum below would come back as -V_GAP — a negative
    // viewBox height that renders as nothing with no hint why.
    if (!ranks.length) return { nodes: [], edges: [], dir: model.dir, errors: model.errors, width: 0, height: 0 };
    // Lay each rank out along its own axis, then centre the ranks against the widest one. The two
    // directions are the same arithmetic with the axes swapped.
    const spans = ranks.map(row => row.reduce((s, n) => s + (vertical ? n.w : n.h), 0) + H_GAP * (row.length - 1));
    const maxSpan = Math.max(0, ...spans);
    const depth = ranks.reduce((acc, row) => acc + (vertical ? NODE_H : Math.max(...row.map(n => n.w))) + V_GAP, 0) - V_GAP;

    let along = 0;
    ranks.forEach((row, ri) => {
      const rowDepth = vertical ? NODE_H : Math.max(...row.map(n => n.w));
      let across = PAD + (maxSpan - spans[ri]) / 2;
      for (const n of row) {
        if (vertical) { n.x = across; n.y = PAD + along; across += n.w + H_GAP; }
        else { n.y = across; n.x = PAD + along; across += n.h + H_GAP; }
      }
      along += rowDepth + V_GAP;
    });

    // A back edge loops out to the side, so the canvas needs room for the bulge or it clips.
    const loop = model.edges.some(e => e.back) ? BULGE + 14 : 0;
    return { nodes: model.nodes, edges: model.edges, dir: model.dir, errors: model.errors, loop,
      width: (vertical ? maxSpan : depth) + PAD * 2 + (vertical ? loop : 0),
      height: (vertical ? depth : maxSpan) + PAD * 2 + (vertical ? 0 : loop) };
  }

  function diamond(n) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    return `${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`;
  }

  // A forward edge leaves the source's trailing face and enters the target's leading face — a straight
  // line down (TD) or across (LR).
  //
  // A back edge cannot use those faces: it runs between the same two boxes as the forward edge and
  // would be drawn directly on top of it, which also puts its label ("no") on the forward arrow, where
  // it reads as a label for the opposite branch. So it bulges out to the side instead, on a curve.
  function port(model, e) {
    const a = e.from, b = e.to, vertical = model.dir === 'TD';
    if (!e.back) {
      return vertical
        ? { x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y }
        : { x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: b.y + b.h / 2 };
    }
    return vertical
      ? { x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x + b.w, y2: b.y + b.h / 2, bulge: 'x' }
      : { x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y + b.h, bulge: 'y' };
  }

  // The curve for a back edge, plus the point its label should sit on (the apex, where the curve is
  // clear of every box).
  function loopPath(p) {
    if (p.bulge === 'x') {
      const cx = Math.max(p.x1, p.x2) + BULGE;
      return { d: `M${p.x1},${p.y1} C${cx},${p.y1} ${cx},${p.y2} ${p.x2},${p.y2}`,
        lx: (p.x1 + p.x2) / 2 + BULGE * 0.75, ly: (p.y1 + p.y2) / 2 + 4 };
    }
    const cy = Math.max(p.y1, p.y2) + BULGE;
    return { d: `M${p.x1},${p.y1} C${p.x1},${cy} ${p.x2},${cy} ${p.x2},${p.y2}`,
      lx: (p.x1 + p.x2) / 2, ly: (p.y1 + p.y2) / 2 + BULGE * 0.75 };
  }

  function render(src) {
    const model = layout(parse(src));
    const out = [];
    out.push(`<svg class="fl" viewBox="0 0 ${model.width} ${model.height}" width="${model.width}" height="${model.height}" xmlns="http://www.w3.org/2000/svg" role="img">`);
    out.push('<defs><marker id="fl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
      + '<path d="M0,0 L8,4 L0,8 z" class="fl-head"/></marker></defs>');

    for (const e of model.edges) {
      const p = port(model, e);
      let mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2 + 4;
      if (e.back) {
        const l = loopPath(p); mx = l.lx; my = l.ly;
        out.push(`<path class="fl-edge fl-back" d="${l.d}" marker-end="url(#fl-arrow)"/>`);
      } else {
        out.push(`<line class="fl-edge" x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" marker-end="url(#fl-arrow)"/>`);
      }
      if (e.label) {
        const w = e.label.length * 6.4 + 10;
        out.push(`<rect class="fl-elabel-bg" x="${(mx - w / 2).toFixed(1)}" y="${(my - 13).toFixed(1)}" width="${w.toFixed(1)}" height="18" rx="4"/>`);
        out.push(`<text class="fl-elabel" x="${mx.toFixed(1)}" y="${my.toFixed(1)}">${esc(e.label)}</text>`);
      }
    }

    for (const n of model.nodes) {
      // data-node is an INDEX, never the label: DOMPurify's SAFE_FOR_XML strips any attribute whose
      // value contains `-->`, so anything carrying raw flow source would silently lose the attribute.
      out.push(`<g class="fl-node${n.decision ? ' fl-decision' : ''}" data-node="${n.idx}" tabindex="0">`);
      out.push(n.decision
        ? `<polygon class="fl-box" points="${diamond(n)}"/>`
        : `<rect class="fl-box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8"/>`);
      out.push(`<text class="fl-label" x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 4}">${esc(n.label)}</text>`);
      out.push('</g>');
    }
    out.push('</svg>');

    // A malformed line is shown, not swallowed — a diagram that quietly drops an edge is worse than
    // one that says which line it could not read.
    const errors = model.errors.length
      ? `<div class="fl-errors">could not read: ${model.errors.map(esc).join(' · ')}</div>` : '';
    return { svg: out.join('') + errors, nodes: model.nodes.map(n => ({ label: n.label, at: n.at, idx: n.idx })) };
  }

  const api = { parse, layout, render };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Flow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
