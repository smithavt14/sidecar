# Changelog

All notable changes to sidecar. Versions follow [semver](https://semver.org); dates are the day the
version was tagged.

## 1.6.0 (2026-08-13)

**A reply to a fresh card no longer vanishes.** Replying to a card the agent created after its last
look hit a gap in the digest: the card sat outside the agent's cursor, the news check skipped it as
"my own card", and the skip took your reply down with it. `wait` slept through to its timeout and
the agent went quiet on a direct question. Suggest-then-wait is the normal order, so the window was
open at exactly the moment a first reply arrives. Messages from anyone else on the agent's own new
cards now surface as replies, and a matching negative control keeps the agent from waking on its
own messages.

**Suggestions take threads.** A suggestion card can be discussed before it is decided: reply on the
card, and the agent answers in place. Accept and reject stay the human's.

**Presence survives long turns.** The per-thread "claude is replying" mark used to die three minutes
into a long turn, because `working` presence had no heartbeat once the wait exited. Every CLI write
verb now refreshes presence as a side effect, so a multi-thread turn keeps its remaining marks lit
for as long as the agent keeps working. On the wire this is a protocol distinction: a presence ping
with no `items` field refreshes the clock and keeps the marks, an explicit empty list clears them.

**A rejection with a reason lights the mark.** The digest ships rejection reasons in full so the
agent can retry, and now the rejected card shows "claude is replying" while that retry is composed.
A bare rejection stays dark, since "just no" usually gets silence and a lying light is worse than
none. Accepts and resolves stay dark too.

**The agent stops waking itself on its own drops.** The cursor now records who authored each card,
so an agent dropping its own card produces no wake, while a card someone else authored going
missing still reports.

**A suggestion can propose new list items.** When the quote covers a whole list item and every
replacement line is an item of the same kind at the same indent, the splice is safe and now
permitted. Partial spans, mismatched markers, and mixed block types stay refused; a `*` in a `-`
list opens a second list in CommonMark, so the marker rule is correctness rather than caution.

**Also:**

- The selection toolbar rises for keyboard selections, so shift-arrow selection can bold, link, or
  comment without touching the mouse.
- `doctor` warns when a host repo has not gitignored the agent-state files (`*.review.seen*`).
- `spliceRisk` recognizes `2)`-style ordered markers as block boundaries.

**Upgrading:** a `sidecar wait` process armed before the upgrade holds the old digest code and keeps
the reply-dropping bug until it exits. Re-arm your waits after updating.

## 1.5.0 (2026-08-12)

**Per-thread presence.** The card the agent is answering now says so: a shimmering *claude is
replying* at the tail of the thread, cleared the moment that reply lands. The signal rides the
`sidecar wait` exit the tool already makes (the digest knows which threads woke it), so every agent
that drives `wait` gets it unchanged, and there is nothing an agent has to remember to call. Only
threads that expect an answer light up; a decided suggestion or an orphaned anchor never shows it.
Presence records are now kept per (file, agent), so two agents on one document can't wipe each
other's state, and the browser expires stale presence on its own clock, so a killed agent goes
quiet instead of glowing "working" forever.

**The digest owns its document baseline.** `sidecar digest` and `wait` used to diff review items
against your last look but the document against git HEAD, which is a different clock. Untracked
docs and non-git directories produced "your turn" digests with empty bodies, tracked docs re-sent
every uncommitted hunk on every look, and a mid-review commit silently blanked the diff channel.
The cursor now keeps its own copy of the doc (`<doc>.review.seen.base.<agent>`) and diffs
in-process, so the doc half of the digest finally means "since your last look" everywhere, and
mid-review commits are harmless.

**A motion pass.** Cards animate in and out (accept, reject, and resolve share the same exit),
buttons got a spring press and a lift on hover, the toast eases in and out, and thread messages are
tinted by author so replies read at a glance. All of it honours `prefers-reduced-motion`.

**Fixes.** A server launched from a symlinked directory (`/tmp`, `/var/folders`) silently rejected
every presence ping; the root is now canonicalized at boot.

## 1.4.0 (2026-08-12)

- `.mdx` files are accepted.
- The gap between blocks is no longer marked as anchored content.
- Security: patched DOMPurify, and the package no longer ships the README's own review state.

## 1.3.0 (2026-08-03)

- **Screenshots in comments.** Paste or drop an image into any comment or reply box, or attach one
  from the camera roll on a phone; agents attach with `--image` and can read what you attach. Images
  live in `<doc>.review.assets/` next to the review.
- Attach is an icon beside resolve, not the word "image".

## 1.2.2 (2026-07-30)

- Agents hand the human the browser URLs instead of a terminal.

## 1.2.1 (2026-07-29)

- `sidecar doctor` stops reporting STALE for every npm install; it now distinguishes a genuinely
  stale server from a different installation and from a version mismatch.
- `--version` / `-v` print the version instead of trying to serve a directory named `--version`.

## 1.2.0 (2026-07-29)

- `sidecar skill` prints the agent protocol on stdout, so the agent that just installed the tool can
  read how to drive it without leaving the shell.

## 1.1.0 (2026-07-29)

- Review cards dock beside the text they're about; a tall card clips with its actions kept reachable.
- ` ```flow ` fences render as diagrams whose nodes take comment threads directly.
- The decision digest: a persistent per-agent cursor, a `digest` verb, and `wait` waking only on what
  the agent hasn't seen.
- Mobile: the review as a pull-up sheet, presence on the phone, `SIDECAR_USER` for the human's name.
- Comment and note bodies render as markdown.
- Packaged for public release as `@spktr/sidecar`.

## 1.0.0 (2026-07-28)

Initial release: suggestion cards with word-level diffs, comment threads, content-based anchors with
loud orphaning, rich-text editing on the real file, `sidecar wait`, and the localhost server.
