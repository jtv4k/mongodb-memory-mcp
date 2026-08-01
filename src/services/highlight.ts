/**
 * Snippet extraction and safe rendering of highlighted text.
 *
 * MongoDB Search gives us highlights for free, but only on the text leg. A
 * vector-only search — the default first-run experience, and every search that
 * degrades because the text index is still building — has none, and a results
 * page that shows the first 240 characters of every chunk is useless. So we find
 * the window of the chunk that actually talks about the query and show that.
 *
 * ## The escaping rule
 *
 * `renderFragmentHtml` is a security boundary, not a convenience. Chunk text is
 * ingested content: an AI client uploaded it, it is never sanitised on the way
 * in (we store it verbatim on purpose), and it is rendered into a server-side
 * EJS page. Every character of it therefore goes
 * through {@link escapeHtml} before it is concatenated into markup, and the only
 * unescaped bytes in the output are the `<mark>` tags this module writes itself.
 *
 * Note the ordering: matches are located in the *raw* fragment and each segment
 * is escaped as it is emitted, rather than escaping the whole string first and
 * then running a replace over the result. Both are safe, but searching the
 * escaped string means a query for `amp`, `lt` or `quot` matches inside the
 * entities we just produced and mangles them — and, more importantly, it puts
 * the highlighting step in the position of editing markup, which is precisely
 * the shape of code that grows an injection bug later.
 *
 * Pure functions, no I/O.
 */

const DEFAULT_MAX_FRAGMENTS = 2;
const DEFAULT_FRAGMENT_CHARS = 240;
const MIN_FRAGMENT_CHARS = 40;

const MIN_TERM_CHARS = 2;
const MAX_QUERY_TERMS = 12;
/** Cap per term so a query word that appears everywhere stays linear-ish. */
const MAX_MATCHES_PER_TERM = 32;
/** How far a fragment edge may move to avoid slicing through a word. */
const WORD_BOUNDARY_BUDGET = 24;

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const NON_WORD_RUN = /[^\p{L}\p{N}_]+/u;
const WHITESPACE = /\s/u;
const WHITESPACE_RUN = /\s+/gu;

/**
 * Words that would anchor a snippet on nothing. Deliberately short: an
 * aggressive stoplist hurts more than it helps on technical content.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export interface HighlightOptions {
  /** How many windows to return. Default 2. */
  maxFragments?: number;
  /** Target width of each window in characters. Default 240. */
  fragmentChars?: number;
}

/**
 * Escape text for interpolation into HTML *content or an attribute value*.
 *
 * Both quote styles are escaped, so the result is safe inside `<p>…</p>` and
 * inside `attr="…"` / `attr='…'` alike. It is NOT safe inside a `<script>`, a
 * `<style>`, or an unquoted attribute — do not use it there.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Split a query into the distinct words worth highlighting.
 *
 * Falls back to the unfiltered tokens when everything was a stopword, so a
 * search for "how to" still highlights something rather than nothing.
 */
export function extractQueryTerms(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(NON_WORD_RUN)
    .filter((token) => token.length > 0);

  const meaningful = tokens.filter(
    (token) => token.length >= MIN_TERM_CHARS && !STOPWORDS.has(token),
  );

  return [...new Set(meaningful.length > 0 ? meaningful : tokens)].slice(0, MAX_QUERY_TERMS);
}

/**
 * Pick the best-matching windows of `text` for `query`, as plain text.
 *
 * Windows are ranked by how many *distinct* query terms they contain, so a
 * snippet covering three different words beats one that repeats a single common
 * word five times, and they are returned best-first (the same convention MongoDB
 * Search uses for its own highlights). Elided edges are marked with an ellipsis.
 *
 * When the query matches nothing — or is all punctuation — the head of the text
 * is returned instead, because a preview is still more useful than a blank cell.
 */
export function buildHighlightFragments(
  text: string,
  query: string,
  options: HighlightOptions = {},
): string[] {
  if (text.trim().length === 0) return [];

  const fragmentChars = Math.max(
    MIN_FRAGMENT_CHARS,
    options.fragmentChars ?? DEFAULT_FRAGMENT_CHARS,
  );
  const maxFragments = Math.max(1, options.maxFragments ?? DEFAULT_MAX_FRAGMENTS);

  const terms = extractQueryTerms(query);
  let remaining = terms.length > 0 ? findMatches(text, terms) : [];
  if (remaining.length === 0) {
    return [sliceFragment(text, 0, Math.min(text.length, fragmentChars))];
  }

  const fragments: string[] = [];
  while (fragments.length < maxFragments && remaining.length > 0) {
    const window = bestWindow(remaining, text.length, fragmentChars);
    fragments.push(sliceFragment(text, window.start, window.end));
    remaining = remaining.filter((match) => match.end <= window.start || match.start >= window.end);
  }

  return fragments;
}

/**
 * Render one fragment as HTML with query terms wrapped in `<mark>`.
 *
 * See the module docblock: the text is escaped, the tags are ours, and nothing
 * from the corpus can introduce markup.
 */
export function renderFragmentHtml(fragment: string, query: string): string {
  const terms = extractQueryTerms(query);
  const ranges = mergeRanges(terms.length > 0 ? findMatches(fragment, terms) : []);

  let html = '';
  let cursor = 0;

  for (const range of ranges) {
    html += escapeHtml(fragment.slice(cursor, range.start));
    html += `<mark>${escapeHtml(fragment.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }

  return html + escapeHtml(fragment.slice(cursor));
}

/** Convenience for the view layer: {@link renderFragmentHtml} over a list. */
export function renderFragmentsHtml(fragments: readonly string[], query: string): string[] {
  return fragments.map((fragment) => renderFragmentHtml(fragment, query));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface TermMatch {
  term: string;
  start: number;
  end: number;
}

interface Range {
  start: number;
  end: number;
}

interface ScoredWindow extends Range {
  score: number;
}

/**
 * Locate every term occurrence that starts on a word boundary.
 *
 * Prefix matching is deliberate — "chunk" should light up "chunking" — but a
 * match in the middle of a word ("unk" in "chunk") is noise, so the character
 * before the match must be a non-word character.
 */
function findMatches(text: string, terms: readonly string[]): TermMatch[] {
  const haystack = text.toLowerCase();
  const matches: TermMatch[] = [];

  for (const term of terms) {
    let from = 0;
    let found = 0;

    while (found < MAX_MATCHES_PER_TERM) {
      const start = haystack.indexOf(term, from);
      if (start < 0) break;
      from = start + term.length;

      if (!startsWord(haystack, start)) continue;
      matches.push({ term, start, end: start + term.length });
      found += 1;
    }
  }

  return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

function startsWord(haystack: string, start: number): boolean {
  if (start === 0) return true;
  const previous = haystack[start - 1];
  return previous === undefined || !WORD_CHARACTER.test(previous);
}

/** The window covering the most distinct terms; earliest position wins ties. */
function bestWindow(
  matches: readonly TermMatch[],
  textLength: number,
  fragmentChars: number,
): ScoredWindow {
  // Leave a quarter of the window in front of the anchor so the reader gets the
  // run-up to the match rather than starting on it.
  const lead = Math.floor(fragmentChars / 4);
  const lastStart = Math.max(0, textLength - fragmentChars);
  let best: ScoredWindow = { start: 0, end: Math.min(textLength, fragmentChars), score: -1 };

  for (const anchor of matches) {
    const start = Math.max(0, Math.min(anchor.start - lead, lastStart));
    const end = Math.min(textLength, start + fragmentChars);
    const inside = matches.filter((match) => match.start >= start && match.end <= end);
    const distinct = new Set(inside.map((match) => match.term)).size;

    // Distinct terms dominate; total occurrences only break ties.
    const score = distinct + inside.length * 0.001;
    if (score > best.score) best = { start, end, score };
  }

  return best;
}

function sliceFragment(text: string, start: number, end: number): string {
  const from = start === 0 ? 0 : snapForward(text, start);
  const to = end >= text.length ? text.length : snapBackward(text, end);
  const body = text.slice(from, to).replace(WHITESPACE_RUN, ' ').trim();

  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}

function snapForward(text: string, index: number): number {
  const limit = Math.min(text.length, index + WORD_BOUNDARY_BUDGET);
  for (let i = index; i < limit; i += 1) {
    const character = text[i];
    if (character !== undefined && WHITESPACE.test(character)) return i + 1;
  }
  return index;
}

function snapBackward(text: string, index: number): number {
  const limit = Math.max(0, index - WORD_BOUNDARY_BUDGET);
  for (let i = index; i > limit; i -= 1) {
    const character = text[i];
    if (character !== undefined && WHITESPACE.test(character)) return i;
  }
  return index;
}

/** Overlapping or adjacent matches become one `<mark>` instead of nested ones. */
function mergeRanges(matches: readonly TermMatch[]): Range[] {
  const ranges: Range[] = [];

  for (const match of matches) {
    const last = ranges[ranges.length - 1];
    if (last && match.start <= last.end) {
      last.end = Math.max(last.end, match.end);
      continue;
    }
    ranges.push({ start: match.start, end: match.end });
  }

  return ranges;
}
