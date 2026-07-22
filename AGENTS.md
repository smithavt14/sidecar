# AGENTS.md: driving sidecar as an agent

**sidecar** is a local tool for reviewing a document *together with a human*. It has two sides:

- **The human** uses the browser at `http://localhost:4880`. They read, comment, accept/reject your
  suggestion cards, and edit the rich text directly.
- **You (the agent)** use the **files**. You edit the markdown file with ordinary file tools, and you
  write review items (comments, suggestions) into a JSON **sidecar** next to it. The running server
  watches the files and pushes your changes into the human's browser live; their decisions come back to
  you through the same files.

**You never call the HTTP API. You work through the filesystem.** Read the doc, read/write its sidecar,
read `git diff` to see what the human did. That's the whole protocol.

---

## Running it

```bash
npm install
npm start -- /path/to/your/docs      # serves that dir at http://localhost:4880
```

`npm start -- <file-or-directory>` points sidecar at a single file or a directory of markdown files. Open a
specific file at `http://localhost:4880/?f=<path-relative-to-served-dir>`. Config: `SIDECAR_PORT` (default
4880), and `SIDECAR_HOSTS` for extra allowed Host headers such as a tailnet name (see the tailscale
section).

---

## The sidecar

Every reviewed file `foo.md` has a sibling `foo.md.review.json`:

```json
{ "schema": 1, "items": [ /* suggestion and comment items */ ] }
```

### Suggestion card: propose a specific edit

```json
{
  "id": "s-tighten-intro",
  "kind": "suggestion",
  "by": "claude",
  "anchor": { "quote": "The tool should be local and fast.", "occurrence": 0 },
  "replacement": "The tool should be local, file-native, and fast.",
  "note": "optional one-line rationale, shown under the diff",
  "status": "pending"
}
```

When the human clicks **accept**, the server replaces the anchored span in the real file with
`replacement`, flips `status` to `accepted`, and stamps `decidedAt`. **reject** sets `status: rejected`
and leaves the file untouched. The card shows them a word-level diff of `quote` to `replacement`.

**Answering a comment with an edit — set `replyTo`.** When your suggestion *responds to* one of the
human's comments (they asked "rewrite this to be warmer"), add `"replyTo": "<that-comment-id>"`. The
suggestion then renders **nested inside that comment's thread** (diff + accept/reject right there), and
**accepting it auto-resolves the parent comment**. Omit `replyTo` for a suggestion you raise on your own.

### Comment: start a thread (question, flag, note)

```json
{
  "id": "c-metric",
  "kind": "comment",
  "by": "claude",
  "anchor": { "quote": "success metrics", "occurrence": 0 },
  "status": "open",
  "thread": [
    { "by": "claude", "at": "2026-01-01T00:00:00Z", "text": "No target numbers here yet. Want me to draft 2-3?" }
  ]
}
```

The human replies, which appends a `{ "by": "alex", ... }` entry to `thread`. They click **resolve** to set
`status: resolved`. Add `"flag": true` to render it as a flag badge (a "look here" with no question).

### Scope boundary — sidecar does not interpret the requested work

sidecar never reads, parses, or classifies the anchored text: it has no notion of tasks, task syntax, tags,
checkboxes, links, or any external schema, and it models no jobs — no queue, no running/failed states, no
progress and no history. A comment (optionally `flag: true`, a "look here") carries a request and its reply;
deciding *what* the line asks for and *how* to act on it is entirely yours. If your workflow needs richer
semantics, put them in your own layer above sidecar, not in the sidecar.

### Anchors: the one thing to get right

- `quote` must be a **verbatim substring of the file's current content**. Matching is exact first, then
  markdown-tolerant (it strips `*_\`~`), so the quote can be the raw markdown (`**bold**`) or the visible
  text (`bold`). Whitespace runs are normalized, so a quote may span a soft line-break.
- `occurrence` is **0-based**: which match to target when the quote appears more than once. Use enough
  surrounding words to be unique, or set `occurrence`.
- Matching prefers word boundaries, so `"cat"` won't anchor inside "category", though a deliberately
  mid-word quote still resolves.
- If the text the quote points at no longer exists (the human edited it), the server marks the item
  `orphaned`: loud and visible, original quote preserved, never silently re-pointed. Re-read the file and
  re-anchor, or drop the item.

**Statuses:** suggestion `pending → accepted | rejected`; comment `open → resolved`; either can become
`orphaned` automatically. `by` is `claude` (you) or `alex` (the human). Rename as you like; both sides
just need a consistent label.

---

## Writing the sidecar: read-modify-write, never clobber

When you write `foo.md.review.json` as a plain file you replace the whole thing, so:

1. **Read** the existing sidecar (it may not exist yet, so start from `{ "schema": 1, "items": [] }`).
2. **Merge** your items in by `id`: add new ones, update your own, and **preserve every item the human
   owns** (their comments, their `accepted`/`rejected`/`resolved` statuses, their thread replies).
3. **Write** the whole file back.

Reusing an existing `id` updates that item; a new `id` adds one. Keep ids stable and descriptive (`s-…`
for suggestions, `c-…` for comments; ids must match `[\w-]+`). The server also merges defensively on its
side (thread messages are unioned, decided statuses never regress), so a concurrent human write and agent
write can't drop each other's work. You should still read-modify-write.

---

## The loop

1. **Draft** the file (the first version is usually yours).
2. **Suggest** by writing suggestion cards and comments into the sidecar, anchored to real text.
3. **The human reviews** in the browser: accepts/rejects cards, replies to threads, edits directly.
4. **Read their decisions** by re-reading the sidecar (new `alex` items, thread replies, status changes)
   and `git diff <file>` (what they accepted or hand-edited; accept mutates the file, and their direct
   edits show in the diff too).
5. **Respond**: resolve threads they answered, revise, add new suggestions.
6. Repeat until **zero open items**, then commit once at the end. Accepting a card leaves the tree dirty
   on purpose; the dirty diff *is* the review state.

---

## Live participation — `sidecar wait` (react as they review)

Instead of asking the human to come back to chat and say "done," **background `sidecar wait <file>` after you
post**. It fs-watches the sidecar and **returns the instant they do anything** — a new comment/reply, a run
request, an accept/reject, a direct edit, or hitting **done** — printing a compact digest of exactly
what changed (run requests appear as `RUN` lines). It
sleeps for free in between (no polling, no cost), so you can respond the moment a comment lands.

```bash
sidecar wait /abs/path/to/doc.md       # blocks; prints a digest and exits on the first change (--timeout 900)
```

**Use an absolute path** (or a path relative to the served directory). `sidecar wait` resolves the path against
its own cwd, so a relative path from the wrong directory would silently watch a nonexistent file. It now exits
with an error if the path doesn't resolve to a real file.

The loop: **background `sidecar wait` → it returns → respond in-thread → background `sidecar wait` again →
… until the digest says `DONE: true`, then make the single commit.** Respond by the request's nature:

- **Mechanical** (cut this, fix a typo, make a list) → just **edit the file** and drop a short "done" reply
  in the thread. No card; it's applied and reversible.
- **Judgment / rewrite** (make this warmer, tighten this) → write a **suggestion with `replyTo`** into the
  comment's thread (diff + accept/reject inline). On reject or "try again," add another `replyTo` suggestion
  in the same thread and iterate.

`session` and `presence` are two coordination fields on the sidecar/state:

```json
{ "schema": 1, "session": { "at": "ISO", "done": false }, "items": [ ... ] }
```

- `session.done` — the human's terminal "commit it" signal (a Done control in the UI, or chat). `sidecar wait`
  reports it as `DONE: true`; that's your cue to stop looping and commit once.
- `presence` — best-effort "Claude is here" shown in their header while a `sidecar wait` is running (posted to
  the server, in-memory, never committed). Nothing for you to write by hand.

---

## Working on sidecar itself

If you edit sidecar's **own code** (`server.js`, `public/`), the running server won't pick it up until it
restarts. The persistent LaunchAgent is `com.alex.sidecar` — **kickstart it before testing**, or you'll be
reviewing against stale code:

```bash
launchctl kickstart -k gui/$(id -u)/com.alex.sidecar
```

The server logs a `[code <git-sha> · <mtime>]` stamp at boot (also on the wordmark's hover title in the UI),
so you can confirm the live instance is on current code at a glance.

---

## Phone / tailnet

The human can review on their phone if you expose sidecar over their private tailnet:
`./scripts/tailscale-serve.sh` (requires Tailscale, and adding the tailnet hostname to `SIDECAR_HOSTS`).
Keep it tailnet-only. sidecar has no auth, so never `tailscale funnel` it publicly.
