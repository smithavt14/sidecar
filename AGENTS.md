# AGENTS.md — driving sidecar as an agent

The full protocol lives in **[skills/sidecar/SKILL.md](skills/sidecar/SKILL.md)**. One document
rather than two, so the two cannot drift. Reach it either way:

```bash
npx skills add smithavt14/sidecar   # install it where your agent looks
npx @spktr/sidecar skill            # or print it to stdout, no install
```

The second reads the copy inside the installed package, so it always describes the version of the
code you are actually running.

---

## The short version

Sidecar is a local review tool for a document a human and an agent work on together. The human reads,
comments, and accepts or rejects suggestions in a browser at `localhost:4880`. You work through
commands that read and write a JSON sidecar next to the document; the server pushes your changes into
their browser live, and their decisions come back through the same files.

The tool is `@spktr/sidecar` on npm. **Install and start it yourself — never hand the human a shell
command.** `npm i -g @spktr/sidecar` puts `sidecar` on PATH; if it fails, prefix every command below
with `npx -y @spktr/sidecar` and say nothing about it.

```bash
sidecar doctor doc.md                # server up? on what code? which URLs to hand over?
sidecar show doc.md                  # the complete review state
sidecar comment doc.md --quote "…" --text "…" [--image shot.png]
sidecar suggest doc.md --quote "…" --replacement "…"
sidecar answer doc.md <comment-id> --replacement "…"
sidecar reply doc.md <id> "…"
sidecar wait doc.md                  # block until they act, then respond and re-arm
```

Nothing pushes into your session: if you hand over the URL and stop, you never see their comments.
Arm `sidecar wait` (absolute path, backgrounded if your harness can wake you on exit) after every
response, until the digest says `DONE: true`.

When `wait` returns it prints a **digest**: everything since your last look (decisions with their
reasons, new comments and replies in full, orphans, and the document's changed hunks). The baseline
is your own cursor rather than git, so it works the same on untracked files and non-git
directories, and a mid-review commit costs nothing.

**The human sees your side of the loop.** While your `wait` is armed their browser reads *claude is
here*; when it wakes, each thread that woke you shows *claude is replying* until your reply lands.
`wait` does this on its own; there is no presence command to call. It also cuts both ways: respond
and re-arm promptly, because a wake you sit on is visible as exactly that.

Anchors are quoted text, not line numbers. A quote matching nothing — or matching more than one span —
is refused before anything is written; `sidecar check doc.md --quote "…"` tests one in advance.

They can attach screenshots to comments. A body containing `![](doc.md.review.assets/….png)` is a
picture they want you to look at — open that path with your own file tools before you answer.

You cannot accept or reject. Those are the human's.

For notes on changing sidecar's own code, see [CLAUDE.md](CLAUDE.md).
