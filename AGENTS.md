# AGENTS.md — driving sidecar as an agent

The full protocol lives in **[skills/sidecar/SKILL.md](skills/sidecar/SKILL.md)**, which is also
installable as an agent skill:

```bash
npx skills add smithavt14/sidecar
```

One document rather than two, so the two cannot drift. Read it there.

---

## The short version

sidecar is a local review tool for a document a human and an agent work on together. The human reads,
comments, and accepts or rejects suggestions in a browser at `localhost:4880`. You work through
commands that read and write a JSON sidecar next to the document; the server pushes your changes into
their browser live, and their decisions come back through the same files.

The tool is `@spktr/sidecar` on npm — `npm i -g @spktr/sidecar` puts `sidecar` on PATH, or prefix every
command below with `npx @spktr/sidecar`.

```bash
sidecar doctor doc.md                # server up? on what code? which URLs to hand over?
sidecar show doc.md                  # the complete review state
sidecar comment doc.md --quote "…" --text "…"
sidecar suggest doc.md --quote "…" --replacement "…"
sidecar answer doc.md <comment-id> --replacement "…"
sidecar reply doc.md <id> "…"
sidecar wait doc.md                  # block until they act, then respond and re-arm
```

Anchors are quoted text, not line numbers. A quote matching nothing — or matching more than one span —
is refused before anything is written; `sidecar check doc.md --quote "…"` tests one in advance.

You cannot accept or reject. Those are the human's.

For notes on changing sidecar's own code, see [CLAUDE.md](CLAUDE.md).
