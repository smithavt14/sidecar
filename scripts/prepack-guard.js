#!/usr/bin/env node
// Refuse to pack when a stray README*/LICENSE*/CHANGELOG* file is sitting in the repo root.
//
// npm force-includes anything matching `README*` and `LICENSE*`/`LICENCE*` even with a `files`
// allowlist set, and neither `files` nor an .npmignore can override that. Measured against this
// package on 2026-08-12: a stray `README.md.review.json` and a stray `LICENSE.extra.txt` both landed
// in the tarball, while `CHANGELOG.old.md` and `NOTICE.txt` stayed out. CHANGELOG.md itself ships
// because `files` lists it by name, which is the whole reason it has to be listed.
//
// The README glob cost a real release. 1.3.0 shipped `README.md.review.json` and
// `README.md.review.seen.json` to the public registry, sidecar's own review state for its own
// README, an editorial conversation nobody meant to publish. They matched `README*`, so they rode
// along.
//
// The only reliable fix is for the file not to exist at pack time, so this fails the pack instead
// of shipping it. .gitignore keeps them untracked; this keeps them unpublished. `changelog` and
// `notice` stay in the pattern as belt and suspenders. They cost one readdir, they cover the day
// `files` grows a `CHANGELOG*` entry or npm widens what it forces in, and a stray changelog copy in
// the repo root earns a refusal on its own merits.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORCED = /^(readme|license|licence|changelog|notice)/i;
const KEEP = new Set(['README.md', 'LICENSE', 'CHANGELOG.md']);   // the real ones, which SHOULD ship

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
