#!/usr/bin/env node
/* sidecar — the agent's command surface.

   Before this existed, an agent drove sidecar by hand-editing <file>.review.json: read the whole
   file, merge its change in memory, write the whole file back, for EVERY comment and reply. That
   cost ~1.7k tokens per item on a 3.5KB sidecar (and grew with the review), and the merge discipline
   it required was the longest, most failure-prone section of the docs. Every verb here funnels into
   applyItems(), which runs the same lib/review.js merge the HTTP server runs.

   Design rules:
   - The VERB is the kind. No --kind flag; `comment`/`flag`/`suggest`/`answer` say it themselves.
   - The CLI derives everything mechanical: id, by, at (real clock), status, and the anchor nesting.
     An agent cannot mis-stamp a timestamp or forget a field, because it never writes them.
   - Anchors are validated BEFORE writing. A quote that matches nothing, or matches several spans
     without an explicit --occurrence, is refused loudly instead of silently anchoring wrong.
   - Accept and reject are absent on purpose. Those are the human's, through the UI. The agent
     proposes; it never decides. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Anchor = require('../public/anchor.js');
const { loadReview, saveReview, sidecarPath, annotateOrphans, spliceRisk, replacementRisk, mergeItem } = require('./review.js');
const { saveAsset } = require('./assets.js');
const { loadSeen, saveSeen, computeDigest, renderDigest, loadBaseline } = require('./digest.js');
const { ping: pingPresence } = require('./presence.js');

const AGENT = process.env.SIDECAR_AGENT || 'claude';
const PORT = process.env.SIDECAR_PORT || 4880;

const COMMANDS = ['wait', 'digest', 'show', 'check', 'comment', 'flag', 'suggest', 'answer',
                  'reanchor', 'reply', 'resolve', 'drop', 'add', 'doctor', 'skill', 'help'];
const isCommand = (v) => COMMANDS.includes(v);

// ---------- shared plumbing ----------

function die(msg, code = 1) { console.error(msg); process.exit(code); }

// --flag value / --flag=value / bare positionals. Deliberately dumb: every value is a string, and
// unknown flags are an error rather than a silent no-op (a typo'd --replacment must not write an
// item with no replacement).
function parseArgs(argv, known) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq));
    if (!known.includes(name)) die(`unknown flag --${name}\nknown: ${known.map(k => '--' + k).join(' ')}`, 2);
    if (name === 'force' || name === 'resolve' || name === 'needs-reply' || name === 'json' || name === 'peek') { flags[name] = true; continue; }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) die(`--${name} needs a value`, 2);
    // --image is the one repeatable flag: a comment can carry several screenshots, and the natural
    // way to say that is to pass it twice rather than to invent a separator that filenames can contain.
    if (name === 'image') { (flags.image = flags.image || []).push(value); continue; }
    flags[name] = value;
  }
  return { flags, positional };
}

// Resolve against cwd and fail loud. `safePath` in server.js is built on the served ROOT, which is
// meaningless under a subcommand (argv[2] is the verb), so CLI paths never go through it. A relative
// path from the wrong directory would otherwise silently address a nonexistent file.
// `.mdx` is markdown with JSX islands, not code: the block markers still mean what they say, and a
// span that would splice through a component is caught by spliceRisk/replacementRisk below, same as
// any other unsafe span. Exported so the server's picker and file watcher can't drift from this list.
const MARKDOWN = ['.md', '.markdown', '.mdown', '.mkd', '.mdx'];
function resolveFile(p) {
  if (!p) die('usage: sidecar <command> <file> …', 2);
  const abs = path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) die(`no file at ${abs}\nPass an absolute path, or run from the directory containing it.`, 2);
  // Markdown only. The browser never serves anything else, so only an agent can wander here — and the
  // anchor matcher's tolerant pass strips `#` and `-` at line starts, which in source code are comment
  // syntax and arithmetic, not block markers. Anchoring into code would be quietly wrong rather than
  // loudly broken, and there is no UI in which the human could ever see the result.
  if (!MARKDOWN.includes(path.extname(abs).toLowerCase()))
    die(`sidecar reviews markdown, not ${path.extname(abs) || 'extensionless files'}: ${path.basename(abs)}\n` +
        `The anchor matcher treats "#" and "-" at line starts as markdown structure, which is wrong for code.`, 2);
  return abs;
}

// `--replacement -` (or `--text -`) reads stdin, so multi-line markdown never has to survive bash
// quoting. A heredoc is the intended caller.
function valueOrStdin(v) { return v === '-' ? fs.readFileSync(0, 'utf8').replace(/\n$/, '') : v; }

// `--image ./shot.png` copies the file into `<doc>.review.assets/` and appends a markdown link, which
// is all an attachment is (see lib/assets.js). Appends rather than interpolating: the agent wrote the
// text to be read, and an image belongs after it. Copies rather than linking to wherever the file
// happens to sit, so the review still renders once that path is gone — an agent's screenshot usually
// lives in a scratch dir that outlives nothing.
function attachImages(abs, text, images) {
  if (!images || !images.length) return text;
  const links = images.map((p) => {
    const src = path.resolve(process.cwd(), p);
    if (!fs.existsSync(src)) die(`no image at ${src}`, 2);
    try { return `![](${saveAsset(abs, fs.readFileSync(src)).rel})`; }
    catch (e) { die(`--image ${p}: ${e.message}`, 2); }
  });
  return [text, ...links].filter(s => s !== '' && s != null).join('\n\n');
}

const slug = (s) => ((s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  .split('-').filter(Boolean).slice(0, 4).join('-') || 'item');
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);

// Readable + stable: the slug names the anchored text (so an id is recognisable in `show` output),
// the hash disambiguates two items on the same span. Seeds are separate so the slug stays clean.
function freshId(review, prefix, hashSeed, slugSeed = hashSeed) {
  const base = `${prefix}-${slug(slugSeed)}-${shortHash(hashSeed)}`;
  const taken = new Set(review.items.map(i => i.id));
  if (!taken.has(base)) return base;
  let n = 2; while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Resolve a quote to an occurrence index, or explain why it can't be. This is the check that turns
// the whole orphan class from "you find out when the human sees a broken card" into "the command
// refused and told you what to do".
function resolveAnchor(raw, quote, explicit) {
  if (!quote) return { error: 'no --quote given' };
  const hits = Anchor.findAll(raw, quote);
  if (!hits.length) return { error: `quote matched nothing in the file:\n  "${clip(quote, 90)}"` };
  if (explicit !== undefined) {
    const n = Number(explicit);
    if (!Number.isInteger(n) || n < 0 || n >= hits.length)
      return { error: `--occurrence ${explicit} out of range (${hits.length} match${hits.length > 1 ? 'es' : ''})` };
    return { occurrence: n, hits: hits.length };
  }
  if (hits.length > 1)
    return { error: `quote is ambiguous — ${hits.length} matches. Use a longer quote, or pass --occurrence 0..${hits.length - 1}.` };
  return { occurrence: 0, hits: 1 };
}

const clip = (s, n = 60) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Every write verb re-pings presence on its way out. The server gives a "working" record 180s
// (WORKING_TTL) and nothing heartbeats it, because the `wait` that set it has already exited while the
// agent composes. Real turns run five to eight minutes, so the "claude is replying" marks kept dying
// mid-reply and the cards went dark while the answer was still being written. A write is proof the
// agent is still on this document, so it pushes the clock out again.
//
// `items` is omitted on purpose. The ids in hand are the wait's to declare, and an omitted field tells
// the server to keep the ones it already has (server.js, POST /api/presence), which is what keeps the
// OTHER threads lit. The thread being answered clears its own mark through the browser's rule about
// whose message is last.
//
// Realpathed for the same reason `wait` does it: the server's containment check runs against a
// realpath'd root, so a /tmp path on macOS reads as escaping it and the ping silently no-ops.
function repingWorking(abs) {
  let real = abs; try { real = fs.realpathSync(abs); } catch {}
  pingPresence(real, 'working', null);
}

// THE write path. Every verb ends here: validate each item's anchor against the file, merge by id
// exactly as PUT /api/review does, write atomically. Merging (rather than replacing) is what makes a
// concurrent human click and agent write unable to drop each other.
function applyItems(abs, items, { force = false } = {}) {
  const raw = fs.readFileSync(abs, 'utf8');
  const review = loadReview(abs);
  const byId = new Map(review.items.map(i => [i.id, i]));
  const problems = [], report = [];

  for (const it of items) {
    if (!/^[\w-]+$/.test(it.id || '')) { problems.push(`invalid item id: ${it.id}`); continue; }
    if (it.anchor && it.anchor.quote) {
      const r = resolveAnchor(raw, it.anchor.quote, it.anchor.occurrence);
      if (r.error) { problems.push(`${it.id}: ${r.error}`); if (!force) continue; }
      else {
        it.anchor.occurrence = r.occurrence; it.matchedAt = new Date().toISOString();
        // A suggestion gets SPLICED on accept, so its span must be safe to replace — the matcher is
        // deliberately looser than that (see spliceRisk). Comments only anchor, so they're exempt.
        const kind = it.kind || (byId.get(it.id) || {}).kind;
        if (kind === 'suggestion') {
          const hit = Anchor.findNth(raw, it.anchor.quote, r.occurrence);
          const risk = hit && (spliceRisk(raw, hit.start, hit.end)
                            || replacementRisk(raw, hit.start, hit.end, it.replacement));
          if (risk) { problems.push(`${it.id}: ${risk}. Quote text from a single block, or use a comment instead.`); if (!force) continue; }
        }
      }
    }
    const existed = byId.has(it.id);
    byId.set(it.id, existed ? mergeItem(byId.get(it.id), it) : it);
    report.push(`${existed ? 'updated' : 'added'} ${it.id}` +
      (it.anchor ? `  @ "${clip(it.anchor.quote, 44)}"${it.anchor.occurrence ? ` [occurrence ${it.anchor.occurrence}]` : ''}` : ''));
  }

  if (problems.length && !force) {
    die('refused — nothing written:\n' + problems.map(p => '  ' + p).join('\n') +
        '\n\nRun `sidecar check <file> --quote "…"` to test a quote, or --force to write anyway.');
  }
  const merged = { schema: review.schema || 1, items: [...byId.values()], ...(review.session ? { session: review.session } : {}) };
  // Recompute orphan state against the file we just validated against, exactly as /api/state does.
  // This is also what un-orphans a reanchored item: reconcileStatus deliberately refuses to let an
  // incoming `open` regress a stored `orphaned` (a stale write must never resurrect a dead card), so
  // the status has to come from the anchor actually resolving, not from the merge.
  annotateOrphans(raw, merged);
  saveReview(abs, merged);
  if (problems.length) console.error('warning (written anyway, --force):\n' + problems.map(p => '  ' + p).join('\n'));
  console.log(report.join('\n'));
  repingWorking(abs);
}

function mustFind(review, id) {
  const it = review.items.find(i => i.id === id);
  if (!it) die(`no item with id ${id}\nRun \`sidecar show <file>\` to list them.`);
  return it;
}

// ---------- write verbs ----------

function cmdComment(argv, { flag = false } = {}) {
  const { flags, positional } = parseArgs(argv, ['quote', 'text', 'occurrence', 'id', 'image']);
  const abs = resolveFile(positional[0]);
  const text = valueOrStdin(flags.text);
  if (!text || !flags.quote) die(`usage: sidecar ${flag ? 'flag' : 'comment'} <file> --quote "…" --text "…" [--image shot.png]`, 2);
  const review = loadReview(abs);
  // The id is seeded from the text BEFORE the image links are appended, so re-running the same command
  // with a different screenshot doesn't silently mint a second card for the same comment.
  const body = attachImages(abs, text, flags.image);
  const item = {
    id: flags.id || freshId(review, 'c', flags.quote + text, flags.quote),
    kind: 'comment', by: AGENT,
    anchor: { quote: flags.quote, ...(flags.occurrence !== undefined ? { occurrence: Number(flags.occurrence) } : {}) },
    status: 'open',
    ...(flag ? { flag: true } : {}),
    thread: [{ by: AGENT, at: new Date().toISOString(), text: body }],
  };
  applyItems(abs, [item]);
}

function cmdSuggest(argv) {
  const { flags, positional } = parseArgs(argv, ['quote', 'replacement', 'note', 'occurrence', 'id']);
  const abs = resolveFile(positional[0]);
  const replacement = valueOrStdin(flags.replacement);
  if (replacement === undefined) die('usage: sidecar suggest <file> --quote "…" --replacement "…"  (or --replacement - for stdin)', 2);
  const review = loadReview(abs);
  // Revising an existing card (--id) inherits its anchor, so --quote is only required for a new one.
  const prior = flags.id && review.items.find(i => i.id === flags.id);
  const quote = flags.quote || (prior && prior.anchor && prior.anchor.quote);
  if (!quote) die('usage: sidecar suggest <file> --quote "…" --replacement "…"\n(--quote may be omitted only with --id naming an existing card, whose anchor is then reused)', 2);
  applyItems(abs, [{
    id: flags.id || freshId(review, 's', quote + replacement, quote),
    kind: 'suggestion', by: AGENT,
    anchor: { quote, ...(flags.occurrence !== undefined ? { occurrence: Number(flags.occurrence) }
                        : (prior && prior.anchor && prior.anchor.occurrence ? { occurrence: prior.anchor.occurrence } : {})) },
    replacement, ...(flags.note ? { note: flags.note } : {}),
    status: 'pending',
  }]);
}

// A card that ANSWERS a comment. It inherits the parent's anchor — the span is already established by
// the comment being answered, so there's no --quote to get wrong. Accepting it auto-resolves the
// parent (server.js /api/accept).
function cmdAnswer(argv) {
  const { flags, positional } = parseArgs(argv, ['replacement', 'note', 'id']);
  const abs = resolveFile(positional[0]);
  const parentId = positional[1];
  if (!parentId) die('usage: sidecar answer <file> <comment-id> --replacement "…"', 2);
  const replacement = valueOrStdin(flags.replacement);
  if (replacement === undefined) die('usage: sidecar answer <file> <comment-id> --replacement "…"', 2);
  const review = loadReview(abs);
  const parent = mustFind(review, parentId);
  applyItems(abs, [{
    id: flags.id || freshId(review, 's', parentId + replacement, parentId),
    kind: 'suggestion', by: AGENT, replyTo: parentId,
    anchor: { ...parent.anchor },        // inherited, not re-specified
    replacement, ...(flags.note ? { note: flags.note } : {}),
    status: 'pending',
  }]);
}

function cmdReanchor(argv) {
  const { flags, positional } = parseArgs(argv, ['quote', 'occurrence']);
  const abs = resolveFile(positional[0]);
  const id = positional[1];
  if (!id || !flags.quote) die('usage: sidecar reanchor <file> <id> --quote "…"', 2);
  mustFind(loadReview(abs), id);
  // No status here on purpose — applyItems re-annotates, and a resolving anchor is what returns the
  // item to open/pending. Passing `open` would lose to the stored `orphaned` in reconcileStatus.
  applyItems(abs, [{
    id, anchor: { quote: flags.quote, ...(flags.occurrence !== undefined ? { occurrence: Number(flags.occurrence) } : {}) },
  }]);
}

function cmdReply(argv) {
  const { flags, positional } = parseArgs(argv, ['resolve', 'image']);
  const abs = resolveFile(positional[0]);
  const [, id, ...rest] = positional;
  const text = valueOrStdin(rest.join(' '));
  if (!id || !text) die('usage: sidecar reply <file> <id> "…"  [--resolve] [--image shot.png]', 2);
  const review = loadReview(abs);
  const it = mustFind(review, id);
  // --resolve writes the same decided status as `resolve`, so it needs the same guard — without it the
  // resolve guard is decorative, since the identical write is one flag away. A plain reply (a message on
  // the thread, no status) stays legal on a suggestion.
  if (flags.resolve && it.kind === 'suggestion')
    die(`refused — ${id} is a suggestion; --resolve would settle a card only the human can accept or reject.\n` +
        `Reply without --resolve to leave a message, or \`sidecar drop\` to withdraw your own card.`);
  applyItems(abs, [{
    id, thread: [{ by: AGENT, at: new Date().toISOString(), text: attachImages(abs, text, flags.image) }],
    ...(flags.resolve ? { status: 'resolved', decidedAt: new Date().toISOString() } : {}),
  }]);
}

function cmdResolve(argv) {
  const { positional } = parseArgs(argv, []);
  const abs = resolveFile(positional[0]);
  const id = positional[1];
  if (!id) die('usage: sidecar resolve <file> <id>', 2);
  const it = mustFind(loadReview(abs), id);
  // resolve closes a COMMENT thread. It must never touch a suggestion: accept/reject is the human's,
  // in the browser, and settling a suggestion here writes a decided status the human never made — the
  // 2026-07-23 audit's fabricated-decision hole, the same one the `add` allow-list closes. To take back
  // your own pending card, use `sidecar drop` (an honest removal, not a forged decision).
  if (it.kind === 'suggestion')
    die(`refused — ${id} is a suggestion, and accept/reject belongs to the human in the browser.\n` +
        `To withdraw your own card, use \`sidecar drop ${path.basename(abs)} ${id}\`.`);
  applyItems(abs, [{ id, status: 'resolved', decidedAt: new Date().toISOString() }]);
}

// The one thing merge-by-id CANNOT express: removal. Guarded to items this agent owns, because
// deleting the human's comment is never a thing an agent should do by accident.
function cmdDrop(argv) {
  const { flags, positional } = parseArgs(argv, ['force']);
  const abs = resolveFile(positional[0]);
  const ids = positional.slice(1);
  if (!ids.length) die('usage: sidecar drop <file> <id> [<id>…]  [--force]', 2);
  const review = loadReview(abs);
  const dropped = [];
  for (const id of ids) {
    const it = mustFind(review, id);
    if (it.by !== AGENT && !flags.force)
      die(`refused to drop ${id} — it belongs to "${it.by}", not "${AGENT}".\nPass --force if you really mean to remove someone else's item.`);
    dropped.push(id);
  }
  review.items = review.items.filter(i => !dropped.includes(i.id));
  saveReview(abs, review);
  console.log(dropped.map(id => `dropped ${id}`).join('\n'));
  repingWorking(abs);   // the one write verb that bypasses applyItems still counts as being here
}

// Batch seeding: several cards in one call, the common opening move. Flat input — the same shape the
// verbs build — so `quote`/`text`/`replacement` sit at the top level and everything mechanical is filled in.
//
// The stored schema is PRIVATE. `add` accepts only the flat, agent-facing fields; everything else is
// either filled in mechanically (id, by, at, the anchor nesting) or the human's alone (status, and the
// thread that records the conversation). Letting them through is how an agent forged a DECISION the
// human never made — `add` with status:"accepted" archived a card as decided while the document was
// never spliced (the 2026-07-23 audit's "the one that matters"). So the keys are allow-listed and
// anything else is refused BY NAME, nothing written. This is not a --force-able warning: it is the
// proposes-vs-decides boundary the whole tool exists to keep legible.
const ADD_KEYS = ['quote', 'text', 'replacement', 'note', 'occurrence', 'replyTo', 'flag', 'kind'];
const ADD_REFUSAL = {
  status: 'decisions and their record belong to the human — an agent proposes, it never sets a status (use `sidecar reply` to add a message).',
  thread: 'decisions and their record belong to the human — `add` never writes a thread wholesale (use `sidecar reply` to add a message).',
  id:     'ids are generated — use `sidecar suggest --id <id>` to revise an existing card.',
  anchor: 'pass `quote` (and `occurrence` if it is ambiguous); the CLI builds the anchor.',
  by:     'refused — an agent cannot author an item as someone else; `by` is always whoever ran the command.',
};
function cmdAdd(argv) {
  const { flags, positional } = parseArgs(argv, ['force']);
  const abs = resolveFile(positional[0]);
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch (e) { die(`could not parse JSON on stdin: ${e.message}\n\nusage: sidecar add <file> <<'JSON'\n[{"kind":"comment","quote":"…","text":"…"}]\nJSON`, 2); }
  if (!Array.isArray(input)) die('stdin must be a JSON array of items', 2);

  const problems = [];
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`item ${i}: not a JSON object`); return; }
    for (const key of Object.keys(raw)) {
      if (ADD_KEYS.includes(key)) continue;
      problems.push(`item ${i}: "${key}" — ${ADD_REFUSAL[key] || 'not a field `add` accepts'}`);
    }
  });
  if (problems.length)
    die('refused — nothing written:\n' + problems.map(p => '  ' + p).join('\n') +
        `\n\n\`add\` accepts only: ${ADD_KEYS.join(', ')}.`);

  const review = loadReview(abs);
  const now = new Date().toISOString();
  const items = input.map(raw => {
    const kind = raw.kind || (raw.replacement !== undefined ? 'suggestion' : 'comment');
    const seed = (raw.quote || '') + (raw.replacement || raw.text || '');
    const base = {
      id: freshId(review, kind === 'suggestion' ? 's' : 'c', seed, raw.quote || seed),
      kind, by: AGENT,   // never the caller's — an agent must not author items as the human
      anchor: { quote: raw.quote, ...(raw.occurrence !== undefined ? { occurrence: raw.occurrence } : {}) },
      ...(raw.flag ? { flag: true } : {}),
      ...(raw.replyTo ? { replyTo: raw.replyTo } : {}),
    };
    if (kind === 'suggestion') return { ...base, replacement: raw.replacement, ...(raw.note ? { note: raw.note } : {}), status: 'pending' };
    return { ...base, status: 'open', thread: [{ by: AGENT, at: now, text: raw.text }] };
  });
  applyItems(abs, items, { force: flags.force });
}

// ---------- read verbs ----------

// The COMPLETE current state, compactly. `wait` reports only the single event that woke it — other
// comments stack up unreported, which silently buried five of Alex's comments on 2026-07-22. This is
// the command that makes "read everything each pass" cheap instead of something to remember.
function cmdShow(argv) {
  const { flags, positional } = parseArgs(argv, ['needs-reply', 'json']);
  const abs = resolveFile(positional[0]);
  const raw = fs.readFileSync(abs, 'utf8');
  const review = loadReview(abs);
  if (annotateOrphans(raw, review)) saveReview(abs, review);   // same as /api/state, so both sides agree

  const needsReply = (it) => ['open', 'orphaned'].includes(it.status) &&
    (it.thread || []).length && (it.thread[it.thread.length - 1].by !== AGENT);
  const items = flags['needs-reply'] ? review.items.filter(needsReply) : review.items;

  if (flags.json) { console.log(JSON.stringify({ ...review, items }, null, 2)); return; }

  const rel = path.basename(abs);
  if (!items.length) { console.log(`${rel} — ${flags['needs-reply'] ? 'nothing awaiting you' : 'no review items'}`); }
  else {
    const waiting = review.items.filter(needsReply).length;
    console.log(`${rel} — ${review.items.length} item${review.items.length > 1 ? 's' : ''}` +
      (waiting ? `, ${waiting} awaiting you` : ''));
    for (const it of items) {
      const badge = it.status.toUpperCase() + (it.flag ? ' FLAG' : '') + (it.replyTo ? ` →${it.replyTo}` : '');
      console.log(`\n▸ ${it.id}  ${it.kind}  ${badge}${needsReply(it) ? '   ← needs reply' : ''}`);
      console.log(`  @ "${clip(it.anchor && it.anchor.quote, 70)}"` +
        (it.status === 'orphaned' ? `  [${it.orphanReason === 'never-matched' ? 'never matched — bad anchor' : 'text changed'}]` : ''));
      if (it.kind === 'suggestion') console.log(`  → "${clip(it.replacement, 70)}"` + (it.note ? `\n  note: ${clip(it.note, 70)}` : ''));
      for (const m of (it.thread || [])) console.log(`  ${m.by}: ${clip(m.text, 70)}`);
    }
  }
  let diff = '';
  try { diff = execFileSync('git', ['diff', '--stat', '--', path.basename(abs)], { cwd: path.dirname(abs), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  if (diff) console.log(`\nuncommitted changes to the doc:\n  ${diff.split('\n').join('\n  ')}`);
  console.log(`\nDONE: ${!!(review.session && review.session.done)}`);
}

// The DELTA since this agent last looked, against the persisted cursor (lib/digest.js). `show` is the
// full-state view; `digest` reports only what's unseen — decisions, new human comments/replies, orphans,
// the doc diff — and advances the cursor so the next call starts from here. `--peek` reads without
// advancing; `--json` emits the structured delta. Empty delta → "nothing new since <at>".
function cmdDigest(argv) {
  const { flags, positional } = parseArgs(argv, ['peek', 'json']);
  const abs = resolveFile(positional[0]);
  const raw = fs.readFileSync(abs, 'utf8');
  const review = loadReview(abs);
  if (annotateOrphans(raw, review)) saveReview(abs, review);   // same annotate as show/state so all three agree
  const cursor = (loadSeen(abs) || {})[AGENT] || null;
  const d = computeDigest(cursor, review, raw, AGENT, loadBaseline(abs, AGENT));
  console.log(flags.json ? JSON.stringify(d, null, 2) : renderDigest(d));
  if (!flags.peek) saveSeen(abs, AGENT, d.snapshot, raw);   // baseline advances with the cursor; --peek advances neither
}

// Pre-flight a candidate quote (--quote), or lint every anchor already in the sidecar (bare).
function cmdCheck(argv) {
  const { flags, positional } = parseArgs(argv, ['quote', 'occurrence']);
  const abs = resolveFile(positional[0]);
  const raw = fs.readFileSync(abs, 'utf8');

  if (flags.quote) {
    const hits = Anchor.findAll(raw, flags.quote);
    if (!hits.length) {
      // Bisect to the longest matching prefix — "it doesn't match" is useless; "it dies at word 21"
      // points straight at the block boundary or typo that broke it.
      const words = flags.quote.split(/\s+/);
      let lo = 1, hi = words.length, best = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1;
        if (Anchor.findAll(raw, words.slice(0, mid).join(' ')).length) { best = mid; lo = mid + 1; } else hi = mid - 1; }
      console.error(`no match (0 hits)\n  longest matching prefix: ${best}/${words.length} words` +
        (best ? `\n  stops after: "…${clip(words.slice(Math.max(0, best - 6), best).join(' '), 50)}"\n  breaks at: "${words[best]}"` : ''));
      process.exit(1);
    }
    console.log(`${hits.length} match${hits.length > 1 ? 'es' : ''}` +
      (hits.length > 1 ? ` — pass --occurrence 0..${hits.length - 1}` : ' — unambiguous, safe to anchor'));
    hits.forEach((h, n) => console.log(`  [${n}] …${clip(raw.slice(Math.max(0, h.start - 30), h.end + 30), 100)}…`));
    return;
  }

  const review = loadReview(abs);
  if (!review.items.length) { console.log('no review items to check'); return; }
  let bad = 0;
  for (const it of review.items) {
    const hits = Anchor.findAll(raw, (it.anchor || {}).quote || '');
    const want = (it.anchor || {}).occurrence || 0;
    const ok = hits.length > want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'MISS'} ${it.id}  ${hits.length} hit${hits.length === 1 ? '' : 's'}` +
      (ok && hits.length > 1 ? ` (using occurrence ${want})` : '') + `  @ "${clip((it.anchor || {}).quote, 50)}"`);
  }
  if (bad) { console.error(`\n${bad} anchor${bad > 1 ? 's' : ''} cannot resolve — reanchor or drop.`); process.exit(1); }
}

// The digest keeps per-agent state beside the document: `<doc>.review.seen.json` (the cursor) and
// `<doc>.review.seen.base.<agent>` (its copy of the doc text). sidecar never writes a host repo's
// .gitignore, on purpose, so the only thing keeping that state out of someone's commit is the host
// having added the pattern. SKILL.md says to add it; this is what notices when nobody did.
//
// Probing a NAME rather than a real file is deliberate: the answer has to be right before any state
// exists, which is the only moment where saying it still helps. `git check-ignore -q` exits 0 when the
// path is ignored and 1 when it is not; any other status is git failing to answer, and a warning
// nobody can act on is worse than silence.
function ignoreWarning(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  try { git(['rev-parse', '--is-inside-work-tree']); } catch { return null; }   // no repo, nothing to ignore
  try { git(['check-ignore', '-q', path.join(dir, 'x.md.review.seen.json')]); return null; }
  catch (e) { if (e.status !== 1) return null; }
  return `\n⚠ agent state is committable here: add  *.review.seen*  to .gitignore in ${dir}` +
         `\n  (the digest's cursor and doc baseline sit beside the document; they are yours, not the review's)`;
}

// Everything you'd otherwise discover with curl + lsof + launchctl + tailscale serve status.
async function cmdDoctor(argv) {
  const { positional } = parseArgs(argv, []);
  // The doc named on the command line decides which directory gets checked, since that is where its
  // state files land. Bare `doctor` has only the cwd to go on.
  const target = positional[0] ? path.resolve(process.cwd(), positional[0]) : process.cwd();
  const docDir = (() => { try { return fs.statSync(target).isDirectory() ? target : path.dirname(target); }
                          catch { return path.dirname(target); } })();
  const localDir = path.join(__dirname, '..');
  const localVersion = (() => { try { return require(path.join(localDir, 'package.json')).version || '?'; } catch { return '?'; } })();
  const localStamp = (() => {
    // stdio: git prints "fatal: not a git repository" to the inherited stderr before we can catch —
    // noise on every npm install, which is not a git checkout by construction.
    let s = 'nogit'; try { s = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: localDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
    let mt = ''; try { mt = fs.statSync(path.join(localDir, 'server.js')).mtime.toISOString().slice(0, 19).replace('T', ' '); } catch {}
    return s + (mt ? ' · ' + mt : '');
  })();
  console.log(`this cli:      v${localVersion} · ${localStamp}`);

  let running = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/files`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) running = await r.json();
  } catch {}
  if (!running) {
    console.log(`server:        NOT RUNNING on :${PORT}`);
    console.log(`               start it with:  npx sidecar <dir>`);
    console.log(`\nThe CLI still works — the filesystem is the sync layer. A server is only needed for the human's browser.`);
    const warn = ignoreWarning(docDir); if (warn) console.log(warn);
    return;
  }
  const probe = running.defaultFile || (running.files[0] || {}).rel;
  let liveStamp = '?', pwd = '?', liveDir = '', liveVersion = '';
  if (probe) {
    try { const s = await (await fetch(`http://127.0.0.1:${PORT}/api/state?path=${encodeURIComponent(probe)}`)).json();
      liveStamp = s.code; pwd = s.pwd; liveDir = s.codeDir || ''; liveVersion = s.version || ''; } catch {}
  }
  console.log(`server:        running on :${PORT}  (${running.files.length} markdown file${running.files.length === 1 ? '' : 's'})`);

  // STALE means "this server is running code older than what is on disk" — which is only knowable
  // when the server was launched from THIS installation. Running `doctor` from an npm/npx copy of the
  // CLI against a server started elsewhere compared two unrelated stamps and reported STALE forever.
  // Servers older than 1.2.1 send no codeDir; say so rather than guessing.
  const sameInstall = liveDir && path.resolve(liveDir) === path.resolve(localDir);
  let note = '';
  if (liveStamp === '?') note = '';
  else if (sameInstall) note = liveStamp !== localStamp ? '   ⚠ STALE — restart to pick up your edits' : '   ✓ current';
  else if (!liveDir) note = '   (server predates 1.2.1 — cannot tell which installation it runs; restart it to compare)';
  else if (liveVersion && liveVersion !== localVersion) note = `   ⚠ server runs v${liveVersion}, this cli is v${localVersion}`;
  else note = '   (a different installation — not comparable)';
  console.log(`live code:     ${liveStamp}${note}`);
  if (liveDir && !sameInstall) console.log(`  server ran from:  ${liveDir}\n  this cli lives:   ${localDir}`);
  if (probe) console.log(`serving near:  ${pwd}`);

  let tailnet = '';
  try {
    const out = execFileSync('tailscale', ['serve', 'status'], { timeout: 2000 }).toString();
    const host = (out.match(/https:\/\/[^\s]+/) || [])[0];
    if (host && out.includes(`:${PORT}`)) tailnet = host.replace(/\/$/, '');
  } catch {}

  const f = positional[0];
  const q = f ? `/?f=${encodeURIComponent(f)}` : '/';
  console.log(`\ndesk:          http://localhost:${PORT}${q}`);
  console.log(tailnet ? `phone:         ${tailnet}${q}`
                      : `phone:         not exposed (run scripts/tailscale-serve.sh to proxy :${PORT} onto your tailnet)`);
  const warn = ignoreWarning(docDir); if (warn) console.log(warn);
}

// The protocol, on stdout. An agent that has the package can read the whole thing in one call —
// npx unpacks into ~/.npm/_npx/<hash>/, which nothing scans, so shipping SKILL.md in the tarball
// is not the same as an agent ever finding it. Prints the file verbatim so the output stays
// pipeable; the version on disk is the version of the code that is running.
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'sidecar', 'SKILL.md');
function cmdSkill(argv) {
  parseArgs(argv, []);
  if (!fs.existsSync(SKILL_PATH))
    die(`SKILL.md is missing from this install (looked in ${SKILL_PATH}).\nRead it at https://github.com/smithavt14/sidecar/blob/main/skills/sidecar/SKILL.md`);
  process.stdout.write(fs.readFileSync(SKILL_PATH, 'utf8'));
}

// No-args `sidecar` serves the cwd, so this is the only place a first-time reader is handed the
// skill. Both routes to it, because they solve different problems: `skills add` installs it where
// the agent looks by itself, `sidecar skill` needs no install.
const USAGE = `sidecar — review documents with your AI agent, locally.

  sidecar <file-or-dir>              serve it at http://localhost:${PORT}

Give your agent the protocol:
  npx skills add smithavt14/sidecar  install the skill where your agent looks
  sidecar skill                      print the same protocol to stdout

Commands (every one takes the document as its first argument):
  doctor    is a server running, on what code, which URLs to hand over
  show      the complete review state          check     do all anchors still resolve
  comment   ask about a span                   flag      the same, marked as blocking
  suggest   propose a replacement              answer    answer a comment with an edit
  reply     add to a thread                    resolve   close a thread you opened
  reanchor  move an item to a new quote        drop      remove items
  add       write several items from JSON on stdin
  wait      block until the human acts         digest    what changed since you last looked

comment and reply take --image <path> (repeatable) to attach a screenshot.

Every verb prints its own usage when called wrong. Full protocol: sidecar skill`;

function cmdHelp() { console.log(USAGE); }

// ---------- wait (moved verbatim from server.js) ----------
const runWait = require('./wait.js');

// ---------- dispatch ----------
function run(cmd, argv) {
  switch (cmd) {
    case 'wait': return runWait(argv);
    case 'digest': return cmdDigest(argv);
    case 'show': return cmdShow(argv);
    case 'check': return cmdCheck(argv);
    case 'comment': return cmdComment(argv);
    case 'flag': return cmdComment(argv, { flag: true });
    case 'suggest': return cmdSuggest(argv);
    case 'answer': return cmdAnswer(argv);
    case 'reanchor': return cmdReanchor(argv);
    case 'reply': return cmdReply(argv);
    case 'resolve': return cmdResolve(argv);
    case 'drop': return cmdDrop(argv);
    case 'add': return cmdAdd(argv);
    case 'doctor': return cmdDoctor(argv);
    case 'skill': return cmdSkill(argv);
    case 'help': return cmdHelp();
  }
}

module.exports = { isCommand, run, COMMANDS, SKILL_PATH, MARKDOWN };
