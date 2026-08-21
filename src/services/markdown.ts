/**
 * A deliberately small markdown renderer for displaying stored documents.
 *
 * ## The security contract, which is the whole reason this module exists
 *
 * Document content is whatever an AI client uploaded, stored verbatim and never
 * sanitised on the way in. Everywhere else in the UI that content reaches a
 * template through `<%= %>` and is escaped by EJS. Rendering markdown means
 * emitting HTML instead, so this module takes over that duty and follows the
 * same rule `services/highlight.ts` follows for `<mark>`:
 *
 *   **Nothing from the source is ever copied into the output as markup.**
 *
 * Concretely:
 *   - Every span of source text passes through `escapeHtml` before it is placed
 *     in the output. There is no path that emits source characters unescaped.
 *   - Regexes only ever run over RAW source, never over already-escaped HTML.
 *     Matching `**bold**` against escaped text would let `&amp;` fragments and
 *     entity boundaries be re-interpreted as syntax, and any bug there becomes
 *     an injection rather than a formatting glitch.
 *   - Raw HTML in the source is NOT passed through. `<script>` in a document is
 *     text that reads `<script>`, exactly as it does in the raw view.
 *   - The emitted tag set is a fixed allowlist written literally in this file.
 *     The only attributes ever produced are `class` (from constants here),
 *     `href` (validated, see below) and the fixed `rel` beside it.
 *   - No inline `style` attributes: the page's CSP is `style-src 'self'` with no
 *     `'unsafe-inline'`, so an inline style would be dropped anyway.
 *
 * A strict CSP (`default-src 'none'`) backs this up rather than replacing it.
 *
 * ## Why images are links
 *
 * `img-src` is `'self' data:`, so an `<img>` pointing at a third-party host
 * renders as a broken image — and would be a tracking beacon fired by merely
 * viewing a document somebody else ingested. Image syntax therefore becomes a
 * link labelled with its alt text. The information survives; the request does
 * not happen until the reader chooses it.
 *
 * ## The supported subset, and what is deliberately missing
 *
 * ATX and setext headings, fenced code, blockquotes, thematic breaks, ordered
 * and unordered lists (nested by indentation), pipe tables, paragraphs, and
 * inline code / strong / emphasis / links / images.
 *
 * Not supported, on purpose: indented (4-space) code blocks, reference-style
 * links, footnotes, inline HTML, autolinks, strikethrough, task lists, nested
 * blockquotes. Each is more surface for no gain on the corpus this displays, and
 * anything unrecognised degrades to a paragraph of escaped text rather than
 * disappearing. The raw view is always one click away, which is what makes an
 * imperfect renderer acceptable here: it is a convenience over the source, never
 * a replacement for it.
 */
import { scanLines, type SourceLine } from '../chunking/markdown.js';

/** The one place source characters become HTML-safe. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

const CLASS = {
  h1: 'mt-6 mb-3 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50',
  h2: 'mt-6 mb-2 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50',
  h3: 'mt-5 mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100',
  h4: 'mt-4 mb-1 text-base font-semibold text-slate-900 dark:text-slate-100',
  h5: 'mt-4 mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100',
  h6: 'mt-4 mb-1 text-sm font-semibold text-slate-600 dark:text-slate-400',
  p: 'my-3 leading-relaxed text-slate-800 dark:text-slate-200',
  ul: 'my-3 list-disc space-y-1 pl-6 text-slate-800 dark:text-slate-200',
  ol: 'my-3 list-decimal space-y-1 pl-6 text-slate-800 dark:text-slate-200',
  li: 'leading-relaxed',
  pre: 'my-4 overflow-x-auto rounded-lg bg-slate-100 p-3 font-mono text-xs leading-relaxed text-slate-800 dark:bg-slate-950 dark:text-slate-200',
  code: 'rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  quote:
    'my-4 border-l-4 border-slate-300 pl-4 text-slate-700 italic dark:border-slate-700 dark:text-slate-300',
  hr: 'my-6 border-slate-200 dark:border-slate-800',
  tableWrap: 'my-4 overflow-x-auto',
  table: 'w-full border-collapse text-sm',
  th: 'border-b border-slate-300 px-3 py-2 text-left font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100',
  td: 'border-b border-slate-200 px-3 py-2 align-top text-slate-800 dark:border-slate-800 dark:text-slate-200',
  a: 'underline underline-offset-2 text-indigo-700 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-200',
} as const;

/** Anchors to untrusted destinations get the same treatment as elsewhere in the UI. */
const LINK_REL = 'noreferrer noopener nofollow external';

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/u;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/u;
const THEMATIC_BREAK = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u;
const QUOTE = /^ {0,3}> ?(.*)$/u;
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/u;
const ORDERED = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/u;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/u;

/**
 * Render markdown to HTML.
 *
 * The caller is responsible for only invoking this on content whose declared
 * `contentType` is markdown — a renderer applied to arbitrary text produces
 * confident nonsense (every `#` a heading, every `*` emphasis).
 */
export function renderMarkdown(source: string): string {
  const lines = scanLines(source);
  return renderBlocks(lines, 0, lines.length);
}

/** Render `lines[from, to)` as a sequence of block elements. */
function renderBlocks(lines: readonly SourceLine[], from: number, to: number): string {
  const out: string[] = [];
  let i = from;

  while (i < to) {
    const line = lines[i];
    if (!line) {
      i += 1;
      continue;
    }
    const text = line.text;

    if (text.trim().length === 0) {
      i += 1;
      continue;
    }

    // Fences first and unconditionally: inside one, nothing is markdown.
    const fence = text.match(FENCE);
    if (fence) {
      const marker = fence[2] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < to) {
        const inner = lines[i];
        if (!inner) break;
        if (closesFence(inner.text, marker)) {
          i += 1;
          break;
        }
        body.push(inner.text);
        i += 1;
      }
      out.push(`<pre class="${CLASS.pre}"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const atx = text.match(ATX);
    if (atx) {
      const level = Math.min((atx[1] ?? '#').length, 6);
      out.push(heading(level, stripClosingRun(atx[2] ?? '')));
      i += 1;
      continue;
    }

    // Before lists: `---` is a thematic break, and `-` starts a bullet, so the
    // break has to win or every horizontal rule becomes an empty list item.
    if (THEMATIC_BREAK.test(text)) {
      out.push(`<hr class="${CLASS.hr}" />`);
      i += 1;
      continue;
    }

    if (QUOTE.test(text)) {
      const body: string[] = [];
      while (i < to) {
        const inner = lines[i];
        const match = inner?.text.match(QUOTE);
        if (!inner || !match) break;
        body.push(match[1] ?? '');
        i += 1;
      }
      out.push(`<blockquote class="${CLASS.quote}">${renderParagraphText(body)}</blockquote>`);
      continue;
    }

    const table = tryTable(lines, i, to);
    if (table) {
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (BULLET.test(text) || ORDERED.test(text)) {
      const list = renderList(lines, i, to);
      out.push(list.html);
      i = list.next;
      continue;
    }

    // Paragraph: consume to the next blank line or block starter, then check for
    // a setext underline, which promotes the run to a heading.
    const body: string[] = [];
    while (i < to) {
      const inner = lines[i];
      if (!inner || inner.text.trim().length === 0) break;

      // The setext test comes BEFORE the block-starter test, because `-----`
      // matches a thematic break too. Underlining an open paragraph makes it a
      // heading; checking the break first would emit the paragraph and then a
      // rule, silently demoting every `---`-underlined heading in a document.
      const setext = body.length > 0 ? inner.text.match(SETEXT) : null;
      if (!setext && startsNewBlock(inner.text) && body.length > 0) break;

      if (setext) {
        const last = body.pop() ?? '';
        if (body.length > 0) out.push(`<p class="${CLASS.p}">${renderParagraphText(body)}</p>`);
        out.push(heading((setext[1] ?? '=').startsWith('=') ? 1 : 2, last));
        body.length = 0;
        i += 1;
        break;
      }

      body.push(inner.text);
      i += 1;
    }
    if (body.length > 0) out.push(`<p class="${CLASS.p}">${renderParagraphText(body)}</p>`);
  }

  return out.join('\n');
}

/** Lines inside a paragraph join with a space, the way markdown reflows them. */
function renderParagraphText(body: readonly string[]): string {
  return renderInline(body.map((line) => line.trim()).join(' '));
}

function heading(level: number, raw: string): string {
  const tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  return `<${tag} class="${CLASS[tag]}">${renderInline(raw.trim())}</${tag}>`;
}

function stripClosingRun(raw: string): string {
  const withoutRun = raw.replace(/[ \t]+#+[ \t]*$/u, '');
  return /^#+$/u.test(withoutRun) ? '' : withoutRun;
}

function closesFence(text: string, marker: string): boolean {
  const match = text.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/u);
  const sequence = match?.[1] ?? '';
  return (
    sequence.length > 0 &&
    sequence.charAt(0) === marker.charAt(0) &&
    sequence.length >= marker.length
  );
}

/** Whether a line would begin a block of its own, ending an open paragraph. */
function startsNewBlock(text: string): boolean {
  return (
    ATX.test(text) ||
    FENCE.test(text) ||
    THEMATIC_BREAK.test(text) ||
    QUOTE.test(text) ||
    BULLET.test(text) ||
    ORDERED.test(text)
  );
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

interface BlockRun {
  html: string;
  /** First line index after the block. */
  next: number;
}

/**
 * One list, nested by indentation.
 *
 * A deeper-indented run under an item is rendered as a nested list inside that
 * item by recursing through `renderBlocks`, so a nested ordered list inside a
 * bullet works without this function knowing anything about the inner kind.
 */
function renderList(lines: readonly SourceLine[], from: number, to: number): BlockRun {
  const first = lines[from]?.text ?? '';
  const ordered = ORDERED.test(first) && !BULLET.test(first);
  const baseIndent = indentWidth(first);
  const items: string[] = [];
  let i = from;

  while (i < to) {
    const line = lines[i];
    if (!line) break;

    if (line.text.trim().length === 0) {
      // A blank line ends the list unless an item continues after it.
      const next = lines[i + 1];
      if (!next || !isListItemAt(next.text, baseIndent)) break;
      i += 1;
      continue;
    }

    const match = matchItem(line.text);
    if (!match || indentWidth(line.text) < baseIndent) break;

    // A more deeply indented item belongs to the previous item, not this list.
    if (indentWidth(line.text) > baseIndent) {
      const start = i;
      while (i < to) {
        const inner = lines[i];
        if (!inner) break;
        if (inner.text.trim().length > 0 && indentWidth(inner.text) <= baseIndent) break;
        i += 1;
      }
      const nested = renderBlocks(dedent(lines.slice(start, i), baseIndent + 1), 0, i - start);
      if (items.length > 0) items[items.length - 1] += nested;
      else items.push(nested);
      continue;
    }

    items.push(`<li class="${CLASS.li}">${renderInline(match.text.trim())}</li>`);
    i += 1;
  }

  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag} class="${CLASS[tag]}">${items.join('')}</${tag}>`, next: i };
}

function matchItem(text: string): { text: string } | null {
  const bullet = text.match(BULLET);
  if (bullet) return { text: bullet[2] ?? '' };
  const ordered = text.match(ORDERED);
  if (ordered) return { text: ordered[3] ?? '' };
  return null;
}

function isListItemAt(text: string, baseIndent: number): boolean {
  return matchItem(text) !== null && indentWidth(text) >= baseIndent;
}

function indentWidth(text: string): number {
  const match = text.match(/^[ \t]*/u);
  // A tab counts as four columns, which is what the common editors emit.
  return (match?.[0] ?? '').replace(/\t/gu, '    ').length;
}

/** Re-scan a slice with `width` columns of leading indentation removed. */
function dedent(slice: readonly SourceLine[], width: number): SourceLine[] {
  return slice.map((line) => ({
    start: line.start,
    end: line.end,
    text: line.text.replace(/^[ \t]+/u, (run) => run.replace(/\t/gu, '    ').slice(width)),
  }));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * A pipe table, which needs a header row and a divider row to be a table at all.
 *
 * Without the divider requirement any paragraph containing a `|` — a shell
 * pipeline, a regex alternation — would become a one-column table.
 */
function tryTable(lines: readonly SourceLine[], from: number, to: number): BlockRun | null {
  const header = lines[from]?.text ?? '';
  const divider = lines[from + 1]?.text ?? '';
  if (!header.includes('|') || from + 1 >= to || !TABLE_DIVIDER.test(divider)) return null;
  if (!divider.includes('-')) return null;

  const headCells = splitRow(header);
  if (headCells.length === 0) return null;

  const rows: string[] = [];
  let i = from + 2;
  while (i < to) {
    const line = lines[i];
    if (!line || line.text.trim().length === 0 || !line.text.includes('|')) break;
    const cells = splitRow(line.text);
    rows.push(
      `<tr>${cells
        .map((cell) => `<td class="${CLASS.td}">${renderInline(cell)}</td>`)
        .join('')}</tr>`,
    );
    i += 1;
  }

  const head = headCells
    .map((cell) => `<th class="${CLASS.th}" scope="col">${renderInline(cell)}</th>`)
    .join('');

  return {
    html:
      `<div class="${CLASS.tableWrap}"><table class="${CLASS.table}">` +
      `<thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
    next: i,
  };
}

/** Cells of a pipe row, ignoring the optional leading and trailing pipes. */
function splitRow(text: string): string[] {
  const trimmed = text.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * Inline rendering, left to right over RAW source.
 *
 * Each iteration finds the earliest construct, escapes everything before it,
 * emits that construct, and continues after it. Working over raw text — rather
 * than running regexes across already-escaped HTML — is what keeps a formatting
 * bug from becoming an injection: text only ever reaches the output through
 * `escapeHtml`, and the tags come from the literals below.
 *
 * Code spans are found first at every position, so `` `**not bold**` `` stays
 * literal.
 */
function renderInline(raw: string): string {
  let out = '';
  let rest = raw;

  while (rest.length > 0) {
    const next = findInline(rest);
    if (!next) {
      out += escapeHtml(rest);
      break;
    }
    out += escapeHtml(rest.slice(0, next.index));
    out += next.html;
    rest = rest.slice(next.index + next.length);
  }

  return out;
}

interface InlineMatch {
  index: number;
  length: number;
  html: string;
}

const INLINE_CODE = /`+([^`]+?)`+/u;
const IMAGE = /!\[([^\]]*)\]\(([^)\s]*)(?:[ \t]+"[^"]*")?\)/u;
const LINK = /\[([^\]]*)\]\(([^)\s]*)(?:[ \t]+"[^"]*")?\)/u;
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/u;
const EMPHASIS = /(\*|_)(?=\S)((?:[^*_]|\*\*|__)*?\S)\1/u;

function findInline(text: string): InlineMatch | null {
  const candidates: InlineMatch[] = [];

  const code = text.match(INLINE_CODE);
  if (code?.index !== undefined) {
    candidates.push({
      index: code.index,
      length: code[0].length,
      html: `<code class="${CLASS.code}">${escapeHtml(code[1] ?? '')}</code>`,
    });
  }

  const image = text.match(IMAGE);
  if (image?.index !== undefined) {
    // Rendered as a link, not an <img> — see the module docblock.
    const label = (image[1] ?? '').trim() || 'image';
    candidates.push({
      index: image.index,
      length: image[0].length,
      html: anchor(image[2] ?? '', label),
    });
  }

  const link = text.match(LINK);
  // `![alt](src)` also matches LINK one character later; the image candidate
  // above already covers that position, so skip the inner match.
  if (
    link?.index !== undefined &&
    !(image?.index !== undefined && link.index === image.index + 1)
  ) {
    candidates.push({
      index: link.index,
      length: link[0].length,
      html: anchor(link[2] ?? '', link[1] ?? ''),
    });
  }

  const strong = text.match(STRONG);
  if (strong?.index !== undefined) {
    candidates.push({
      index: strong.index,
      length: strong[0].length,
      html: `<strong>${renderInline(strong[2] ?? '')}</strong>`,
    });
  }

  const emphasis = text.match(EMPHASIS);
  if (emphasis?.index !== undefined) {
    candidates.push({
      index: emphasis.index,
      length: emphasis[0].length,
      html: `<em>${renderInline(emphasis[2] ?? '')}</em>`,
    });
  }

  if (candidates.length === 0) return null;

  // Earliest wins; on a tie the longer match does, so `**x**` beats `*x*` at the
  // same position.
  return candidates.reduce((best, candidate) =>
    candidate.index < best.index ||
    (candidate.index === best.index && candidate.length > best.length)
      ? candidate
      : best,
  );
}

/**
 * An anchor, or plain text when the destination is not safely linkable.
 *
 * Only absolute http(s) survives. A `javascript:` or `data:` URL is the obvious
 * attack, but a relative path is dropped too: resolved against `/documents/...`
 * it would point at this application's own routes, letting stored content forge
 * a link that looks like part of the UI.
 */
function anchor(href: string, label: string): string {
  const text = escapeHtml(label.length > 0 ? label : href);
  const safe = safeHref(href);
  if (!safe) return text;
  return `<a class="${CLASS.a}" href="${escapeHtml(safe)}" rel="${LINK_REL}">${text}</a>`;
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
