<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/smithavt14/sidecar/main/brand/sidecar-horizontal-dark.svg">
  <img alt="sidecar" src="https://raw.githubusercontent.com/smithavt14/sidecar/main/brand/sidecar-horizontal.svg" width="380">
</picture>

[![test](https://github.com/smithavt14/sidecar/actions/workflows/test.yml/badge.svg)](https://github.com/smithavt14/sidecar/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/%40spktr%2Fsidecar)](https://www.npmjs.com/package/@spktr/sidecar)
[![license](https://img.shields.io/badge/license-MIT-black)](LICENSE)

**A better way to work on documents with your AI agent.**

![Reviewing a document in sidecar: a suggestion card with a word-level diff, and a comment thread](https://raw.githubusercontent.com/smithavt14/sidecar/main/docs/example.png)

Reviewing a document your agent drafted is clumsy today: the file lives on your disk, the conversation about it lives in a chat window, and marking up raw markdown by hand is annoying. The tools actually built for review — Google Docs, Notion — do it well, but they live in the cloud: your agent only reaches them through a connector, every change crosses the network, and your document sits on someone else's server. sidecar brings the review to the file instead: suggestion cards, word-level diffs, and comment threads on the markdown already on your disk — 100% local, as modern as any SaaS tool, and accepting a card writes the real bytes.

**Why sidecar**

- **100% local.** No upload, no network requests, no account. The files on your disk are the whole system.
- **Real files, real diffs.** Edits write the actual markdown, and untouched blocks keep their exact
  original bytes — `git diff` shows just what changed, and git is your undo.
- **Any agent with a shell.** Claude Code, Cursor, Codex, … — one small CLI, no plugin, no API key.
- **A live loop, not a mailbox.** Your agent can watch the review and answer inside your comment threads
  the moment you act.
- **Anchored to content, not line numbers.** If text moves, anchors follow; if it's gone, the item goes
  orphaned — loudly — instead of editing the wrong place.

**When not to use it:** multi-user editing (single-user by design), non-markdown files, or a review
synced across two machines mid-flight.

## Quickstart

```bash
npm i -g @spktr/sidecar          # requires Node ≥ 20
sidecar ~/path/to/your/docs      # → http://localhost:4880
```

Or without installing: `npx @spktr/sidecar ~/path/to/your/docs`. It serves a single file or a whole
directory.

Give your agent the skill so it knows the commands:

```bash
npx skills add smithavt14/sidecar
```

Then tell your agent: *"review draft.md in sidecar."* Behind that sentence, it runs commands like:

```bash
sidecar suggest draft.md \
  --quote "ship all six features in week one" \
  --replacement "ship the three core features" \
  --note "Overcommit."
```

…and the card appears in your browser, live, as a diff with accept/reject. See [AGENTS.md](AGENTS.md)
for the full command set.

**Review on your phone** (optional): `tailscale serve --bg 4880` proxies sidecar onto your private
[Tailscale](https://tailscale.com) tailnet. Tailnet-only: sidecar has no auth, so never `tailscale funnel`
it publicly.

<img alt="sidecar on a phone: the document, and the review as a pull-up sheet" src="https://raw.githubusercontent.com/smithavt14/sidecar/main/docs/screenshot.png" width="420">

## The loop

1. Your agent drafts a markdown file (or you open one of yours).
2. It seeds the review — suggestion cards and comments anchored to real text.
3. You read, accept, reject, reply, and edit rich text in place. Desk or phone.
4. The agent, backgrounded on `sidecar wait`, answers the moment you act — proposing rewrites right
   inside your comment threads.
5. You click **done reviewing** → the agent makes one commit. The dirty diff *was* the review state.

## What you can do

**Edit.** The rendered document *is* the editor.
- **Type-to-format:** `#`/`##`/`###` + space for headings, `-`/`1.` for lists, `>` for a quote, ` ``` `
  for a code block, and inline `**bold**` / `*italic*` / `` `code` `` as you type. Type `## ` in front of
  an existing heading to re-level it.
- **Block styles:** highlight text, then the toolbar's text-style dropdown converts the block between body
  text and H1 / H2 / H3.
- Select text for a floating toolbar: bold, italic (⌘B/⌘I), link, comment.

**Comment.** Select text, then comment. The comment box is draggable, so you can move it off the text you're
commenting on. Threads reply and resolve. Every open comment or suggestion softly highlights its span in the
document; tap the highlight to open its card, tap a card's quote to jump to the text. The review rail has two
tabs — **active** threads (open, editable) and **archived** threads (settled, read-only).

**Suggest** (your agent). Suggestion cards propose a replacement for a quoted span, shown as a word-level
diff. Accept applies it to the real file; reject leaves it.

**Save.** Edits autosave to the real file (debounced), preserving the exact bytes of every block you didn't
touch.

## Safety mechanics

Hardened for exactly its threat model — single-user, single-machine, localhost, no auth:

- Binds to `127.0.0.1` and validates the `Host` header against an allowlist (`SIDECAR_HOSTS`), because
  loopback binding alone doesn't stop DNS rebinding.
- Rendered markdown is sanitized with DOMPurify, so a hostile `<img onerror>` in a file can't execute.
- File access is confined to the served directory (path-traversal guarded), and `git diff` runs without a
  shell, so a crafted filename can't inject commands.
- Sidecar writes are atomic and merge by id; saves take an optimistic lock (409 on a stale file) and never
  silently clobber changes made on disk.

Single-machine matters: finish a review before syncing clones — merge-by-id reconciles concurrent writes
to one file, not two divergent histories. (The agent also keeps a `<file>.review.seen.json` cursor of what
it has read — local agent state, not review content; leave it out of git.)

## Development

To hack on sidecar itself, clone and run from source:

```bash
git clone https://github.com/smithavt14/sidecar && cd sidecar
npm install
npm start -- ~/path/to/your/docs      # → http://localhost:4880
npm test                              # end-to-end tests against a real server + temp fixture repo, plus round-trip/anchor units
```

It's a ~1,000-line tool with no build step: `public/index.html` is the whole frontend, `server.js` the
whole backend. The shared matcher (`public/anchor.js`) and serializer (`public/serialize.js`) run in both
the browser and Node, so the tests exercise the real logic.

## Credits

Built by [spktr](https://spktr.ai), an applied-AI studio. We help small businesses put AI to work, and we
build tools for the people building *with* AI — sidecar is one of those tools.

## License

[MIT](LICENSE)
