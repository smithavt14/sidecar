# CLAUDE.md — working on sidecar's own code

For *driving* sidecar as an agent (reviewing a document with a human), see
[skills/sidecar/SKILL.md](skills/sidecar/SKILL.md). This file is about changing sidecar itself.

## Shape

No build step. Nine files carry the whole tool:

| File | What it is |
|---|---|
| `server.js` | HTTP server + fs-watch → SSE. Boots express; dispatches `sidecar <verb>` to the CLI first. |
| `lib/cli.js` | The agent's entire command surface. Every write verb funnels into one `applyItems()`. |
| `lib/review.js` | Load/save/merge the `.sidecar.json`, and the one place the pre-1.7 `.review.*` names still exist. Shared by the server and the CLI so both merge identically. |
| `lib/assets.js` | Where an attached image lands and what counts as one. Shared by the upload route and `--image`. |
| `lib/wait.js` | `sidecar wait` — the fs-watching reactive-loop primitive. Server-independent by design. |
| `public/index.html` | The entire frontend: rendering, contenteditable editor, review rail. |
| `public/anchor.js` | The ONE content-anchor matcher, loaded by both the browser and Node. |
| `public/serialize.js` | The tight-diff serialize/reindex round-trip, shared with the Node tests. |
| `public/flow.js` | ```flow fences → SVG. Pure string in/out; no DOM, no dependency. |

## What sidecar actually promises

**100% local. You own it.** That's the whole pitch — nothing leaves the machine, no account, no
upload, and the document and its review are files on your disk that you can read, diff, and delete
without sidecar's help.

It is *not* a rule about transport. Earlier drafts of this file said "the agent works through the
filesystem, never the HTTP API," which described an implementation detail and then got treated as a
principle — it made a local CLI talking to a local server over loopback look like a violation of
something, when it violates nothing. If a change keeps everything on the machine and in the user's own
files, it is faithful to the design. Don't defend the transport.

## Two writers, one lock

The document has two writers and only one of them checks. The browser saves with a `baseHash`
optimistic lock and handles both conflict directions (external change while dirty → banner; stale
save → 409 → banner), so **the human never silently loses work**. The agent edits the document with
ordinary file writes and no check at all, so an agent write CAN silently overwrite something the human
just saved.

What actually prevents that is **turn-taking**: the `sidecar wait` → respond → re-arm loop keeps the
two writers temporally separated, and the agent should only touch the document while it holds the
turn. That is the real concurrency model and it is a convention, not an enforced property — worth
knowing before you assume the locking is symmetric. The expensive fix, if this ever actually bites, is
routing document edits through sidecar so they take the same lock; it has not bitten yet.

`public/anchor.js` and `lib/review.js` are shared on purpose. A second implementation of matching or
merging is a second set of bugs, and the two sides must agree byte-for-byte — a matcher that
normalised differently on each side once made the highlight point at one duplicate while accept
spliced another.

## Testing

```bash
npm test      # end-to-end against a real server + temp fixture repo, plus CLI and unit coverage
```

The CLI tests run the real binary with **no server running**, which is the point: the filesystem is
the sync layer, and the agent's interface has to work without one.

## The trap: a running server holds stale code

Editing `server.js`, `lib/`, or `public/` does not affect a server that is already running. You will
be testing against code loaded hours ago — this exact trap produced a whole "false orphan" debugging
session once. `sidecar doctor` compares the running server's code stamp against the code on disk and
prints **STALE** when they differ. Restart before testing.

The stamp (`<git-sha> · <mtime>`) is logged at boot, shown in `/api/state`, and on the wordmark's
hover title in the UI.

## Conventions

- Comments explain *why*, especially where the code looks odd — most of them record a real incident.
  Keep that when you change the surrounding code; delete them when the reason stops being true.
- Safety properties that tests cover and should stay covered: atomic sidecar writes, merge-by-id never
  dropping the other side's work, decided statuses never regressing, path confinement to the served
  root, Host-header allowlisting, DOMPurify on rendered markdown, `git diff` run without a shell
  (the two surviving call sites: the server's /api/state and `show`'s --stat; the digest diffs
  in-process against its own baseline), atomic blocks emitting their source bytes rather than
  going through turndown, and the legacy rename moving the full sibling set while never merging two
  reviews when both names are present.

## Attached images

An attachment is not a schema field. A pasted screenshot becomes a file in `<doc>.sidecar.assets/` and a
plain markdown link in the comment body, which the existing `/assets` route already resolves because it
is the same doc-relative form a document's own images use. That is why the feature added an upload
endpoint and no rendering, no storage format, and no new item kind.

Bytes stay out of the `.sidecar.json` deliberately. It is rewritten and merged on every reply and pushed
to the browser over SSE, so a base64 screenshot in there would tax every unrelated write; `sidecar show`
would print a wall of it at the agent; and "your files on your disk" stops being literally true the
moment a picture only exists inside a JSON string.

Names are content hashes, so the same image pasted three times is one file and a re-run of the same
agent command is idempotent. The upload sniffs magic bytes rather than trusting the filename or the
browser's `Content-Type` — not a security control (the serving route pins the type by extension and
sends `nosniff`), but the difference between a refusal with a reason and a silently broken `<img>`.

## Atomic blocks

A ```flow fence and a raw-HTML block render as **islands**: `contenteditable="false"`, and `toMd()`
returns the element's `__md` (its original markdown) instead of running turndown. Both halves are
load-bearing. Turndown cannot round-trip what these render to — an `<svg>` comes back as its bare label
text — so the block has to be unreachable from the edit path, not merely unlikely to be edited. The
`toMd` branch **throws** when `__md` is missing rather than falling back to turndown, because a silent
fallback there is precisely the data-loss bug it exists to prevent.

Two things that look like they should work and don't. `contenteditable` is not in DOMPurify's allowed
attribute set, so it must be set from code after sanitizing. And DOMPurify's `SAFE_FOR_XML` strips any
attribute whose value contains `-->` — which is the flow arrow — so a node's identity travels as an
index in `data-node`, never as its source. Both cost an afternoon to find; neither fails loudly.

Diagrams are also excluded from `docText()`, so anchor highlighting never injects an HTML `<mark>` into
the SVG namespace (where it silently does not render) and never mixes the fence's per-edge label
mentions into the same offset space as the rendered one-per-node text. Anchored nodes get their cue
from `markNodes()` instead.
