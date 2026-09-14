/* sidecar — the three list rules a bare contenteditable does not have, shared by the browser (loaded
   via <script>, called from index.html's keydown handler) and the Node tests (require'd against a
   jsdom #doc). Enter on an empty item, Backspace at the start of an item, and Tab / Shift+Tab.

   Everything here takes ELEMENTS and returns one: the module never reads getSelection, never touches
   the save path, and never asks the document what the caret is doing. index.html does the selection
   reading, places the caret in whatever comes back, and marks the document dirty; the rules live
   here, where a test can run them against a #doc built exactly as renderDoc builds one.

   Each transform returns the element the caret should land in, or null when nothing happened (the
   first item of a list cannot indent, a top-level item cannot outdent). A null is the caller's signal
   that the document did not change, so nothing is marked dirty for a keystroke that did nothing. */
(function (root) {
  const isList = (el) => !!el && (el.nodeName === 'UL' || el.nodeName === 'OL');
  const parentList = (li) => (isList(li.parentElement) ? li.parentElement : null);
  const itemsOf = (list) => [...list.children].filter((c) => c.nodeName === 'LI');
  const subListsOf = (li) => [...li.children].filter(isList);

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

  // Is this item empty, ignoring the sublist it carries? An item with children but no text of its own
  // is still an empty item: Enter on it should lift it, and its children ride along. The zero-width
  // space is the caret escape an inline input rule leaves behind (see tryInlineRule), never content.
  function isEmptyItem(li) {
    let text = '';
    for (const n of li.childNodes) if (!isList(n)) text += n.textContent || '';
    return !text.replace(/[\s​]+/g, '').length;
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
    // box and the label goes with it, or the paragraph starts one character in.
    const boxes = [...li.querySelectorAll('input[type=checkbox]')];
    boxes.forEach((box) => box.remove());

    const p = doc.createElement('p');
    const kids = [...li.childNodes].filter((n) => n.nodeType !== 3 || n.textContent.trim());
    // A loose list renders <li><p>text</p></li>, and moving that <p> inside a fresh one would nest two.
    const from = kids.length === 1 && kids[0].nodeName === 'P' ? kids[0] : li;
    while (from.firstChild) p.appendChild(from.firstChild);
    if (boxes.length && p.firstChild && p.firstChild.nodeType === 3) {
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
        const start = Number(list.getAttribute('start') || 1) || 1;
        tail.setAttribute('start', String(start + i + 1));
      }
      tailItems.forEach((n) => tail.appendChild(n));
    }
    // The sublist and the tail now sit at the same depth, so one list of the same type holds both: two
    // adjacent lists in the DOM come back from turndown as one blank-line-separated list anyway, which
    // is a loose list the reader did not ask for and, when it is ordered, a renumbered one. The tail's
    // `start` walks back by however many items joined ahead of it so its own items keep their numbers,
    // and a start that would walk below 1 keeps the two lists apart instead.
    const promoted = subs.length === 1 && tail && subs[0].nodeName === tail.nodeName ? subs[0] : null;
    const joined = promoted ? itemsOf(promoted) : [];
    const tailStart = tail && tail.hasAttribute('start') ? Number(tail.getAttribute('start')) : 0;
    if (promoted && (!tailStart || tailStart - joined.length >= 1)) {
      if (tailStart) tail.setAttribute('start', String(tailStart - joined.length));
      joined.reverse().forEach((n) => tail.insertBefore(n, tail.firstChild));
      subs.length = 0;
    }
    let at = list;
    for (const node of [p, ...subs, ...(tail ? [tail] : [])]) { at.after(node); at = node; }
    if (!itemsOf(list).length) list.remove();   // the item was the only one, or the first
    return p;
  }

  const API = { itemAt, isEmptyItem, indent, outdent, lift };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.ListKeys = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
