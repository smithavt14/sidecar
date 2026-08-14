/* sidecar — the element anchor: how a review item pins to an element inside an ASSET (an .html file
   reviewed as a rendered visual rather than as text), and how NODE decides whether that pin is still
   live.

   Two authorities resolve one of these and they see different things. The browser has a real DOM: it
   runs `sel`, then the structural `path` verified against `sig`, then a document-wide search for `sig`
   alone (that half lives in public/picker.js). Node has a string and no DOM, so liveness here is
   textual: the attribute is still written in the file, or the signature text still reads out of it
   once tags are stripped. The signature goes through the shared matcher in public/anchor.js, so a
   quote and a signature normalize identically and neither side can drift from the other.

   Everything below is regex over raw HTML — no parser, no dependency, matching how the rest of the
   tool works. That is a real limit rather than a shortcut waiting to be fixed, and `extract` says
   exactly where it bites. */
const Anchor = require('../public/anchor.js');   // the ONE shared matcher; the signature goes through it

// An id or a data-sc value is echoed back into the DOM by the picker and into a CSS selector by the
// frame, so the same rule the review file already applies to item ids applies here: word characters
// and hyphens, nothing else. Anything richer is refused at write time rather than escaped later.
const VALUE = /^[\w-]+$/;

// A reference an agent types, in any of the three forms a human would reach for, normalized to the one
// `sel` that gets stored. `headline` and `[data-sc=headline]` are the same element; `#headline` is the
// id form and stays distinct, because an id and a data-sc value that happen to read alike are two
// different attributes and conflating them would report a dead anchor as live.
// Returns { attr, label, sel } or { error }.
function parseRef(ref) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return { error: 'empty element reference' };
  let attr, label;
  const m = s.match(/^\[\s*data-sc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))\]$/);
  if (m) { attr = 'data-sc'; label = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim(); }
  else if (s[0] === '#') { attr = 'id'; label = s.slice(1); }
  else if (s[0] === '[') return { error: `element reference "${s}" is not one sidecar stores — use a data-sc value, #id, or [data-sc=…]` };
  else { attr = 'data-sc'; label = s; }
  if (!VALUE.test(label))
    return { error: `element reference "${s}" is not a plain name — an id or data-sc value must match [A-Za-z0-9_-]+` };
  return { attr, label, sel: attr === 'id' ? `#${label}` : `[data-sc=${label}]` };
}

// Is this a `sel` the store may hold? The same check both write paths run (the CLI before applyItems,
// the server on PUT /api/review), for the same reason the id check exists there.
function validSel(sel) { return !parseRef(sel === undefined ? '' : sel).error; }

// The structural path, the third thing the picker can pin to. An element carrying neither a data-sc
// nor an id has no `sel` at all, and refusing to anchor one would mean most real posters offer nothing
// to comment on — so an anchor may hold `path` + `sig` instead, which is what CONTEXT.md's element
// anchor already describes ("else by structural path checked against a text-content signature").
//
// A path is fed to querySelector INSIDE the frame, so it gets the same treatment as a sel: a shape the
// picker actually produces (a `tag` or `tag:nth-of-type(n)` chain joined by `>`), refused at write time
// rather than escaped later. The cap is there because the value is also echoed onto the card.
const PATH_STEP = /^[a-zA-Z][\w-]*(?::nth-of-type\(\d+\))?$/;
function validPath(path) {
  const s = String(path == null ? '' : path).trim();
  if (!s || s.length > 300) return false;
  return s.split('>').every((step) => PATH_STEP.test(step.trim()));
}

// What to print for an element anchor that may have either half. `check` and the CLI's listings read
// this rather than `sel` directly, or a path-only anchor prints "undefined".
function describe(element) {
  const el = element || {};
  return el.sel || el.path || '(no reference)';
}

// The attribute as it is actually written in the file. Quoted forms are what the picker and `elements`
// report; the unquoted form is matched too (valid HTML, and a false orphan is worse than a slightly
// wider regex), bounded so `id=head` cannot match `id=headline`. `label` is VALUE-checked, so it needs
// no escaping.
function attrRe(attr, label) {
  return new RegExp(`(?:^|[^\\w-])${attr}\\s*=\\s*(?:"${label}"|'${label}'|${label}(?=[\\s/>]))`);
}

// Tags out, text left, whitespace collapsed. Deliberately dumb: `<[^>]*>` also eats an attribute value
// containing `>` and leaves the text of <script>/<style> behind. Both make the haystack bigger, never
// smaller, so the failure they can produce is a signature that matches when the element is gone — the
// same direction as a duplicated quote, and visible to the human on the card.
function stripTags(raw) { return String(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

// Is this anchor still in the file? Attribute first (cheap, exact, and the thing the agent named),
// signature second (survives a renamed attribute on unchanged content). Either is enough: an element
// anchor dies only when both are gone, which is what makes a re-labelled element orphan instead of
// silently re-pinning to something else.
function isLive(raw, element) {
  const el = element || {};
  const p = parseRef(el.sel === undefined ? '' : el.sel);
  if (!p.error && attrRe(p.attr, p.label).test(String(raw))) return true;
  if (el.sig) return Anchor.findAll(stripTags(raw), el.sig).length > 0;
  // A structural path is the BROWSER's authority and there is no DOM here to run it against. An element
  // with no text has no signature either, which is most of a poster: a picture, a rule, an empty plate.
  // Node abstains rather than calling those dead — "the element is gone" on every comment ever left on
  // a picture would be a false orphan on the one document kind that is mostly pictures. The frame knows
  // the truth and reports it (its `anchors` message), to the human who is looking at the render.
  if (el.path) return true;
  return false;
}

// Void elements hold no text, so there is nothing to read forward to and no closing tag to look for.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
                      'param', 'source', 'track', 'wbr']);

// The bytes between an open tag ending at `from` and its matching close, counting nested opens of the
// same tag name. Null when the tag never closes, which is the case the caller has to decide about.
function contentOf(text, from, tag) {
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(text))) {
    if (m[0][1] === '/') { if (!--depth) return text.slice(from, m.index); }
    else depth++;
  }
  return null;
}

// Every anchorable element in the file: the ones carrying data-sc or id, in document order, each with
// its tag and a snippet of its text.
//
// The honest limits, all of them from having no parser:
//   - a tag that never closes has no end to read to, so its snippet falls back to a forward window and
//     picks up whatever text follows, its own or not.
//   - a data-sc or id written inside an HTML comment, or in a string in a <script>, is listed like any
//     other element. Nothing here knows what a comment is.
//   - two elements sharing a label are both listed. The collision is real and hiding one would make
//     `elements` disagree with the file.
// data-sc wins over id on the same element, matching the picker's candidate order.
const OPEN_TAG = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR = (attr) => new RegExp(`(?:^|[^\\w-])${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([\\w-]+))`);
const SC_ATTR = ATTR('data-sc'), ID_ATTR = ATTR('id');
const attrValue = (m) => (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);

function extract(raw, snippetChars = 80) {
  const text = String(raw), out = [];
  OPEN_TAG.lastIndex = 0;
  let m;
  while ((m = OPEN_TAG.exec(text))) {
    const [whole, tag, attrs] = m;
    const sc = attrs.match(SC_ATTR), id = attrs.match(ID_ATTR);
    if (!sc && !id) continue;
    const ref = sc ? `[data-sc=${attrValue(sc)}]` : `#${attrValue(id)}`;
    const p = parseRef(ref);
    if (p.error) continue;   // a value the anchor could not store is not an anchorable element
    const name = tag.toLowerCase(), from = m.index + whole.length;
    const closed = VOID.has(name) ? '' : contentOf(text, from, name);
    const inner = closed === null ? text.slice(from) : closed;
    out.push({ sel: p.sel, label: p.label, attr: p.attr, tag: name, text: snippet(inner, snippetChars) });
  }
  return out;
}

function snippet(after, n = 80) {
  const t = stripTags(after);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// The `quote` an element item stores. Every surface sidecar already has — cards, digest lines, `show` —
// reads `anchor.quote`, so an element anchor synthesizes one rather than teaching each of them a second
// field. Label alone when the text is not known yet, which is the terminal-bound case.
function synthQuote(label, text) {
  const t = (text || '').trim();
  return t ? `${label} · ${t}` : String(label);
}

module.exports = { parseRef, validSel, validPath, describe, isLive, extract, snippet, stripTags,
  synthQuote, VALUE };
