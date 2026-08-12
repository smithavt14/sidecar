# Changelog

All notable changes to sidecar. Versions follow [semver](https://semver.org); dates are the day the
version was tagged.

## 1.5.0 — 2026-08-12

**Per-thread presence.** The card the agent is answering now says so: a shimmering *claude is
replying* at the tail of the thread, cleared the moment that reply lands. The signal is derived from
the `sidecar wait` exit (the digest already knows which threads woke it), so no new verb, no protocol
change, and nothing an agent can forget to call. Only threads that expect an answer light up — a
decided suggestion or an orphaned anchor never shows it. Presence records are now kept per (file,
agent), so two agents on one document can't wipe each other's state, and the browser expires stale
presence on its own clock, so a killed agent goes quiet instead of glowing "working" forever.

**The digest owns its document baseline.** `sidecar digest` and `wait` used to diff review items
against your last look but the document against git HEAD — two different clocks. Untracked docs and
non-git directories produced "your turn" digests with empty bodies, tracked docs re-sent every
uncommitted hunk on every look, and a mid-review commit silently blanked the diff channel. The
cursor now keeps its own copy of the doc (`<doc>.review.seen.base.<agent>`) and diffs in-process, so
the doc half of the digest finally means "since your last look" — everywhere, and mid-review commits
are harmless.

**A motion pass.** Cards animate in and out (accept, reject, and resolve share the same exit),
buttons got a spring press and a lift on hover, the toast eases in and out, and thread messages are
tinted by author so replies read at a glance. All of it honours `prefers-reduced-motion`.

**Fixes.** A server launched from a symlinked directory (`/tmp`, `/var/folders`) silently rejected
every presence ping; the root is now canonicalized at boot.

## 1.4.0 — 2026-08-12

- `.mdx` files are accepted.
- The gap between blocks is no longer marked as anchored content.
- Security: patched DOMPurify, and the package no longer ships the README's own review state.

## 1.3.0 — 2026-08-03

- **Screenshots in comments.** Paste or drop an image into any comment or reply box, or attach one
  from the camera roll on a phone; agents attach with `--image` and can read what you attach. Images
  live in `<doc>.review.assets/` next to the review.
- Attach is an icon beside resolve, not the word "image".

## 1.2.2 — 2026-07-30

- Agents hand the human the browser URLs instead of a terminal.

## 1.2.1 — 2026-07-29

- `sidecar doctor` stops reporting STALE for every npm install; it now distinguishes a genuinely
  stale server from a different installation and from a version mismatch.
- `--version` / `-v` print the version instead of trying to serve a directory named `--version`.

## 1.2.0 — 2026-07-29

- `sidecar skill` prints the agent protocol on stdout, so the agent that just installed the tool can
  read how to drive it without leaving the shell.

## 1.1.0 — 2026-07-29

- Review cards dock beside the text they're about; a tall card clips with its actions kept reachable.
- ` ```flow ` fences render as diagrams whose nodes take comment threads directly.
- The decision digest: a persistent per-agent cursor, a `digest` verb, and `wait` waking only on what
  the agent hasn't seen.
- Mobile: the review as a pull-up sheet, presence on the phone, `SIDECAR_USER` for the human's name.
- Comment and note bodies render as markdown.
- Packaged for public release as `@spktr/sidecar`.

## 1.0.0 — 2026-07-28

Initial release: suggestion cards with word-level diffs, comment threads, content-based anchors with
loud orphaning, rich-text editing on the real file, `sidecar wait`, and the localhost server.
