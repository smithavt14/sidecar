/* sidecar. How much a suggestion changed, and what to say about it. Loaded by the browser via
   <script> and required by the Node tests, the same pattern public/anchor.js and public/turn.js use,
   so the rule the rail prints and the rule the document renders are one function.

   A pending suggestion is drawn IN the document now, at its anchor, and how it is drawn depends on how
   much of the sentence survives. A two-word fix reads as tracked changes inside the paragraph; a full
   rewrite cannot, because alternating struck and highlighted words leave neither version readable. So
   there are two kinds and one classifier:

     edit:     a few words moved. Inline del/ins inside the prose.
     rewrite:  more than half the words changed, or the change crosses a sentence boundary.
                Three views: the new text in place, the original, or both stacked.

   Everything here is PURE strings in, strings out. No DOM, no dependency: the word diff is its own
   LCS rather than the page's `diff` bundle, so Node can require this file directly and the rule cannot
   drift between the two sides. A caller that already has `Diff.diffWords` output can pass it instead
   and the same counting runs over it. */
(function (root) {
  // A word is a run of non-space. Punctuation rides along with the word it touches, which is what makes
  // "cat." and "cat" count as a change: the reader sees one too.
  function words(s) {
    return String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
  }

  // ---------- the token diff the inline preview is drawn from ----------
  // The tracked-change view renders each fragment of the diff on its own, so a fragment boundary that
  // falls INSIDE a markdown delimiter pair prints the delimiter literally: `**bold** text` against
  // `**strong** text` diffs at word boundaries, which puts `**` in one fragment and `bold` in the next,
  // and the paragraph shows a pair of asterisks it never had. A code span, a link and `~~` all break
  // the same way.
  //
  // So the diff runs over TOKENS where a whole inline-markdown construct is one token and can never be
  // split. `**bold**` moves as a unit, which is also what the reader means: you cannot half-change a
  // bold run. Anything the tokenizer does not recognise falls back to words and spaces, and `splittable`
  // below is the guard for that case.
  // The closing delimiter may not be preceded by a space, which is CommonMark's own rule: `*an aside *`
  // is not emphasis and marked renders it as the literal characters. A looser pattern swallowed exactly
  // that shape as a construct, and `balanced` below then called a fragment safe that printed asterisks.
  const MD_RUN = /\*\*[^*\s](?:[^*]*[^*\s])?\*\*|__[^_\s](?:[^_]*[^_\s])?__|~~[^~\s](?:[^~]*[^~\s])?~~|`[^`]+`|\*[^*\s](?:[^*]*[^*\s])?\*|_[^_\s](?:[^_]*[^_\s])?_|!?\[[^\]]*\]\([^)\s]*(?:\s+"[^"]*")?\)/;
  function tokenize(s) {
    const t = String(s == null ? '' : s);
    const out = [];
    let i = 0;
    while (i < t.length) {
      const rest = t.slice(i);
      const m = MD_RUN.exec(rest);
      if (m && m.index === 0) { out.push(m[0]); i += m[0].length; continue; }
      // Plain text up to the next construct, split into words and the whitespace between them so the
      // diff lands on word boundaries the way the rail's own diff does.
      const upto = m ? i + m.index : t.length;
      for (const piece of t.slice(i, upto).split(/(\s+)/)) if (piece) out.push(piece);
      i = upto;
    }
    return out;
  }

  // A standard LCS with a backtrace, over token arrays. `Diff.diffWords` cannot be used here because it
  // is the thing that splits the delimiters, and Node has no `diff` bundle loaded in this module, so one
  // implementation serves the page and the tests.
  function diffTokens(quote, replacement) {
    const a = tokenize(quote), b = tokenize(replacement);
    const n = a.length, m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const parts = [];
    const push = (value, kind) => {
      const last = parts[parts.length - 1];
      if (last && last.added === (kind === 'added') && last.removed === (kind === 'removed')) last.value += value;
      else parts.push({ value, added: kind === 'added', removed: kind === 'removed' });
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push(a[i], 'common'); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push(a[i], 'removed'); i++; }
      else { push(b[j], 'added'); j++; }
    }
    while (i < n) push(a[i++], 'removed');
    while (j < m) push(b[j++], 'added');
    return parts;
  }

  // Is every fragment safe to render on its own? A delimiter that opens inside one and closes in the
  // next is what prints literal markers, and the tokenizer only recognises the constructs it knows, so
  // this is the guard that catches the rest (nested emphasis, an unbalanced marker an author left). A
  // fragment that fails it makes the whole change a `rewrite`, which renders each side whole and cannot
  // split anything.
  // Take out every construct that closes inside the fragment; what is left may not contain anything
  // that OPENS one. Counting delimiters instead is not enough and was the first version of this: two
  // asterisks either side of a space are an even number and are still two literal asterisks on the page.
  const MD_RUN_G = new RegExp(MD_RUN.source, 'g');
  function balanced(s) {
    const rest = String(s).replace(MD_RUN_G, '');
    if (/[*_`~]/.test(rest)) return false;
    if ((rest.match(/\[/g) || []).length !== (rest.match(/\]/g) || []).length) return false;
    return true;
  }
  function splittable(parts) {
    return parts.every(p => balanced(p.value));
  }

  // Longest common subsequence LENGTH over two word arrays. O(n*m) on two sentences is nothing, and the
  // length is all the ratio needs; the actual alignment is the page's `Diff.diffWords` job.
  function commonWords(a, b) {
    const rows = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let prev = 0;
      for (let j = 1; j <= b.length; j++) {
        const tmp = rows[j];
        rows[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(rows[j], rows[j - 1]);
        prev = tmp;
      }
    }
    return rows[b.length];
  }

  // How much of the old text survives, as a fraction of the longer side. Measured against the LONGER of
  // the two on purpose: replacing one word with a whole paragraph changed most of what ends up on the
  // page even though every original word survived.
  function changedRatio(quote, replacement, parts) {
    const a = words(quote), b = words(replacement);
    if (!a.length && !b.length) return 0;
    const span = Math.max(a.length, b.length, 1);
    const common = parts ? countCommon(parts) : commonWords(a, b);
    return 1 - Math.min(common, span) / span;
  }
  // The same count off a `Diff.diffWords` parts array, for a caller that already has one.
  function countCommon(parts) {
    let n = 0;
    for (const p of parts) if (!p.added && !p.removed) n += words(p.value).length;
    return n;
  }

  // A sentence ends at . ! or ? followed by whitespace or the end of the string, allowing a closing
  // quote or bracket to sit between. Kept as one regex both halves read, so the count and the
  // boundary test can never disagree about what a sentence is.
  const SENT_END = /[.!?]["'’”)\]]*(?=\s|$)/g;
  function sentenceCount(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return 0;
    SENT_END.lastIndex = 0;
    let n = 0, end = 0, m;
    while ((m = SENT_END.exec(t))) { n++; end = m.index + m[0].length; }
    // Text after the last terminator is a sentence too, and so is a quote that carries none at all
    // ("fix this" is one thing to read).
    if (t.slice(end).trim()) n++;
    return Math.max(n, 1);
  }

  // Does the change cross from one sentence into another? Only the CHANGED REGION is asked: an edit to
  // the second sentence of a three-sentence quote is still an edit, while one that rewrites the end of
  // one sentence and the start of the next cannot be shown as tracked changes without reading as noise.
  function crossesSentence(quote, replacement) {
    const a = String(quote == null ? '' : quote), b = String(replacement == null ? '' : replacement);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head
      && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const oldMid = a.slice(head, a.length - tail), newMid = b.slice(head, b.length - tail);
    return hasInternalBoundary(oldMid) || hasInternalBoundary(newMid);
  }
  // A boundary INSIDE the region, rather than one closing it: a changed region that ends on a full stop
  // stays inside its own sentence.
  function hasInternalBoundary(s) {
    const t = String(s).replace(/\s+$/, '');
    SENT_END.lastIndex = 0;
    let m;
    while ((m = SENT_END.exec(t))) if (m.index + m[0].length < t.length) return true;
    return false;
  }

  // The verdict. `parts` is optional Diff.diffWords output; without it the LCS above answers.
  // The third rule is not about size at all: a change whose fragments cannot each be rendered on their
  // own has to be a rewrite, because a rewrite renders each side whole and is the only shape that can
  // carry inline markdown the word diff would have torn in half.
  function classify(quote, replacement, parts) {
    if (changedRatio(quote, replacement, parts) > 0.5) return 'rewrite';
    if (crossesSentence(quote, replacement)) return 'rewrite';
    if (!splittable(diffTokens(quote, replacement))) return 'rewrite';
    return 'edit';
  }

  // Cut a string to `max` characters on a word boundary where there is one, with an ellipsis. Used by
  // the rail's one-line summary, where the card is about 300px wide and the point is the shape of the
  // change rather than the text of it.
  function clip(s, max) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '') + '…';
  }

  // The rail's one line about a suggestion whose span is drawn in the document. An edit says what it
  // does; a rewrite says how much of the document it touches, because the words themselves are in the
  // paragraph a few centimetres to the left.
  function summary(quote, replacement, parts) {
    if (classify(quote, replacement, parts) === 'rewrite') {
      const n = Math.max(sentenceCount(quote), 1);
      return 'Rewrites ' + n + (n === 1 ? ' sentence' : ' sentences');
    }
    const a = String(quote == null ? '' : quote), b = String(replacement == null ? '' : replacement);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    // Back up to the start of the word the two texts diverge inside, so the line reads as whole words.
    while (head > 0 && !/\s/.test(a[head - 1])) head--;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head
      && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    while (tail > 0 && !/\s/.test(a[a.length - tail])) tail--;
    const from = clip(a.slice(head, a.length - tail), 34);
    const to = clip(b.slice(head, b.length - tail), 34);
    // An insertion has no `from` and a deletion has no `to`; an arrow with nothing on one side of it
    // still says which way the change runs, so both are kept rather than special-cased into prose.
    return (from || '""') + ' → ' + (to || '""');
  }

  const API = { classify, summary, words, sentenceCount, changedRatio, crossesSentence, clip,
    tokenize, diffTokens, balanced, splittable };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.Sugview = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
