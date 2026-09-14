/* sidecar — the three list rules a bare contenteditable does not have, shared by the browser (loaded
   via <script>, called from index.html's keydown handler) and the Node tests (require'd against a
   jsdom #doc). Enter on an empty item, Backspace at the start of an item, and Tab / Shift+Tab.

   Everything here takes ELEMENTS and returns one: the module never reads getSelection, never touches
   the save path, and never asks the document what the caret is doing. index.html does the selection
   reading, places the caret in whatever comes back, and marks the document dirty; the rules live
   here, where a test can run them against a #doc built exactly as renderDoc builds one.

   Each transform returns the element the caret should land in, or null when nothing happened (the
   first item of a list cannot indent, a top-level item cannot outdent). A null is the caller's signal
   that the document did not change, so nothing is marked dirty for a keystroke that did nothing.

   The caret arithmetic is here for the same reason: ownOffset reads a selection anchor into an offset
   over the item's own text and caretTarget reads that offset back into a node the caller ranges to, so
   the two ends of a Tab measure one thing and a jsdom test can run both. */
(function (root) {
  const isList = (el) => !!el && (el.nodeName === 'UL' || el.nodeName === 'OL');
  const parentList = (li) => (isList(li.parentElement) ? li.parentElement : null);
  const itemsOf = (list) => [...list.children].filter((c) => c.nodeName === 'LI');
  const subListsOf = (li) => [...li.children].filter(isList);

  // The first number an ordered list carries. `start` is absent on a list beginning at 1, and
  // CommonMark lets one begin at 0, so a 0 has to survive: the attribute is read before it is
  // converted, since Number('') is 0 and would turn a missing start into a zero-based list. Anything
  // that is not a whole number at or above 0 reads as 1.
  function startOf(list) {
    if (!list || list.nodeName !== 'OL') return 1;
    const raw = (list.getAttribute('start') || '').trim();
    if (!raw) return 1;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : 1;
  }

  // The item's first content node, skipping the whitespace marked pretty-prints between tags.
  const firstNode = (el) => {
    for (const n of el.childNodes) { if (n.nodeType === 3 && !n.textContent.trim()) continue; return n; }
    return null;
  };

  // The checkbox the marker `- [ ] ` renders, or null. It is the item's first node, or the first node
  // of the item's <p> in a loose list; a checkbox anywhere else in the item is prose the author wrote.
  function markerBox(li) {
    const lead = firstNode(li);
    const head = firstNode(lead && lead.nodeName === 'P' ? lead : li);
    if (!head || head.nodeName !== 'INPUT') return null;
    return (head.getAttribute('type') || '').toLowerCase() === 'checkbox' ? head : null;
  }

  // The <li> holding a node, or null. An atomic block (a rendered ```flow diagram, a raw-HTML island)
  // carries its own source markdown and is not editable, so a list drawn inside one is a picture of a
  // list: the keys must fall through to the browser there, same as every other input rule.
  function itemAt(node, docEl) {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || (docEl && !docEl.contains(el))) return null;
    const li = el.closest('li');
    if (!li) return null;
    const block = li.closest('.block');
    if (block && block.dataset && block.dataset.atomic) return null;
    return li;
  }

  // Content an item can hold that carries no text. An item whose whole body is an image reads as empty
  // to a text test, and Enter would lift the picture out of the list the author put it in.
  const MEDIA = ['IMG', 'SVG', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED'];

  // Every element under the item that belongs to the item: a nested list is the item below, not this
  // one. SVG keeps its authored case in the DOM, so the name is normalized before it is compared.
  function ownElements(li) {
    const out = [];
    (function walk(parent) {
      for (const n of parent.children) { if (isList(n)) continue; out.push(n); walk(n); }
    })(li);
    return out;
  }

  // The item's own text nodes, in document order. Both halves of the caret arithmetic below read this
  // one list, so an offset measured over an item means the same thing when it is placed back.
  function ownTexts(li) {
    const out = [];
    (function walk(parent) {
      for (const n of parent.childNodes) {
        if (isList(n)) continue;
        if (n.nodeType === 3) out.push(n); else if (n.nodeType === 1) walk(n);
      }
    })(li);
    return out;
  }

  // Is this item empty, ignoring the sublist it carries? An item with children but no text of its own
  // is still an empty item: Enter on it should lift it, and its children ride along. The zero-width
  // space is the caret escape an inline input rule leaves behind (see tryInlineRule), never content.
  // An image, a diagram or a video is content the reader can see and keeps the item non-empty.
  function isEmptyItem(li) {
    let text = '';
    for (const n of li.childNodes) if (!isList(n)) text += n.textContent || '';
    if (text.replace(/[\s​]+/g, '').length) return false;
    return !ownElements(li).some((el) => MEDIA.includes(el.nodeName.toUpperCase()));
  }

  // Where the caret sits inside an item, counted over the item's OWN text. `node`/`offset` is a
  // selection anchor as the browser gives it: a text node and a character offset into it, or an
  // element and the index of the child the caret sits in front of. A range measured against the whole
  // item counts the text of every nested item too, which is a different number from the one
  // caretTarget places back, and Tab on an item with a sublist then moves the caret.
  function ownOffset(li, node, offset) {
    let acc = 0, done = false;
    const clamp = (n, hi) => Math.min(Math.max(n | 0, 0), hi);
    (function visit(n, own) {
      if (done) return;
      if (n.nodeType === 3) {
        if (n === node) { if (own) acc += clamp(offset, n.length); done = true; return; }
        if (own) acc += n.length;
        return;
      }
      if (n.nodeType !== 1) return;
      const kids = [...n.childNodes];
      const stop = n === node ? clamp(offset, kids.length) : kids.length;
      for (let i = 0; i < stop && !done; i++) visit(kids[i], own && !isList(n));
      if (n === node) done = true;
    })(li, true);
    return acc;
  }

  // The inverse: the text node and offset an own-text offset names, for the caller to build a range
  // from. An item with no own text is seeded with the zero-width space the inline rules already use as
  // a caret host, because a range in front of a sublist is normalized into the sublist's first item by
  // every engine and the next letter typed would edit the child. isEmptyItem reads through the space
  // and toMd strips it before anything is saved.
  function caretTarget(li, off) {
    const texts = ownTexts(li);
    let acc = 0;
    for (const t of texts) {
      if (acc + t.length >= off) return { node: t, offset: Math.max(0, off - acc) };
      acc += t.length;
    }
    let last = texts[texts.length - 1];
    if (!last) {
      last = li.ownerDocument.createTextNode('​');
      li.insertBefore(last, li.firstChild);
    }
    return { node: last, offset: last.length };
  }

  // Is the caret at the start of the item, given the text the caller measured in front of it? Nothing
  // in front is the start. Whitespace in front is the start for one shape only: `- [ ] todo` renders
  // as a checkbox and the text node " todo", so the caret where the reader sees the start of the line
  // has the marker's separator space behind it. A space anywhere else, inside a code span or opening a
  // line the author indented, is content, and Backspace on it deletes a character.
  function atItemStart(li, before) {
    const text = before || '';
    if (!text.length) return true;
    return !text.trim().length && !!markerBox(li);
  }

  // Tab: the item becomes a child of the item above it. The first item of a list has nothing to nest
  // under and returns null. An existing trailing sublist on the previous item is reused whatever its
  // type, since that is the list the reader can see; only a previous item with no sublist at all gets
  // a fresh one, and it takes the type of the list being indented out of.
  function indent(li) {
    const list = parentList(li);
    if (!list) return null;
    const prev = li.previousElementSibling;
    if (!prev || prev.nodeName !== 'LI') return null;
    const subs = subListsOf(prev);
    let host = subs[subs.length - 1];
    if (!host) {
      host = li.ownerDocument.createElement(list.nodeName.toLowerCase());
      prev.appendChild(host);
    }
    host.appendChild(li);   // the item's own sublist is a child of it, so it travels along
    return li;
  }

  // Shift+Tab: the item moves up one level and lands after the item it was nested under. Its FOLLOWING
  // siblings become its children, which is ProseMirror's liftListItem semantics and the only reading
  // that keeps the order on the page: c and d sat below b, and b has just moved above them.
  function outdent(li) {
    const list = parentList(li);
    if (!list) return null;
    const host = list.parentElement;
    if (!host || host.nodeName !== 'LI') return null;   // already at the top level
    const after = [];
    for (let n = li.nextElementSibling; n; n = n.nextElementSibling) if (n.nodeName === 'LI') after.push(n);
    if (after.length) {
      const subs = subListsOf(li);
      let sink = subs[subs.length - 1];
      // The item's own children and the siblings following it end up at the same depth, so they belong
      // in one list. A type mismatch gets its own, rather than bullets quietly turning into numbers.
      if (!sink || sink.nodeName !== list.nodeName) {
        sink = li.ownerDocument.createElement(list.nodeName.toLowerCase());
        li.appendChild(sink);
      }
      after.forEach((n) => sink.appendChild(n));
    }
    host.after(li);
    if (!itemsOf(list).length) list.remove();
    return li;
  }

  // The item stops being an item. A nested one outdents, which is what Enter on an empty nested item
  // and Backspace at the start of one both mean: one level at a time, and the list is left standing.
  // A top-level one becomes a paragraph after the list, and a list it was in the middle of splits in
  // two so the paragraph lands where the item was rather than at the end.
  function lift(li) {
    const list = parentList(li);
    if (!list) return null;
    if (list.parentElement && list.parentElement.nodeName === 'LI') return outdent(li);
    const doc = li.ownerDocument;

    // The item's sublist comes out with it and lands one level shallower, either joining the split's
    // tail below or standing as a list of its own. Dropping it would lose text the reader can see.
    const subs = subListsOf(li);
    subs.forEach((s) => s.remove());
    // A task list's checkbox is markup the marker `- [ ] ` carries. A paragraph has no marker, so the
    // box would serialize to a literal `[ ]` sitting in the prose. The space marked left between the
    // box and the label goes with it, or the paragraph starts one character in. Only that one box
    // goes: a checkbox the author wrote into the item's prose is content and survives the lift.
    const box = markerBox(li);
    if (box) box.remove();

    const p = doc.createElement('p');
    const kids = [...li.childNodes].filter((n) => n.nodeType !== 3 || n.textContent.trim());
    // A loose list renders <li><p>text</p></li>, and moving that <p> inside a fresh one would nest two.
    const from = kids.length === 1 && kids[0].nodeName === 'P' ? kids[0] : li;
    while (from.firstChild) p.appendChild(from.firstChild);
    if (box && p.firstChild && p.firstChild.nodeType === 3) {
      p.firstChild.textContent = p.firstChild.textContent.replace(/^\s+/, '');
    }

    const items = itemsOf(list);
    const i = items.indexOf(li);
    const tailItems = items.slice(i + 1);
    li.remove();
    let tail = null;
    if (tailItems.length) {
      tail = doc.createElement(list.nodeName.toLowerCase());
      if (list.nodeName === 'OL') {
        // The tail has to keep counting from where the head stopped, or `1. a / 2. b / 3. c` comes back
        // from turndown as `1. a` and `1. c` and the document has been renumbered by a keystroke.
        tail.setAttribute('start', String(startOf(list) + i + 1));
      }
      tailItems.forEach((n) => tail.appendChild(n));
    }
    // The sublist and the tail now sit at the same depth, so one list of the same type holds both: two
    // adjacent lists in the DOM come back from turndown as one blank-line-separated list anyway, which
    // is a loose list the reader did not ask for and, when it is ordered, a renumbered one. Two ordered
    // lists join only when the numbering runs straight through them: the sublist's own first number
    // plus its item count has to be the tail's first number. `1. a / 5. b / 2. c` lifted at a would
    // make b the 1 it never was, so a pair like that stays apart and each list keeps its own start.
    const promoted = subs.length === 1 && tail && subs[0].nodeName === tail.nodeName ? subs[0] : null;
    const joined = promoted ? itemsOf(promoted) : [];
    const contiguous = promoted &&
      (tail.nodeName !== 'OL' || startOf(promoted) + joined.length === startOf(tail));
    if (contiguous) {
      if (tail.nodeName === 'OL') tail.setAttribute('start', String(startOf(promoted)));
      joined.reverse().forEach((n) => tail.insertBefore(n, tail.firstChild));
      subs.length = 0;
    }
    let at = list;
    for (const node of [p, ...subs, ...(tail ? [tail] : [])]) { at.after(node); at = node; }
    if (!itemsOf(list).length) list.remove();   // the item was the only one, or the first
    return p;
  }

  const API = { itemAt, isEmptyItem, atItemStart, ownOffset, caretTarget, indent, outdent, lift };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.ListKeys = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
