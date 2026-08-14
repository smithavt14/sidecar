// Images attached to a review — the one place that decides where they live and what counts as one.
//
// They go in `<doc>.sidecar.assets/` next to `<doc>.sidecar.json`, so a review's pictures travel with
// its comments: same directory, same git commit, same `rm` when you're done with the document. The
// reference stored in a comment body is ordinary markdown (`![](doc.md.sidecar.assets/ab12….png)`)
// relative to the DOCUMENT — which is exactly what the `/assets` route already resolves for images
// in the document itself. That is why a comment image needs no new serving path and no schema field:
// an attachment is a comment that happens to contain an image link.
//
// Names are content hashes, so pasting the same screenshot into three comments writes one file, and
// re-running an agent command is idempotent instead of littering.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Kept here rather than in server.js so the upload path and the serving path can never disagree
// about what an image is — one of them accepting a format the other refuses is a broken <img> with
// no error anywhere.
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

// Fonts are served but never uploaded: an asset's own `@font-face { src: url(./x.woff2) }` is rewritten
// through the same `/assets` route its images go through, and a poster reviewed in the wrong typeface is
// not the poster. Kept apart from IMAGE_TYPES so an ATTACHMENT still means an image — the upload path
// sniffs bytes and has no font branch, and widening the one map would have quietly changed what a
// comment may carry.
const FONT_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

// Everything the `/assets` route will hand back. One map so the route cannot disagree with itself about
// what an extension means.
const SERVED_TYPES = { ...IMAGE_TYPES, ...FONT_TYPES };

// A screenshot of a 6K display in PNG lands around 10 MB, so the cap has to clear that with room;
// past this it is a video or a mistake.
const MAX_BYTES = 20 * 1024 * 1024;

function assetsDir(docAbs) { return docAbs + '.sidecar.assets'; }

// The extension is decided by the BYTES, never by the filename or the browser's Content-Type. Not a
// security control — the `/assets` route pins the served type by extension and sends nosniff, so a
// mislabelled file can't execute — but it turns "silently broken image" into a refusal with a reason.
function sniffExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('latin1', 0, 3) === 'GIF') return '.gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  // AVIF/HEIF: an ISO-BMFF `ftyp` box whose brand starts with "avi".
  if (buf.toString('latin1', 4, 8) === 'ftyp' && buf.toString('latin1', 8, 11) === 'avi') return '.avif';
  // SVG is text, so it has no magic number — look for the root element past any XML prolog or comment.
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).trim();
  if (/^(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[\s\S]*?>\s*)?<svg[\s>]/i.test(head)) return '.svg';
  return null;
}

// Write bytes into the document's asset dir and return how a comment should reference them.
// `rel` is relative to the document's directory — the form `/assets?doc=…&src=…` expects.
function saveAsset(docAbs, buf) {
  if (!buf || !buf.length) throw new Error('empty image');
  if (buf.length > MAX_BYTES) throw new Error(`image is ${(buf.length / 1048576).toFixed(1)}MB — the cap is ${MAX_BYTES / 1048576}MB`);
  const ext = sniffExt(buf);
  if (!ext) throw new Error('not an image (png, jpg, gif, webp, avif, svg)');
  const dir = assetsDir(docAbs);
  const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12) + ext;
  const abs = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  // Content-addressed, so an existing file with this name already holds these exact bytes. Skipping
  // the write keeps a re-paste from touching mtime and waking the fs-watcher for nothing.
  if (!fs.existsSync(abs)) {
    const tmp = abs + '.tmp';   // atomic, same as the sidecar write: never serve a half-written PNG
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, abs);
  }
  return { name, abs, rel: path.basename(dir) + '/' + name };
}

module.exports = { IMAGE_TYPES, FONT_TYPES, SERVED_TYPES, MAX_BYTES, assetsDir, sniffExt, saveAsset };
