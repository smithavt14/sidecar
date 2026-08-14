/* sidecar — the PICKER: the one script that runs inside an asset frame.

   It is inlined into the frame's srcdoc by public/assetframe.js. The frame is sandboxed with
   `allow-scripts` and never allow-same-origin, so this code sits on an opaque origin: it cannot read
   the page, cannot reach sidecar's file API, and talks to the page only through postMessage. Every
   message in both directions is `{ type: 'sidecar:<name>', … }`.

     in    init { items }        the review's element anchors, to resolve and mark
           step {}               Alt was tapped over the frame: outline one layer deeper
           pulse { id }          flash one element (the rail's quote was clicked)
           highlight { id }      hover cue (a card is hovered; null clears it)
     out   ready { width, height }        the natural canvas size, so the page can scale to its column
           hover { label, depth, count }  what the cursor is over and where in the stack, for the
                                          page's affordance
           pick { candidates, label, text, rect }   a click on a bare element
           open { id }                    a click on an element that already carries an item
           geometry { rects }             per-item rects, which is what card docking reads
           anchors { anchors }            per-item resolved|missing, which is what orphan display reads
           backfill { id, element }       a refreshed { path, sig } for an anchor the page should store

   The file is loaded two other ways and both matter. Node's tests `require()` it (like public/anchor.js)
   to exercise the pure half — candidate order, path building, signatures, resolution — without a
   browser. And the page fetches its SOURCE to inline. So it boots itself only when it is actually
   inside a frame; at the top level, or under require, it just exports.

   The one duplication in here is deliberate. `selectorFor` re-derives what lib/element.js's parseRef
   already knows, because the frame gets this file and nothing else — a require() would be a second
   subresource on an opaque origin, which is the moving part the inlining exists to remove. A test pins
   the two against each other on all three reference forms. */
(function (root) {
  // The store's rule for an id or a data-sc value (lib/element.js VALUE), and for one step of a
  // structural path (lib/element.js PATH_STEP). Kept in step with those on purpose: a candidate the
  // server would refuse is a comment the human writes and loses.
  const NAME = /^[\w-]+$/;
  const PATH_STEP = /^[a-zA-Z][\w-]*(?::nth-of-type\(\d+\))?$/;
  const PATH_MAX = 300;
  const SIG_CHARS = 80;

  // ---------- the pure half: candidates, paths, signatures, resolution ----------

  function normalizeText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // The element's text as the NODE SIDE will see it, which is not textContent. Node has no DOM: it
  // replaces every tag in the raw HTML with a space and collapses (lib/element.js stripTags), so
  // `<span>a</span><span>b</span>` reads "a b" there and "ab" through textContent. A signature taken
  // the second way never matches the first, and the item orphans the moment it is written. Element
  // boundaries become spaces here for exactly that reason.
  function textOf(el) {
    let out = '';
    (function walk(n) {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) { out += ' '; walk(c); out += ' '; }
      }
    })(el);
    return normalizeText(out);
  }

  // The stored signature: normalized text, first 80 chars, NO ellipsis. Node checks liveness by running
  // this string through the shared matcher against the tag-stripped file (lib/element.js isLive), and a
  // '…' is a character that appears nowhere in the source — it would fail every match.
  function signature(text, n) { return normalizeText(text).slice(0, n || SIG_CHARS); }

  // The DISPLAY snippet, which is a different string for a good reason: it is read by a human on a card,
  // so it is elided. Byte-identical to lib/element.js's snippet(), so a quote the picker writes and a
  // quote `sidecar comment --element` writes look the same on the same element.
  function snippet(text, n) {
    const t = normalizeText(text), max = n || SIG_CHARS;
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  // The `quote` an element item stores — the same synthesis lib/element.js does, for the same reason:
  // every existing surface (cards, digest lines, `show`) reads anchor.quote and none of them should
  // have to learn a second field.
  function synthQuote(label, text) {
    const t = (text || '').trim();
    return t ? label + ' · ' + t : String(label);
  }

  // A `sel` as the store holds it, turned into a selector the frame can run. Always the quoted
  // attribute form: `[data-sc=2fa]` and `#2fa` are legal sidecar references and illegal CSS, so the
  // unquoted spelling would throw on exactly the values a numeric label produces.
  function selectorFor(sel) {
    const s = String(sel == null ? '' : sel).trim();
    if (!s) return null;
    const m = s.match(/^\[\s*data-sc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))\]$/);
    if (m) {
      const v = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim();
      return NAME.test(v) ? '[data-sc="' + v + '"]' : null;
    }
    if (s.charAt(0) === '#') return NAME.test(s.slice(1)) ? '[id="' + s.slice(1) + '"]' : null;
    return NAME.test(s) ? '[data-sc="' + s + '"]' : null;
  }

  // A `tag:nth-of-type(n)` chain up to (not including) <body>. The index is omitted where the element is
  // the only one of its tag among its siblings, which is what makes a real path readable ("main>h1")
  // instead of a wall of nth-of-type(1). The path is a HINT, always verified against the signature
  // before it is trusted, so a shape that would not survive the store is simply not emitted.
  function pathOf(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const tag = String(n.tagName || '').toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      const parent = n.parentElement;
      let step = tag;
      if (parent) {
        const same = [];
        for (let i = 0; i < parent.children.length; i++)
          if (String(parent.children[i].tagName || '').toLowerCase() === tag) same.push(parent.children[i]);
        if (same.length > 1) step += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      if (!PATH_STEP.test(step)) return '';   // a tag name the store would refuse — anchor by signature alone
      parts.unshift(step);
      n = parent;
    }
    const path = parts.join('>');
    return path.length > PATH_MAX ? '' : path;
  }

  // What this element could be pinned by, best first: its data-sc, then its id, then its position.
  // Every candidate carries the same path and signature, so whichever one is stored still has the two
  // fallbacks the browser resolves with. The last candidate has no `sel` at all — an element carrying
  // neither attribute is still reviewable, which most real posters depend on.
  function candidatesFor(el) {
    const sig = signature(textOf(el));
    const path = pathOf(el);
    const tag = String(el.tagName || '').toLowerCase();
    const out = [];
    const sc = el.getAttribute ? el.getAttribute('data-sc') : null;
    if (sc && NAME.test(sc)) out.push({ sel: '[data-sc=' + sc + ']', label: sc, path: path, sig: sig });
    const id = el.getAttribute ? el.getAttribute('id') : null;
    if (id && NAME.test(id)) out.push({ sel: '#' + id, label: id, path: path, sig: sig });
    out.push({ label: tag, path: path, sig: sig });
    return out;
  }

  // Every element whose own signature matches, deepest first. An ancestor with a single child reads the
  // same text as that child, so "deepest" is what picks the element a human pointed at rather than the
  // wrapper around it.
  function bySignature(doc, sig) {
    if (!sig) return null;
    const all = doc.querySelectorAll('body *');
    let best = null, bestDepth = -1;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (signature(textOf(el)) !== sig) continue;
      let depth = 0;
      for (let n = el; n; n = n.parentElement) depth++;
      if (depth > bestDepth) { best = el; bestDepth = depth; }
    }
    return best;
  }

  // The browser's resolution. THE ELEMENT IS THE REFERENT AND ITS TEXT IS ONLY EVIDENCE: a card dies
  // when its element is gone, never because someone edited what the element says. The order:
  //
  //   1. `sel` resolves.
  //   2. `path` resolves and its signature agrees.
  //   3. `path` resolves, the signature disagrees, and the stored signature is found NOWHERE ELSE.
  //      That is the same element with edited text: live, and the caller backfills the new signature.
  //   4. the stored signature is found elsewhere, so the element moved. Live there, path backfilled.
  //   5. nothing. Missing, which now means the element is gone.
  //
  // 3 is the fix for the incident that named this: a card asking "change this to Alex Smith" orphaned
  // itself the moment the change was made, because the stored signature was the OLD text. 4 is checked
  // before 3 (the code falls through to `stale` last) so a moved element keeps its card even though
  // something else now sits at its old path. That document-wide miss IS the nowhere-else guard.
  //
  // The `by` tells the caller how much of the stored anchor is still accurate: 'path-edited' and 'sig'
  // both mean the store is behind what the DOM says.
  function resolve(doc, element) {
    const el = element || {};
    const sel = selectorFor(el.sel);
    if (sel) { let hit = null; try { hit = doc.querySelector(sel); } catch (e) {} if (hit) return { el: hit, by: 'sel' }; }
    let stale = null;                  // the path resolved, but to text we did not store
    if (el.path) {
      let list = [];
      try { list = doc.querySelectorAll(el.path); } catch (e) {}
      for (let i = 0; i < list.length; i++) {
        if (!el.sig || signature(textOf(list[i])) === el.sig) return { el: list[i], by: 'path' };
        if (!stale) stale = list[i];
      }
    }
    const hit = bySignature(doc, el.sig);
    if (hit) return { el: hit, by: 'sig' };
    return stale ? { el: stale, by: 'path-edited' } : null;
  }

  // ---------- the layer stack: reaching what the paint order buries ----------

  // An element the picker will not take: the page frame itself, and its own injected style.
  function pickable(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'html' || tag === 'body' || tag === 'style' || tag === 'head') return null;
    return el;
  }

  // Everything under one point, front to back, deduped. Hover alone can only ever reach the TOP of the
  // paint stack, and a poster's top layer is often a full-bleed one: a scrim, a dot screen, a gradient
  // wash laid over the whole canvas. Alex could not comment on a poster's background image at all,
  // because the only place the scrims did not cover it was a gap. So the picker reads the whole stack
  // and Alt steps down it.
  //
  // `fallback` is the event target, and it carries the whole thing where elementsFromPoint is missing
  // or throws. jsdom has no layout, so under test the stack is whatever was clicked.
  function stackAt(doc, x, y, fallback) {
    let list = [];
    if (doc && doc.elementsFromPoint) { try { list = doc.elementsFromPoint(x, y) || []; } catch (e) { list = []; } }
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const el = pickable(list[i]);
      if (el && out.indexOf(el) < 0) out.push(el);
    }
    if (!out.length) { const el = pickable(fallback); if (el) out.push(el); }
    return out;
  }

  // Which member of the stack the outline sits on. It WRAPS, so a run of taps cycles instead of
  // sticking at the bottom layer, and a step left over from a deeper stack reads as the top instead of
  // pointing at nothing.
  function stepped(stack, step) {
    if (!stack || !stack.length) return null;
    const n = stack.length;
    return stack[(((step | 0) % n) + n) % n];
  }

  // Is the cursor still over the same layers? Element identity, member for member. A point whose stack
  // differs is a new thing to point at, so the step resets to the top there.
  function sameStack(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Where an element sits in the frame's own document. Document coordinates rather than viewport ones,
  // so a frame that does scroll reports the same numbers either way; the page adds the iframe's offset
  // and its scale.
  function rectOf(el, win) {
    const r = el.getBoundingClientRect();
    return { top: r.top + (win.pageYOffset || 0), left: r.left + (win.pageXOffset || 0),
      width: r.width, height: r.height };
  }

  // The natural canvas: what the asset wants to be, before the page scales it into the document column.
  function canvasSize(doc) {
    const de = doc.documentElement, b = doc.body || de;
    return { width: Math.max(de.scrollWidth, b.scrollWidth, de.offsetWidth),
      height: Math.max(de.scrollHeight, b.scrollHeight, de.offsetHeight) };
  }

  // ---------- the DOM half: cues, events, and the protocol ----------

  const STYLE = [
    /* The frame is one big picking surface, and the cursor is the only thing that says so before the
       first click. */
    'body { cursor: crosshair; }',
    /* Yellow is the agent's colour everywhere else in sidecar; here it marks what the click will take.
       outline rather than border: it paints outside the box and reflows nothing, so a poster laid out
       to the pixel does not shift under the pointer. */
    '.sc-hover { outline: 2px solid #ffeb00 !important; outline-offset: 1px; }',
    '.sc-anchored { outline: 1.5px dashed rgba(190,172,0,.95) !important; outline-offset: 2px; }',
    '.sc-lit { outline: 3px solid #ffeb00 !important; outline-offset: 2px; }',
    '@media (prefers-reduced-motion: no-preference) { .sc-flash { animation: sc-flash 1.2s ease-out; } }',
    '@keyframes sc-flash { 0%, 100% { box-shadow: none; } 25% { box-shadow: 0 0 0 8px rgba(255,235,0,.5); } }',
  ].join('\n');

  function boot(win) {
    win = win || root;
    const doc = win.document;
    let items = [];                 // [{ id, element }] — the review's element anchors, from `init`
    let resolved = {};              // id → element, refreshed on every render
    let hovered = null, lit = null;
    let stack = [], step = 0;       // the layers under the cursor, and how far down them Alt has walked

    // targetOrigin '*' in both directions, and it has to be: the frame's origin is opaque, so the page
    // cannot name it, and the frame cannot name the page's. What actually authenticates the channel is
    // the page checking `event.source === frame.contentWindow` on its side. Nothing here is a secret —
    // it is geometry and labels from a document the human is looking at.
    function send(name, body) {
      const msg = { type: 'sidecar:' + name };
      for (const k in body) msg[k] = body[k];
      try { win.parent.postMessage(msg, '*'); } catch (e) {}
    }

    const style = doc.createElement('style');
    style.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(style);

    function labelOf(el) {
      const sc = el.getAttribute && el.getAttribute('data-sc');
      if (sc && NAME.test(sc)) return sc;
      const id = el.getAttribute && el.getAttribute('id');
      if (id && NAME.test(id)) return id;
      return String(el.tagName || '').toLowerCase();
    }

    // Re-resolve every anchor, repaint the cues, and report both halves out. Runs on init and on every
    // reload, which is what keeps the rail's docking and its orphan display honest after an agent edit.
    function render() {
      for (const el of doc.querySelectorAll('.sc-anchored')) el.classList.remove('sc-anchored');
      resolved = {};
      const anchors = {};
      for (const it of items) {
        const hit = resolve(doc, it.element);
        anchors[it.id] = hit ? 'resolved' : 'missing';
        if (!hit) continue;
        resolved[it.id] = hit.el;
        hit.el.classList.add('sc-anchored');
        // The refreshed hint. An anchor written from a terminal knows only its `sel`, and one that just
        // re-resolved by signature has a path that has moved — both want the same write, so the page is
        // told whenever what we see differs from what is stored.
        const path = pathOf(hit.el), sig = signature(textOf(hit.el));
        const cur = it.element || {};
        if (path && (cur.path !== path || cur.sig !== sig)) send('backfill', { id: it.id, element: { path: path, sig: sig } });
      }
      send('anchors', { anchors: anchors });
      geometry();
    }

    function geometry() {
      const rects = {};
      for (const id in resolved) rects[id] = rectOf(resolved[id], win);
      send('geometry', { rects: rects });
    }

    function ready() { send('ready', canvasSize(doc)); }

    // The outline and the label, always on the same element, and the depth is part of what is reported:
    // "img · 2/5" is the only thing that tells the human there is anything under the layer they see.
    let said = '';
    function setHover(el) {
      if (hovered !== el) {
        if (hovered) hovered.classList.remove('sc-hover');
        hovered = el;
        if (hovered) hovered.classList.add('sc-hover');
      }
      const depth = hovered ? stack.indexOf(hovered) + 1 : 0;
      const body = { label: hovered ? labelOf(hovered) : null, depth: depth, count: hovered ? stack.length : 0 };
      const key = JSON.stringify(body);
      if (key === said) return;      // mousemove fires on every pixel; the page hears only real changes
      said = key;
      send('hover', body);
    }

    // The cursor moved: read the layers under it, and keep the step only while the layers are the same
    // ones. Both the outline and every pick run through here, so what a click takes is what the human
    // watched being outlined.
    function onPoint(e) {
      const next = stackAt(doc, e.clientX, e.clientY, e.target);
      if (!sameStack(next, stack)) { stack = next; step = 0; }
      setHover(stepped(stack, step));
    }

    // One layer deeper, wrapping at the bottom. Alt is a tap rather than a hold so it stays a cursor
    // key: the outline moves once per press and stays there while the human reads what it landed on.
    function stepDeeper() {
      if (stack.length < 2) return;
      step = (step + 1) % stack.length;
      setHover(stepped(stack, step));
    }

    function flash(el) {
      if (!el) return;
      el.classList.remove('sc-flash');
      void el.offsetWidth;              // restart the animation on a second click of the same quote
      el.classList.add('sc-flash');
      win.setTimeout(() => el.classList.remove('sc-flash'), 1400);
    }

    // Which item, if any, already owns this element — so a second click on a discussed element opens
    // the conversation instead of starting a parallel one about the same thing.
    //
    // THIS element, never an ancestor. Comment on a wrapper (a whole plate, a section) and every click
    // inside it would otherwise reopen that one card, leaving nothing in it commentable ever again. The
    // click target is the deepest element under the cursor and is what the hover outline already showed,
    // so exact identity is also the rule the human just watched being applied.
    function itemOn(el) {
      for (const id in resolved) if (resolved[id] === el) return id;
      return null;
    }

    // The page cannot see the pointer cross into this frame: under site isolation the frame is
    // another process and the embedding element's mouseenter never fires (real Chrome isolates
    // sandboxed frames; headless engines mostly do not, which is how this shipped). This document
    // sees every move, so it owns the fact and reports the crossings — the page's Alt forwarding
    // gates on them.
    let inside = false;
    function sayPointer(next) { if (next !== inside) { inside = next; send('pointer', { inside: next }); } }

    // mousemove as well as mouseover: an overlay that covers the canvas means the top element never
    // changes, so mouseover stops firing while the layers underneath the cursor change completely.
    doc.addEventListener('mousemove', (e) => { sayPointer(true); onPoint(e); }, true);
    doc.addEventListener('mouseover', (e) => { sayPointer(true); onPoint(e); }, true);
    doc.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { sayPointer(false); setHover(null); } }, true);
    win.addEventListener('blur', () => { sayPointer(false); setHover(null); });
    // Alt reaches here only while the FRAME has focus, which it does not until it is clicked. The page
    // forwards the same key as a `step` message whenever the pointer is over the frame (public/index.html),
    // so the first press works too. e.repeat is dropped: holding Alt would spin through the stack.
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Alt' && !e.repeat) { e.preventDefault(); stepDeeper(); }
    }, true);

    doc.addEventListener('click', (e) => {
      // Every click, unconditionally. A link inside the frame would otherwise navigate the frame itself
      // (which the sandbox permits) and replace the asset with whatever the URL resolves to.
      e.preventDefault();
      e.stopPropagation();
      // The OUTLINED element, never the raw event target: after a step those are two different things,
      // and the outline is the promise the human is acting on.
      onPoint(e);
      const el = hovered;
      if (!el) return;
      const id = itemOn(el);
      if (id) { flash(resolved[id]); return send('open', { id: id }); }
      const candidates = candidatesFor(el);
      send('pick', { candidates: candidates, label: candidates[0].label,
        text: snippet(textOf(el)), rect: rectOf(el, win) });
    }, true);
    doc.addEventListener('dragstart', (e) => e.preventDefault(), true);

    win.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || typeof m.type !== 'string' || m.type.indexOf('sidecar:') !== 0) return;
      const name = m.type.slice(8);
      if (name === 'init') { items = m.items || []; render(); }
      else if (name === 'step') stepDeeper();
      else if (name === 'pulse') flash(resolved[m.id]);
      else if (name === 'highlight') {
        if (lit) lit.classList.remove('sc-lit');
        lit = (m.id && resolved[m.id]) || null;
        if (lit) lit.classList.add('sc-lit');
      }
    });

    win.addEventListener('scroll', geometry);
    win.addEventListener('resize', () => { ready(); geometry(); });
    // A poster's height is not final until its images are: the first `ready` would size the frame to a
    // canvas with holes in it. Report again on load, and once more if the box keeps moving.
    win.addEventListener('load', () => { ready(); render(); });
    if (win.ResizeObserver) {
      let last = '';
      new win.ResizeObserver(() => {
        const s = JSON.stringify(canvasSize(doc));
        if (s === last) return;
        last = s;
        ready(); geometry();
      }).observe(doc.documentElement);
    }
    ready();
    return { render: render, geometry: geometry };
  }

  const API = { normalizeText, textOf, signature, snippet, synthQuote, selectorFor, pathOf, candidatesFor,
    bySignature, resolve, pickable, stackAt, stepped, sameStack, rectOf, canvasSize, boot, SIG_CHARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else {
    root.SidecarPicker = API;
    // Only inside a frame. The page fetches this file's SOURCE to inline into the srcdoc, and a stray
    // script tag pointing at /picker.js must not start listening to the page's own clicks.
    if (root.parent && root.parent !== root) API.boot(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
