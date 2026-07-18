# margin

[![test](https://github.com/smithavt14/margin/actions/workflows/test.yml/badge.svg)](https://github.com/smithavt14/margin/actions/workflows/test.yml)

**A better way to work on documents with your AI agent.**

![Reviewing a document in margin: a suggestion card with a word-level diff, and a comment thread](docs/screenshot.png)

Reviewing a document with an AI usually means pasting it back and forth. A few web tools do this well,
with comment threads and tracked suggestions.

margin does the same, but entirely local. No upload, no network requests, no account. It works on the
files already on your disk, and your agent works those same files. To review from your phone, expose it
over your own Tailscale network.

> **Built by [spktr](https://spktr.ai),** an applied-AI studio. We help small businesses put AI to work,
> and we build tools for the people building *with* AI. margin is one of those tools.

---

## What it is

A ~1,000-line local review tool: one Node/Express server plus one HTML page (vanilla JS, a few small
libraries, no bundler). You review in the browser; your agent reads and writes a JSON sidecar next to each
file.

- **You** open `localhost:4880`, read the doc, comment, accept or reject suggestions, and edit rich text
  in place.
- **Your agent** (Claude Code, Cursor, Codex, …) edits the markdown file and writes review items into
  `<file>.review.json`. It needs no special client, just the filesystem. See [AGENTS.md](AGENTS.md).

## Who it's for

Anyone who pairs with a coding agent on prose (PRDs, proposals, specs, essays, community posts) and wants
to review it on their own machine, owning their files.

---

## Quickstart

```bash
git clone https://github.com/smithavt14/margin && cd margin
npm install
npm start -- ~/path/to/your/docs      # → http://localhost:4880
```

Then tell your agent: *"review draft.md in margin."* It writes the sidecar; you review in the browser.

**Review on your phone** (optional): `./scripts/tailscale-serve.sh` proxies margin onto your private
[Tailscale](https://tailscale.com) tailnet. Tailnet-only: margin has no auth, so never `tailscale funnel`
it publicly.

---

## What you can do

**Edit.** The rendered document *is* the editor.
- **Type-to-format:** `#`/`##`/`###` + space for headings, `-`/`1.` for lists, `>` for a quote, ` ``` `
  for a code block, and inline `**bold**` / `*italic*` / `` `code` `` as you type. Type `## ` in front of
  an existing heading to re-level it.
- **Block styles:** highlight text, then the toolbar's ¶ / H1 / H2 / H3 convert the block (or turn a
  heading back into body text).
- Select text for a floating toolbar: bold, italic (⌘B/⌘I), link, comment, flag.

**Comment.** Select text, then comment. Threads reply and resolve. Every open comment or suggestion softly
highlights its span in the document; tap the highlight to open its card, tap a card's quote to jump to the
text.

**Suggest** (your agent). Suggestion cards propose a replacement for a quoted span, shown as a word-level
diff. Accept applies it to the real file; reject leaves it. Comments and suggestions anchor to quoted
text, not line or character offsets: if the text moves, the anchor follows; if it's gone, the item goes
orphaned (loud and visible) instead of editing the wrong place.

**Save.** Edits autosave to the real file (debounced). Only the block you touched is re-serialized; every
untouched block keeps its exact original bytes, so `git diff` shows just what changed.

---

## Safety model

margin is a single-user, local, no-auth tool, hardened for that threat model:

- Binds to `127.0.0.1` and validates the `Host` header (an allowlist; add hosts via `MARGIN_HOSTS`).
  Loopback binding alone doesn't stop DNS-rebinding, so the Host check is enforced.
- Rendered markdown is sanitized with DOMPurify, so a hostile `<img onerror>` in a file can't execute.
- File access is confined to the served directory (path-traversal guarded), and `git diff` runs without a
  shell, so a crafted filename can't inject commands.
- Sidecar writes are atomic and merge by id, so a corrupt or concurrent write can't destroy your review.
- Optimistic-lock saves (409 on a stale file) never silently clobber changes made on disk.

It has no authentication, so keep it on localhost or a private tailnet and don't expose it publicly.

## Development

```bash
npm test      # end-to-end tests against a real server + temp fixture repo, plus round-trip/anchor units
```

No build step: `public/index.html` is the whole frontend, `server.js` the whole backend. The shared
matcher (`public/anchor.js`) and serializer (`public/serialize.js`) run in both the browser and Node, so
the tests exercise the real logic.

## License

[MIT](LICENSE)
