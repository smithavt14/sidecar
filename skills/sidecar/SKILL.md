---
name: sidecar
description: |
  Review and revise a document together with a human, on their own machine. Use sidecar instead of
  pasting a draft back and forth whenever the task is collaboratively working through a prose
  document — a PRD, proposal, spec, essay, email or blog draft, summary, one-pager, memo, contract,
  community post, or any markdown file on disk. Triggers include naming it ("open this in sidecar,"
  "respond to my comments in sidecar") and generic collaborative-review intent without the word
  ("let's review this doc," "let's edit this together," "look this over and suggest changes," "work
  through this proposal with me," "let's revise this"). sidecar gives tracked suggestion cards with
  word-level diffs, comment threads, and rich-text editing on the real file, anchored by content
  rather than line numbers. NOT for a quick one-line take or a prose-tightening pass, and not for
  code review. Needs the document as a file on disk.
---

# sidecar — reviewing a document with a human

sidecar has two sides.

- **The human** uses the browser at `http://localhost:4880`. They read, comment, accept or reject
  your suggestion cards, and edit the rich text directly.
- **You** use the **commands below**. They read and write a JSON sidecar next to the document. The
  running server watches those files and pushes your changes into their browser live; their decisions
  come back to you through the same files.

You never call the HTTP API, and you never hand-edit the sidecar JSON. Every action is one command.

**What your items look like to them.** A suggestion renders as a card showing a word-level diff of the
quoted text against your replacement, with accept and reject buttons; `--note` appears as one line
underneath. A comment renders as a thread they can reply to or resolve. An `answer` nests inside the
thread it responds to, so the diff sits right under their question. Every open item softly highlights
its span in the document. Keep replacements short enough to read as a diff — a card is not a good place
for three paragraphs.

---

## Start here

Install the tool so the `sidecar <verb>` commands below work as written:

```bash
npm i -g @spktr/sidecar       # puts `sidecar` on PATH
```

No global install? Prefix every command below with `npx @spktr/sidecar` (e.g.
`npx @spktr/sidecar doctor doc.md`).

```bash
sidecar doctor                # is a server running, on what code, and what URLs to hand over
sidecar doctor path/to/doc.md # …including the deep links for that specific file
```

If nothing is running, start one — it serves a file or a whole directory:

```bash
npx @spktr/sidecar ~/path/to/docs    # → http://localhost:4880
```

The commands work with **no server running** — the filesystem is the sync layer. A server is only
needed for the human's browser.

**Always hand the human both URLs** when a review is ready; they are often on a phone, not at a desk.
`sidecar doctor <file>` prints both, including the tailnet address if one is configured.

---

## The commands

Every command takes the file path first. The **verb is the kind** — there is no `--kind` flag.

### Raising things

```bash
# a question or note, as a thread
sidecar comment doc.md --quote "success metrics" --text "No targets here yet — want me to draft three?"

# a "look here" with no question
sidecar flag doc.md --quote "ship all six in week one" --text "This reads as an overcommit."

# a specific edit, shown as a word-level diff they can accept or reject
sidecar suggest doc.md \
  --quote "We will ship all six features in week one." \
  --replacement "Week one ships the three core features; the rest follow once those earn their place." \
  --note "Optional one-line rationale, shown under the diff."
```

### Responding to them

```bash
sidecar reply doc.md c-metrics-a1b2c3 "Cut it — done."          # a message in their thread
sidecar reply doc.md c-metrics-a1b2c3 "Rewritten." --resolve    # …and settle the thread
sidecar resolve doc.md c-metrics-a1b2c3                         # settle it outright

# answer their comment WITH an edit: renders as a card nested in that thread, and
# accepting it auto-resolves the comment. Inherits the comment's anchor — no --quote.
sidecar answer doc.md c-metrics-a1b2c3 --replacement "Target: 200 signups by March."
```

### Housekeeping

```bash
sidecar reanchor doc.md s-intro-d4e5f6 --quote "the text as it reads now"   # rescue an orphan
sidecar suggest doc.md --id s-intro-d4e5f6 --replacement "a better wording" # revise a card in place
sidecar drop doc.md s-intro-d4e5f6                                          # withdraw your own item
```

`reanchor` repoints the anchor keeping the content; `suggest --id` keeps the anchor and revises the
content (no `--quote` — the card's existing anchor is reused).

### Long or multi-line text

Bash quoting will mangle multi-line markdown, so `-` reads the value from stdin:

```bash
sidecar suggest doc.md --quote "…" --replacement - <<'MD'
Week one ships three features.

The rest follow once those earn their place.
MD
```

### Seeding a review in one call

```bash
sidecar add doc.md <<'JSON'
[
  { "quote": "all six features", "replacement": "the three core features", "note": "Overcommit." },
  { "quote": "success metrics", "text": "No targets here yet — want three?" }
]
JSON
```

`kind` is inferred: a `replacement` makes it a suggestion, a `text` makes it a comment.

### Reading

```bash
sidecar show doc.md                # the COMPLETE current state — items, statuses, threads, diff, done
sidecar show doc.md --needs-reply  # just the threads whose last message is theirs
sidecar show doc.md --json         # same, machine-readable
sidecar wait doc.md --timeout 900  # block until they act (default 900s backstop)
sidecar check doc.md               # lint every anchor in the sidecar
sidecar check doc.md --quote "…"   # pre-flight one quote before you write it
```

---

## Anchors — the one thing to get right

Comments and suggestions attach to **quoted text**, not line numbers. If the text moves, the anchor
follows; if it disappears, the item goes `orphaned` — loudly — rather than editing the wrong place.

The commands handle the mechanics. `--quote` is matched against the file, whitespace-normalised and
markdown-tolerant, so it can be either the raw markdown (`**bold**`) or the visible text (`bold`), and
for a **comment** it may span soft line breaks and block boundaries — a quote taken from the rendered
document, running across two list items, still anchors. The occurrence index is resolved for you.

**A suggestion is stricter, because accepting one rewrites those exact bytes.** Both sides are checked.
The span is refused if it crosses a block boundary or a blank line, or starts or ends inside inline
markup — replacing such a span eats a list marker or leaves a dangling `*`. The *replacement* is
refused if it carries block structure (a blank line, heading, or list marker) into a span that is only
part of a line, or into a list item — that splits the block around it. In both cases the word-diff
would have looked clean while the file came out mangled.

So: quote within a single block, quote the raw markdown (`**bold** text`, not `bold text`) when the
span touches emphasis or code, and only introduce new blocks when your quote covers a whole
paragraph. To point at something spanning blocks, use a comment — comments only anchor, so they are
unrestricted.

**What is left to your judgment is choosing a quote that identifies exactly one span.** Everything
else is enforced:

- A quote matching **nothing** is refused, and nothing is written. `sidecar check --quote "…"` will
  bisect it and tell you which word it breaks at.
- A quote matching **several** spans is refused, with the count. Use a longer quote, or pass
  `--occurrence N` (0-based) if you genuinely mean the Nth.

If an item does orphan because the human rewrote that passage, `sidecar reanchor` it onto the new
text, or `sidecar drop` it.

**About `--force`.** The refusal messages mention it, so: it exists for the narrow case of seeding an
anchor onto text you are about to write, before that text exists. It is never the right answer to a
refusal you do not understand — a forced item lands `orphaned`, or worse, applies a splice the check
was trying to prevent. Fix the quote instead.

---

## The loop

1. **Draft** the document (the first version is usually yours).
2. **Suggest** — cards and comments anchored to real text.
3. **Hand over both URLs**, then background `sidecar wait <file>` (absolute path). It fs-watches and
   returns the instant they do anything, sleeping for free in between. *If your harness cannot run a
   command in the background and wake you when it exits*, run it in the foreground with a short
   `--timeout` (say 60) and treat a timeout exit as "nothing yet, run it again" — do not leave a
   15-minute default blocking the session.
4. **When it returns, run `sidecar show`** — see below. Then read `git diff <file>` for what they
   accepted or hand-edited.
5. **Respond**, then background `sidecar wait` again.
6. Repeat until the digest says `DONE: true`, then make **one commit**.

Accepting a card leaves the tree dirty on purpose — the dirty diff *is* the review state. Don't
auto-commit mid-review.

**Read the whole state each pass, not just the digest.** `sidecar wait` reports only the single event
that woke it; anything the human does while you are composing stacks up unreported. Run `sidecar show`
every time the watcher returns and act on every item awaiting you. Skipping this silently buries their
comments — it is the single most common way to mishandle a review.

Respond according to what they asked for:

- **Mechanical** ("cut this", "fix the typo") → just edit the file and `sidecar reply` a short "done".
  No card; it is applied and reversible.
- **Judgment** ("make this warmer", "tighten this") → `sidecar answer` their comment, so the diff lands
  inside the thread. If they reject it, `sidecar answer` again and iterate.

---

## What sidecar will not do

**It never interprets the document.** It has no notion of tasks, tags, checkboxes, or any external
schema, and it models no jobs — no queue, no running or failed states, no progress, no history. A
comment carries a request and its reply; deciding *what* it asks for and *how* to act is entirely
yours. If your workflow needs richer semantics, build them above sidecar, not inside it.

**You cannot accept or reject.** Those are the human's, in the browser. You propose; they decide.
There is deliberately no command for it.

---

## What gets stored

Each reviewed `foo.md` gets a sibling `foo.md.review.json` holding the items. You should not need to
read or write it directly — `sidecar show` is the readable view and the commands are the writable one —
but it is plain JSON, it belongs in git alongside the document, and the schema is stable.

It stays uncommitted until the review ends (you commit it once with the document), so a `git checkout -f`
or `git stash` mid-review discards the whole review — every card and comment, not just an anchor. There
is also a `foo.md.review.seen.json` cursor tracking what you have already read; that one is agent state,
never committed (it's gitignored).

Statuses: suggestions run `pending → accepted | rejected`; comments run `open → resolved`; either can
become `orphaned`. Items are stamped with `by` (your agent name — set `SIDECAR_AGENT` if `claude` is
wrong) and real timestamps, both filled in for you.

---

## Reviewing from a phone

`tailscale serve --bg 4880` proxies sidecar onto a private [Tailscale](https://tailscale.com) tailnet,
so the human can review from their phone with the machine awake (the repo wraps this as
`./scripts/tailscale-serve.sh`). Add the tailnet hostname to `SIDECAR_HOSTS` so the Host allowlist
accepts it. Keep it tailnet-only: sidecar has no authentication, so never `tailscale funnel` it
publicly.

---

## Working on sidecar's own code

If you edit `server.js`, `lib/`, or `public/`, a running server keeps serving the OLD code until it
restarts — you will be testing against stale logic. `sidecar doctor` compares the running server's
code stamp against the code on disk and says **STALE** when they differ. Restart before testing.
