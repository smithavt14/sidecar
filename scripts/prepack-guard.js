#!/usr/bin/env node
// Refuse to pack when a stray README*/LICENSE*/CHANGELOG* file is sitting in the repo root.
//
// npm ALWAYS includes anything matching those globs, and neither the `files` allowlist nor an
// .npmignore can override it — both were tried and both silently lost. That is not a theoretical
// hazard: 1.3.0 shipped `README.md.review.json` and `README.md.review.seen.json` to the public
// registry, which is sidecar's own review state for its own README — an editorial conversation
// nobody meant to publish. They matched `README*`, so they rode along.
//
// The only reliable fix is for the file not to exist at pack time, so this fails the pack instead
// of shipping it. .gitignore keeps them untracked; this keeps them unpublished.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORCED = /^(readme|license|licence|changelog|notice)/i;
const KEEP = new Set(['README.md', 'LICENSE']);   // the real ones, which SHOULD ship

const strays = fs.readdirSync(ROOT)
  .filter(f => FORCED.test(f) && !KEEP.has(f) && fs.statSync(path.join(ROOT, f)).isFile());

if (strays.length) {
  console.error(
    `\nprepack refused: ${strays.length} file(s) match npm's always-included README*/LICENSE*/CHANGELOG*\n` +
    `glob and would be published no matter what \`files\` says:\n\n` +
    strays.map(f => `  ${f}`).join('\n') +
    `\n\nMove or delete them, then pack again.\n`
  );
  process.exit(1);
}
