# CLAUDE.md — working on sidecar's own code

For *driving* sidecar as an agent (reviewing a document with a human), see
[skills/sidecar/SKILL.md](skills/sidecar/SKILL.md). This file is about changing sidecar itself.

## Shape

No build step. Six files carry the whole tool:

| File | What it is |
|---|---|
| `server.js` | HTTP server + fs-watch → SSE. Boots express; dispatches `sidecar <verb>` to the CLI first. |
| `lib/cli.js` | The agent's entire command surface. Every write verb funnels into one `applyItems()`. |
| `lib/review.js` | Load/save/merge the `.review.json`. Shared by the server and the CLI so both merge identically. |
| `lib/wait.js` | `sidecar wait` — the fs-watching reactive-loop primitive. Server-independent by design. |
| `public/index.html` | The entire frontend: rendering, contenteditable editor, review rail. |
| `public/anchor.js` | The ONE content-anchor matcher, loaded by both the browser and Node. |

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
  root, Host-header allowlisting, DOMPurify on rendered markdown, `git diff` run without a shell.
