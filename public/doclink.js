/* sidecar — should a link inside a document open IN sidecar, and if so, which document?

   Loaded by the browser (<script>, called from index.html's click handlers and its render) and
   require'd by the Node test suite, same as public/navsort.js. Pure: a string and the open document's
   path in, a decision out. No DOM, no fetch, no dependency, so the rule the page applies to a click is
   the rule a test can assert on directly.

   `route(href, fromRel)` answers null for "leave this link alone" and `{ rel, hash }` for "this is
   another document in this root, open it". Everything the page then does — pushState, the panel
   following, the scroll restore — hangs off that one answer.

   The SERVED ROOT is in here implicitly and deliberately. Every path sidecar handles is relative to
   the root, so a link that walks up past the top of `fromRel` has walked out of the root, and the
   normalizer below refuses it by running out of segments to pop. Nothing here re-derives the absolute
   root path: the server's safePath owns that check, and a second copy of it would drift. */
(function (root) {
  // The two allowlists from lib/cli.js, which cannot be require'd from a browser. A test pins these
  // against the real ones — a document the CLI reviews and this file does not know about is a link
  // that silently reloads the page instead of switching in place.
  const MARKDOWN = ['.md', '.markdown', '.mdown', '.mkd', '.mdx'];
  const ASSETS = ['.html', '.htm'];

  // A scheme (http:, mailto:, javascript:, data:), a protocol-relative host, an absolute path, or a
  // bare fragment. Same shape as assetframe.js's EXTERNAL and the /assets route's own guard, and for
  // the same reason: all three have to agree on what a document-relative reference is.
  //
  // An absolute path is left native on purpose. `/…` is a URL on this origin, not a path in the
  // served root, and sidecar's own links of that form (`/?f=…`) are the panel's, not a document's.
  const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

  const dirOf = (rel) => { const i = String(rel || '').lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };

  function isDoc(name) {
    const s = String(name || '').toLowerCase();
    const i = s.lastIndexOf('.');
    if (i <= 0) return false;                 // no extension, or a dotfile with nothing before the dot
    const ext = s.slice(i);
    return MARKDOWN.indexOf(ext) >= 0 || ASSETS.indexOf(ext) >= 0;
  }

  // `.` and `..` resolved against the open document's folder. Returns null when the path climbs above
  // the served root, which is the one confinement rule this file carries: `../..` from `a/b.md` is
  // outside everything sidecar serves, and following it would ask the server for a document it will
  // refuse anyway.
  function normalize(dir, rel) {
    const out = dir ? String(dir).split('/').filter(Boolean) : [];
    for (const seg of String(rel).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
      out.push(seg);
    }
    return out.join('/');
  }

  function route(href, fromRel) {
    let s = String(href == null ? '' : href).trim();
    if (!s || EXTERNAL.test(s)) return null;
    // A query string is not part of any path in the served root, so a link carrying one is asking for
    // something other than a document and keeps whatever behaviour it has today.
    if (s.indexOf('?') >= 0) return null;
    let hash = '';
    const h = s.indexOf('#');
    if (h >= 0) { hash = s.slice(h + 1); s = s.slice(0, h); }
    if (!s) return null;                      // the fragment was the whole link: an anchor in this document
    // A written link is percent-encoded, a path on disk is not: `market%20research.md` and
    // `market research.md` are the same file and only one of them is what /api/state takes.
    try { s = decodeURIComponent(s); } catch (e) { return null; }
    const rel = normalize(dirOf(fromRel), s);
    if (!rel || !isDoc(rel.split('/').pop())) return null;
    return { rel: rel, hash: hash };
  }

  const api = { MARKDOWN, ASSETS, EXTERNAL, dirOf, isDoc, normalize, route };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DocLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
