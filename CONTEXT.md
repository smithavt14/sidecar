# Sidecar

A local review tool: a human and an agent review the same document side by side. All review
state lives in per-document sibling files, and the browser and CLI run identical code.

## Language

**Document**:
A file opened for review, served from the root sidecar was launched on. Markdown documents are
editable in the viewer; assets are not.

**Sidecar file**:
The per-document sibling `<doc>.sidecar.json` holding every review item. Renamed from
`.review.json` on 2026-08-13.
_Avoid_: review file

**Item**:
One card in the review: a comment or a suggestion.

**Suggestion**:
An item proposing a concrete replacement. Only the human settles it, by accept or reject.

**Anchor**:
What pins an item to a place in the document. Two kinds: text anchor and element anchor.

**Text anchor**:
A quote plus an occurrence index, resolved by the shared matcher in `public/anchor.js`.

**Element anchor**:
A pin to a DOM element inside an asset. Resolves by id or data attribute when the element has
one, else by structural path checked against a text-content signature.

**Asset**:
An HTML file reviewed as a rendered visual rather than as text. Read-only in the viewer; the
agent edits the file and the render refreshes.
_Avoid_: poster (one use of an asset, not the concept)

**Asset frame**:
The isolated surface that renders an asset with full styling. The asset's own scripts never run
in it.

**Picker**:
Sidecar's own script injected into the asset frame: it highlights the element under the
cursor and reports picks and geometry out to the page. The only script that runs in a frame.

**Orphaned**:
An item whose anchor no longer resolves. It revives on its own if the anchor resolves again.

**Digest**:
What changed since the agent last looked: decisions, new items, replies, orphans, doc edits.

**Cursor**:
The agent's persisted record of what it has already seen, in `<doc>.sidecar.seen.json`. Never
compared by timestamp, always by status and thread length.

**Rail**:
The review sidebar where cards dock beside their anchors.
