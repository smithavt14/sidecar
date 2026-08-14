/* sidecar — how an .html ASSET becomes the srcdoc of a sandboxed iframe. Loaded by the browser and
   required by the Node tests, same as public/anchor.js, so the bytes that reach the frame are the bytes
   the suite asserts about.

   The guarantee this file exists to keep (docs/adr/0001-asset-frame-isolation.md): the asset's own
   scripts never run, and the only script in the frame is sidecar's picker. Two independent halves hold
   it up — the sanitize profile below strips every script, handler and javascript: URL out of the HTML,
   and the iframe carries `sandbox="allow-scripts"` with allow-same-origin ABSENT, so even a script that
   somehow survived would sit on an opaque origin with no reach into sidecar's file API. Neither half is
   allowed to be the only one.

   Assembly happens on the CLIENT rather than in the server, which is what keeps this dependency-free:
   the page already loads DOMPurify to render markdown, so an asset needs no parser, no template engine,
   and no new serving route. /api/state hands over the raw HTML in its `markdown` field (the name is
   kept because every client build reads it) and everything below is string in, string out. */
(function (root) {
  // A srcdoc without a doctype parses in QUIRKS MODE, where box-sizing, line-height and table layout
  // all shift — a poster reviewed in quirks mode is not the poster. DOMPurify drops the doctype it is
  // given, so it goes back on at the end rather than surviving the round trip.
  const DOCTYPE = '<!doctype html>';

  // The ASSET profile, distinct from the markdown one on purpose. Rendering fidelity is the whole point
  // of reviewing a poster, so `<style>` blocks and inline `style` attributes are KEPT here where the
  // markdown path has no need of them. Everything that executes or embeds another browsing context
  // goes. DOMPurify's defaults already drop all of it; the list is written out anyway because a silent
  // default is not a thing a test can point at, and because a later DOMPurify may widen its defaults.
  const FORBID_TAGS = ['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'noscript'];
  const FORBID_ATTR = ['srcdoc', 'sandbox', 'formaction', 'ping'];
  const PROFILE = {
    WHOLE_DOCUMENT: true,   // keep <head>, which is where an asset's <style> usually lives
    RETURN_DOM: true,       // rewriting runs over the parsed tree; re-parsing the string would be a second parser
    FORBID_TAGS,
    FORBID_ATTR,
  };

  // Anything with a scheme, a protocol-relative prefix, an absolute path, or a bare fragment is left
  // exactly as written. Same rule the markdown path's rewriteAssetSrc uses, and the same one `/assets`
  // enforces from its own side ("relative image paths only"), so the two cannot drift into disagreeing
  // about what a document-relative reference is.
  const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;
  function isRelative(u) {
    const s = String(u == null ? '' : u).trim();
    return !!s && !EXTERNAL.test(s);
  }

  // The one form the server resolves: both halves handed over, confinement checked there (safePath),
  // never re-derived here where it would drift.
  function assetUrl(docRel, src) {
    return '/assets?doc=' + encodeURIComponent(docRel) + '&src=' + encodeURIComponent(String(src).trim());
  }
  function rewriteRef(docRel, u) { return isRelative(u) ? assetUrl(docRel, u) : u; }

  // `url(…)` inside CSS, in every form the syntax allows: double-quoted, single-quoted, bare. This is
  // half the references in a real poster — a background image, a mask, an @font-face src — and missing
  // them renders the asset with its type and its texture gone while the <img> tags all resolve.
  const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;
  function rewriteCss(css, docRel) {
    return String(css == null ? '' : css).replace(CSS_URL, (whole, dq, sq, bare) => {
      const raw = dq !== undefined ? dq : sq !== undefined ? sq : bare;
      return isRelative(raw) ? 'url("' + assetUrl(docRel, raw) + '")' : whole;
    });
  }

  // `a.png 1x, b.png 2x` — each candidate is a URL plus an optional descriptor.
  function rewriteSrcset(value, docRel) {
    return String(value == null ? '' : value).split(',').map((part) => {
      const m = part.match(/^(\s*)(\S+)(\s.*)?$/);
      if (!m) return part;
      return m[1] + rewriteRef(docRel, m[2]) + (m[3] || '');
    }).join(',');
  }

  // `src` on the elements that FETCH one. Deliberately not a blanket "every src attribute": the point
  // is media, and the tags that could load a document are stripped by the profile above anyway.
  const SRC_TAGS = new Set(['IMG', 'SOURCE', 'VIDEO', 'AUDIO', 'TRACK', 'INPUT']);
  // `href` on the elements where it is a SUBRESOURCE rather than a destination. An <a href> is left
  // alone: rewriting it would point every link in the poster at an /assets route that refuses it, and
  // the sandbox already stops a click from going anywhere.
  const HREF_TAGS = new Set(['LINK', 'IMAGE', 'USE']);

  function rewriteRefs(rootEl, docRel) {
    const all = [rootEl].concat(Array.prototype.slice.call(rootEl.querySelectorAll('*')));
    for (const el of all) {
      const tag = String(el.tagName || '').toUpperCase();
      if (!el.getAttribute) continue;
      if (SRC_TAGS.has(tag) && el.hasAttribute('src')) el.setAttribute('src', rewriteRef(docRel, el.getAttribute('src')));
      if (HREF_TAGS.has(tag) && el.hasAttribute('href')) el.setAttribute('href', rewriteRef(docRel, el.getAttribute('href')));
      if (tag === 'VIDEO' && el.hasAttribute('poster')) el.setAttribute('poster', rewriteRef(docRel, el.getAttribute('poster')));
      if (el.hasAttribute('srcset')) el.setAttribute('srcset', rewriteSrcset(el.getAttribute('srcset'), docRel));
      if (el.hasAttribute('style')) el.setAttribute('style', rewriteCss(el.getAttribute('style'), docRel));
      if (tag === 'STYLE') el.textContent = rewriteCss(el.textContent, docRel);
    }
    return rootEl;
  }

  // The whole pipeline: raw HTML in, the frame's srcdoc out.
  //   html    the asset's bytes, as /api/state returns them
  //   docRel  the document's path, for the /assets references
  //   purify  a DOMPurify instance (the page's global; the tests build one over jsdom)
  //   picker  public/picker.js's source, inlined
  // The picker is INLINED rather than pulled in with a <script src>. The frame is an opaque origin, so
  // a subresource fetch from inside it is a cross-origin request that has to succeed before anything in
  // the frame works at all — a moving part with nothing to gain, on the one script the isolation
  // guarantee names.
  function buildFrame(opts) {
    const o = opts || {};
    const picker = o.picker == null ? '' : String(o.picker);
    // Script content serializes RAW, so a picker that contained this sequence would close its own tag
    // and spill the rest into the document as markup. It never has; this is here so it cannot start.
    if (/<\/script/i.test(picker)) throw new Error('picker source contains </script — it cannot be inlined');
    const rootEl = o.purify.sanitize(String(o.html == null ? '' : o.html), PROFILE);
    rewriteRefs(rootEl, o.docRel);
    if (picker) {
      const doc = rootEl.ownerDocument;
      const el = doc.createElement('script');
      el.textContent = picker;
      (rootEl.querySelector('body') || rootEl).appendChild(el);
    }
    return DOCTYPE + rootEl.outerHTML;
  }

  const API = { DOCTYPE, PROFILE, FORBID_TAGS, FORBID_ATTR, isRelative, assetUrl, rewriteRef,
    rewriteCss, rewriteSrcset, rewriteRefs, buildFrame };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.AssetFrame = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
