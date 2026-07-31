/**
 * Markdown (and general line) structure parsing.
 *
 * Kept separate from the chunker because "where does this block start and end"
 * is a different problem from "how many blocks fit in a chunk", and because
 * fence/heading tracking is the part most likely to need fixing against real
 * documents. Everything here is **offset-preserving**: nothing is normalised or
 * rewritten, so the chunker can always slice the original string and get the
 * exact source text back.
 *
 * Structure we recognise — deliberately a subset of CommonMark:
 *
 *   - ATX headings (`#` … `######`), including the optional closing `###` run
 *   - Setext headings (a line underlined with `===` or `---`)
 *   - Fenced code blocks (``` or ~~~), at any indent, with info strings
 *   - YAML front matter, kept as one opaque block so its keys never leak into
 *     the heading breadcrumb
 *   - everything else: runs of non-blank lines. That is the right granularity
 *     for lists, tables and block quotes as well — they stay whole.
 *
 * What we deliberately do NOT handle: indented (4-space) code blocks, link
 * reference definitions, or any inline parsing. A chunker needs none of them,
 * and each one is another way to mis-slice a document.
 *
 * The one rule that really matters: **inside a fence nothing is markdown.** A
 * `# comment` in a shell snippet is not a heading, and a blank line in a code
 * block is not a paragraph break.
 */

export interface SourceLine {
  /** Offset of the line's first character in the original content. */
  start: number;
  /** Offset just past the line's last character, excluding `\r\n` / `\n`. */
  end: number;
  /** The line's text without its terminator (and without a trailing `\r`). */
  text: string;
}

export type MarkdownBlockKind = 'heading' | 'fence' | 'paragraph';

export interface MarkdownBlock {
  kind: MarkdownBlockKind;
  /** Offsets into the original content; may include leading/trailing blanks. */
  start: number;
  end: number;
  /**
   * Enclosing headings in effect for this block, outermost first. A heading
   * block includes *itself* — the text under `## Docker` and the `## Docker`
   * line belong to the same breadcrumb.
   */
  headingPath: string[];
}

export interface HeadingFrame {
  level: number;
  title: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Split content into lines, remembering where each one started.
 *
 * Handles both `\n` and `\r\n`: the `\r` is excluded from `end` and from `text`
 * so that a CRLF document parses identically to an LF one, while offsets still
 * refer to the untouched original.
 */
export function scanLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let i = 0; i <= content.length; i += 1) {
    if (i !== content.length && content.charAt(i) !== '\n') continue;
    let end = i;
    if (end > start && content.charAt(end - 1) === '\r') end -= 1;
    lines.push({ start, end, text: content.slice(start, end) });
    start = i + 1;
  }
  return lines;
}

/** Apply a heading to the stack: deeper pushes, equal or shallower pops first. */
export function pushHeading(stack: HeadingFrame[], level: number, title: string): void {
  while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
  stack.push({ level, title });
}

/** Materialise the breadcrumb. Untitled headings hold a level but add no crumb. */
export function headingPathOf(stack: readonly HeadingFrame[]): string[] {
  return stack.map((frame) => frame.title).filter((title) => title.length > 0);
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = scanLines(content);
  const blocks: MarkdownBlock[] = [];
  const stack: HeadingFrame[] = [];

  // An open paragraph is tracked as offsets rather than an array of lines: the
  // only line we ever need to look back at individually is the last one, for
  // setext headings, so `paraLastStart` / `paraPrevEnd` are enough.
  let paraStart = -1;
  let paraEnd = -1;
  let paraLastStart = -1;
  let paraPrevEnd = -1;

  let fenceStart = -1;
  let fenceChar = '';
  let fenceLength = 0;

  const resetParagraph = (): void => {
    paraStart = -1;
    paraEnd = -1;
    paraLastStart = -1;
    paraPrevEnd = -1;
  };

  const flushParagraph = (): void => {
    if (paraStart >= 0) {
      blocks.push({
        kind: 'paragraph',
        start: paraStart,
        end: paraEnd,
        headingPath: headingPathOf(stack),
      });
    }
    resetParagraph();
  };

  let index = 0;
  const frontMatter = findFrontMatter(lines);
  if (frontMatter) {
    blocks.push({
      kind: 'paragraph',
      start: frontMatter.start,
      end: frontMatter.end,
      headingPath: [],
    });
    index = frontMatter.nextLine;
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    if (fenceStart >= 0) {
      if (closesFence(line.text, fenceChar, fenceLength)) {
        blocks.push({
          kind: 'fence',
          start: fenceStart,
          end: line.end,
          headingPath: headingPathOf(stack),
        });
        fenceStart = -1;
      }
      continue;
    }

    const fence = line.text.match(FENCE_OPEN);
    if (fence && opensFence(fence)) {
      flushParagraph();
      const sequence = fence[1] ?? '';
      fenceStart = line.start;
      fenceChar = sequence.charAt(0);
      fenceLength = sequence.length;
      continue;
    }

    const atx = line.text.match(ATX_HEADING);
    if (atx) {
      flushParagraph();
      pushHeading(stack, (atx[1] ?? '#').length, atxTitle(atx[2]));
      blocks.push({
        kind: 'heading',
        start: line.start,
        end: line.end,
        headingPath: headingPathOf(stack),
      });
      continue;
    }

    const setext = paraStart >= 0 ? line.text.match(SETEXT_UNDERLINE) : null;
    if (setext) {
      // The underline promotes only the *last* line of the open paragraph; any
      // lines before it stay a paragraph of their own.
      if (paraPrevEnd >= 0) {
        blocks.push({
          kind: 'paragraph',
          start: paraStart,
          end: paraPrevEnd,
          headingPath: headingPathOf(stack),
        });
      }
      const headingStart = paraLastStart;
      const title = content.slice(paraLastStart, paraEnd).trim();
      resetParagraph();
      pushHeading(stack, (setext[1] ?? '=').startsWith('=') ? 1 : 2, title);
      blocks.push({
        kind: 'heading',
        start: headingStart,
        end: line.end,
        headingPath: headingPathOf(stack),
      });
      continue;
    }

    if (line.text.trim().length === 0) {
      flushParagraph();
      continue;
    }

    if (paraStart < 0) paraStart = line.start;
    else paraPrevEnd = paraEnd;
    paraLastStart = line.start;
    paraEnd = line.end;
  }

  // An unterminated fence runs to the end of the document — the alternative,
  // re-parsing its body as markdown, would split code at fake headings.
  if (fenceStart >= 0) {
    blocks.push({
      kind: 'fence',
      start: fenceStart,
      end: content.length,
      headingPath: headingPathOf(stack),
    });
  } else {
    flushParagraph();
  }

  return blocks;
}

/** A backtick fence's info string may not itself contain a backtick. */
function opensFence(match: RegExpMatchArray): boolean {
  const sequence = match[1] ?? '';
  const info = match[2] ?? '';
  return sequence.charAt(0) !== '`' || !info.includes('`');
}

/** A closing fence uses the same character, is at least as long, and carries no info string. */
function closesFence(text: string, char: string, length: number): boolean {
  const match = text.match(FENCE_CLOSE);
  if (!match) return false;
  const sequence = match[1] ?? '';
  return sequence.charAt(0) === char && sequence.length >= length;
}

function atxTitle(raw: string | undefined): string {
  const withoutClosingRun = (raw ?? '').replace(/[ \t]+#+[ \t]*$/, '');
  // `## ##` is an empty heading, not a heading called "##".
  return /^#+$/.test(withoutClosingRun) ? '' : withoutClosingRun.trim();
}

function findFrontMatter(
  lines: readonly SourceLine[],
): { start: number; end: number; nextLine: number } | null {
  const first = lines[0];
  if (!first || first.text.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.text.trim();
    if (trimmed === '---' || trimmed === '...') {
      return { start: first.start, end: line.end, nextLine: i + 1 };
    }
  }
  return null;
}
