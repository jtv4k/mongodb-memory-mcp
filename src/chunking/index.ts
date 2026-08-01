/**
 * Context-aware chunking — the pure heart of ingestion.
 *
 * `chunkContent` is a pure function: raw content in, chunk list out. No I/O, no
 * clock, no randomness, no logger, no configuration lookup. The same input
 * always produces a deeply equal output, which is what makes the retrieval
 * quality of this system testable at all.
 *
 * ## Structure first, length second
 *
 * Fixed-length splitting cuts sentences in half and separates a code block from
 * the paragraph that explains it, which is exactly the context an embedding
 * needs. So content is first parsed into *segments* on real boundaries, and
 * segments are then greedily packed into chunks. A segment is only ever split
 * when it does not fit in a chunk on its own, and then only at the next-best
 * boundary available, in this order:
 *
 *     heading  >  fenced code block  >  paragraph (blank line)
 *              >  single newline  >  sentence  >  word  >  hard character cut
 *
 * The hard cut exists solely so that pathological input — a 50k-character word,
 * a minified JSON blob — still produces chunks instead of an error.
 *
 * ## What `charStart` / `charEnd` mean — the exact, testable version
 *
 * They are UTF-16 code-unit offsets into the ORIGINAL `content` string, and the
 * relationship to the chunk text is equality, not approximation:
 *
 *     chunk.text === content.slice(chunk.charStart, chunk.charEnd)
 *
 * holds for every chunk this module returns. Nothing is injected into the text:
 * no heading breadcrumb, no separator, no whitespace normalisation, no re-added
 * code fence. That is a deliberate trade. Prefixing the breadcrumb to the text
 * would help a non-contextual embedding model, but it destroys the provenance
 * guarantee that the web UI and highlighting depend on — and our default model
 * (`voyage-context-3`) already conditions each chunk on its siblings, so the
 * breadcrumb buys much less than it costs. Callers that want it prefixed can do
 * so themselves from `headingPath`, and then they own the offset skew.
 *
 * `charStart` *includes* the overlap carried over from the previous chunk. The
 * overlap is always a contiguous suffix of the previous chunk's own region, so
 * the union stays a single contiguous slice. Consequences, all asserted in the
 * unit tests:
 *
 *   - `0 <= charStart < charEnd <= content.length`
 *   - `charStart` and `charEnd` are both strictly increasing across chunks
 *   - consecutive regions may overlap: `chunks[i].charStart < chunks[i-1].charEnd`
 *   - chunk text never begins or ends with whitespace
 *   - `index` is 0-based and contiguous; `tokenCount === estimateTokens(text)`
 *
 * ## Budgets
 *
 * `chunkSizeTokens` is the ceiling for the *whole* chunk, overlap included, so
 * segments are packed to `chunkSizeTokens - chunkOverlapTokens`. One deliberate
 * exception: a single indivisible block (typically a fenced code block) that is
 * larger than that packing budget but still fits inside `chunkSizeTokens` is
 * emitted whole, with no overlap prefix. Keeping a code block intact is worth
 * more than the overlap. Merging an undersized neighbour (see below) can also
 * push a chunk up to `chunkSizeTokens + minChunkTokens`.
 *
 * `headingPath` is the breadcrumb in effect where the chunk's own content
 * starts — for a chunk spanning `## A` and `## B`, that is the path at `## A`.
 */
import type { ChunkingConfig } from '../config/env.js';
import type { Chunk, ChunkingResult, ContentType } from '../domain/types.js';
import { ChunkingError } from '../errors.js';

import {
  headingPathOf,
  parseMarkdownBlocks,
  pushHeading,
  scanLines,
  type HeadingFrame,
} from './markdown.js';
import { estimateTokens, type TokenCounter } from './tokens.js';

export { estimateTokens } from './tokens.js';
export type { TokenCounter } from './tokens.js';
export { parseMarkdownBlocks, scanLines } from './markdown.js';
export type { MarkdownBlock, MarkdownBlockKind, SourceLine } from './markdown.js';

/**
 * One strategy name per code path, so `document.chunking.strategy` in MongoDB says
 * exactly how a document was split and a re-chunk can be targeted at just the
 * documents whose splitter changed.
 */
export const CHUNKING_STRATEGIES = {
  /** Markdown: heading/fence/paragraph aware. */
  markdown: 'markdown-structural',
  /** Source code: blank-line separated blocks, never split mid-line. */
  code: 'code-block',
  /** HTML: block-level close tags, with `<h1>`–`<h6>` feeding the breadcrumb. */
  html: 'html-blocks',
  /** JSON that parses: one segment per top-level array element / object entry. */
  jsonElements: 'json-elements',
  /** JSON that does not parse: line-based fallback. */
  jsonLines: 'json-lines',
  /** Plain text: paragraphs, then sentences. */
  text: 'paragraph',
} as const;

export interface ChunkContentInput {
  content: string;
  contentType: ContentType;
  options: ChunkingConfig;
  /**
   * Swap in a real tokenizer without touching the splitter. Defaults to
   * {@link estimateTokens}. Must be pure — the purity of `chunkContent` is only
   * as good as the counter it is given.
   */
  countTokens?: TokenCounter;
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

/** Fallback boundaries used when a single segment is too big for one chunk. */
type BoundaryKind = 'paragraph' | 'line' | 'sentence' | 'word';

interface Span {
  start: number;
  end: number;
}

interface Segment extends Span {
  headingPath: string[];
  /** Boundaries this segment may be cut on, best first. Empty tail ⇒ hard cut. */
  splitTiers: readonly BoundaryKind[];
}

interface CoreChunk extends Span {
  headingPath: string[];
  /**
   * False for a block kept whole because it alone fills a chunk. Prepending an
   * overlap would push it past `chunkSizeTokens`, so it gets none.
   */
  allowOverlap: boolean;
}

interface WorkingChunk {
  charStart: number;
  charEnd: number;
  text: string;
  tokenCount: number;
  headingPath: string[];
}

interface Segmentation {
  segments: Segment[];
  strategy: string;
}

const PROSE_TIERS: readonly BoundaryKind[] = ['paragraph', 'line', 'sentence', 'word'];
/** Code and fences are only ever cut between whole lines. */
const LINE_TIERS: readonly BoundaryKind[] = ['line'];
/** Minified JSON has no lines to cut on, so words are the last structured option. */
const JSON_TIERS: readonly BoundaryKind[] = ['line', 'word'];

const WHITESPACE = /\s/;
const SENTENCE_BOUNDARY = /[.!?…]+["'”’)\]»]*\s+/g;
const SENTENCE_TERMINATOR = /[.!?…]/;
const SENTENCE_TRAILER = /["'”’)\]»]/;
/** Characters we must never cut immediately before: they bind to the previous one. */
const COMBINING = /\p{M}/u;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function chunkContent(input: ChunkContentInput): ChunkingResult {
  const { content, contentType, options } = input;
  const count = input.countTokens ?? estimateTokens;

  // The service layer distinguishes "nothing to store" from "stored zero
  // chunks", so this is an error rather than an empty result.
  if (content.trim().length === 0) {
    throw new ChunkingError('Cannot chunk empty or whitespace-only content', {
      details: { contentType, inputChars: content.length },
    });
  }
  if (!Number.isFinite(options.chunkSizeTokens) || options.chunkSizeTokens < 1) {
    throw new ChunkingError('chunkSizeTokens must be a positive integer', {
      details: { chunkSizeTokens: options.chunkSizeTokens },
    });
  }

  const maxTokens = Math.floor(options.chunkSizeTokens);
  const overlapTokens = clamp(Math.floor(options.chunkOverlapTokens), 0, maxTokens - 1);
  const minTokens = clamp(Math.floor(options.minChunkTokens), 0, maxTokens);
  const coreBudget = Math.max(1, maxTokens - overlapTokens);

  const { segments, strategy } = segmentContent(content, contentType);
  if (segments.length === 0) {
    throw new ChunkingError('Content produced no chunkable segments', {
      details: { contentType, inputChars: content.length, strategy },
    });
  }

  const cores = packSegments(content, segments, coreBudget, maxTokens, count);
  const working = attachOverlap(content, cores, overlapTokens, count);
  const mergedUndersized = mergeUndersized(content, working, minTokens, count);

  const chunks: Chunk[] = working.map((chunk, index) => ({
    index,
    text: chunk.text,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    tokenCount: chunk.tokenCount,
    headingPath: [...chunk.headingPath],
  }));

  return {
    chunks,
    strategy,
    stats: {
      inputChars: content.length,
      chunkCount: chunks.length,
      totalTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
      mergedUndersized,
    },
  };
}

// ---------------------------------------------------------------------------
// Segmentation — one function per content type
// ---------------------------------------------------------------------------

function segmentContent(content: string, contentType: ContentType): Segmentation {
  switch (contentType) {
    case 'markdown':
      return { segments: segmentMarkdown(content), strategy: CHUNKING_STRATEGIES.markdown };
    case 'code':
      return {
        segments: blankLineSegments(content, LINE_TIERS),
        strategy: CHUNKING_STRATEGIES.code,
      };
    case 'html':
      return { segments: segmentHtml(content), strategy: CHUNKING_STRATEGIES.html };
    case 'json':
      return segmentJson(content);
    case 'text':
      return {
        segments: blankLineSegments(content, PROSE_TIERS),
        strategy: CHUNKING_STRATEGIES.text,
      };
    default: {
      const unreachable: never = contentType;
      throw new ChunkingError(`Unsupported content type: ${String(unreachable)}`);
    }
  }
}

function segmentMarkdown(content: string): Segment[] {
  const segments: Segment[] = [];
  for (const block of parseMarkdownBlocks(content)) {
    const span = trimSpan(content, block.start, block.end);
    if (!span) continue;
    segments.push({
      ...span,
      headingPath: block.headingPath,
      splitTiers: block.kind === 'fence' ? LINE_TIERS : PROSE_TIERS,
    });
  }
  return segments;
}

/** Runs of non-blank lines. Right for plain text and a fair proxy for code blocks. */
function blankLineSegments(content: string, splitTiers: readonly BoundaryKind[]): Segment[] {
  return groupNonBlankLines(content, { start: 0, end: content.length }).map((span) => ({
    ...span,
    headingPath: [],
    splitTiers,
  }));
}

/**
 * HTML: cut after every block-level close tag and before every heading open tag.
 *
 * This is an approximation, not a parser — we do not resolve nesting, so a
 * `</div>` that closes a wrapper produces a boundary the same as one that closes
 * a paragraph. For chunking that is harmless: extra boundaries only give the
 * packer more places to break, and the packer prefers to fill a chunk anyway.
 */
function segmentHtml(content: string): Segment[] {
  const closeTag =
    /<\/(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|li|dl|dd|dt|table|thead|tbody|tfoot|tr|blockquote|pre|figure|figcaption|form|fieldset|h[1-6])[^>]*>/gi;
  const headingOpen = /<h[1-6]\b[^>]*>/gi;
  const headingElement = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1[^>]*>/gi;

  const cuts = new Set<number>();
  for (const match of content.matchAll(closeTag)) {
    const at = match.index ?? -1;
    if (at >= 0) cuts.add(at + match[0].length);
  }
  for (const match of content.matchAll(headingOpen)) {
    const at = match.index ?? -1;
    if (at >= 0) cuts.add(at);
  }

  const headings: Array<{ offset: number; level: number; title: string }> = [];
  for (const match of content.matchAll(headingElement)) {
    const at = match.index ?? -1;
    if (at < 0) continue;
    headings.push({
      offset: at,
      level: Number.parseInt(match[1] ?? '1', 10),
      title: htmlToText(match[2] ?? ''),
    });
  }

  const ordered = [...cuts].filter((cut) => cut > 0 && cut < content.length).sort((a, b) => a - b);
  const raw: Span[] = [];
  let position = 0;
  for (const cut of ordered) {
    if (cut > position) {
      raw.push({ start: position, end: cut });
      position = cut;
    }
  }
  if (position < content.length) raw.push({ start: position, end: content.length });

  const stack: HeadingFrame[] = [];
  const segments: Segment[] = [];
  let next = 0;
  for (const candidate of raw) {
    const span = trimSpan(content, candidate.start, candidate.end);
    if (!span) continue;
    while (next < headings.length && (headings[next]?.offset ?? Infinity) <= span.start) {
      const heading = headings[next];
      if (heading) pushHeading(stack, heading.level, heading.title);
      next += 1;
    }
    segments.push({ ...span, headingPath: headingPathOf(stack), splitTiers: PROSE_TIERS });
  }
  return segments;
}

/**
 * JSON: one segment per top-level element, so an array of records never has a
 * record straddling two chunks.
 *
 * `JSON.parse` is used only as a validity gate — it discards offsets, so the
 * element boundaries come from a small depth/string scanner over the original
 * text. Anything that does not parse falls back to line splitting rather than
 * guessing, and says so through a different strategy name.
 */
function segmentJson(content: string): Segmentation {
  try {
    JSON.parse(content) as unknown;
  } catch {
    return {
      segments: blankLineSegments(content, JSON_TIERS),
      strategy: CHUNKING_STRATEGIES.jsonLines,
    };
  }

  const elements = topLevelJsonElements(content);
  if (elements.length === 0) {
    const whole = trimSpan(content, 0, content.length);
    return {
      segments: whole ? [{ ...whole, headingPath: [], splitTiers: JSON_TIERS }] : [],
      strategy: CHUNKING_STRATEGIES.jsonElements,
    };
  }

  return {
    segments: elements.map((element) => ({
      start: element.start,
      end: element.end,
      // An object's key is the closest thing JSON has to a heading, and it makes
      // search hits self-describing ("this came from `services.app`").
      headingPath: element.key === null ? [] : [element.key],
      splitTiers: JSON_TIERS,
    })),
    strategy: CHUNKING_STRATEGIES.jsonElements,
  };
}

interface JsonElement extends Span {
  key: string | null;
}

/**
 * Cut a JSON document after every top-level comma.
 *
 * The spans **tile** the whole document — the opening bracket rides on the first
 * element and the trailing comma on the element it follows — so no character is
 * dropped and the chunker's "nothing but whitespace between chunks" guarantee
 * survives. Returns an empty list when there is nothing to cut (a scalar, an
 * empty container, or a single element), and the caller emits one segment.
 */
function topLevelJsonElements(content: string): JsonElement[] {
  let index = 0;
  while (index < content.length && WHITESPACE.test(content.charAt(index))) index += 1;
  const open = content.charAt(index);
  if (open !== '[' && open !== '{') return [];

  const cuts: number[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; index < content.length; index += 1) {
    const ch = content.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (ch === ',' && depth === 1) cuts.push(index + 1);
  }
  if (cuts.length === 0) return [];

  const elements: JsonElement[] = [];
  let from = 0;
  for (const cut of [...cuts, content.length]) {
    const span = trimSpan(content, from, cut);
    if (span) elements.push({ ...span, key: open === '{' ? jsonKeyOf(content, span) : null });
    from = cut;
  }
  return elements;
}

/** The leading `"key":` of an object entry — JSON's closest thing to a heading. */
function jsonKeyOf(content: string, span: Span): string | null {
  const match = content.slice(span.start, span.end).match(/^[\s{]*"((?:[^"\\]|\\.)*)"\s*:/);
  if (!match) return null;
  try {
    const key: unknown = JSON.parse(`"${match[1] ?? ''}"`);
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

function packSegments(
  content: string,
  segments: readonly Segment[],
  coreBudget: number,
  maxTokens: number,
  count: TokenCounter,
): CoreChunk[] {
  const cores: CoreChunk[] = [];
  let open: { start: number; end: number; tokens: number; headingPath: string[] } | null = null;

  const close = (chunk: { start: number; end: number; headingPath: string[] }): void => {
    cores.push({
      start: chunk.start,
      end: chunk.end,
      headingPath: chunk.headingPath,
      allowOverlap: true,
    });
  };

  for (const segment of segments) {
    const segmentTokens = count(content.slice(segment.start, segment.end));

    if (segmentTokens > coreBudget) {
      if (open) close(open);
      open = null;

      // Fits in a chunk on its own: keep it whole and forgo the overlap prefix
      // rather than cut a code block in half for the sake of 64 tokens.
      if (segmentTokens <= maxTokens) {
        cores.push({
          start: segment.start,
          end: segment.end,
          headingPath: segment.headingPath,
          allowOverlap: false,
        });
        continue;
      }

      const pieces = splitRegion(content, segment, coreBudget, count, segment.splitTiers);
      for (let i = 0; i < pieces.length; i += 1) {
        const piece = pieces[i];
        if (!piece) continue;
        if (i === pieces.length - 1) {
          // Leave the tail open so a short following segment joins it instead of
          // becoming an undersized chunk of its own.
          open = {
            start: piece.start,
            end: piece.end,
            tokens: count(content.slice(piece.start, piece.end)),
            headingPath: segment.headingPath,
          };
        } else {
          cores.push({ ...piece, headingPath: segment.headingPath, allowOverlap: true });
        }
      }
      continue;
    }

    if (open === null) {
      open = {
        start: segment.start,
        end: segment.end,
        tokens: segmentTokens,
        headingPath: segment.headingPath,
      };
      continue;
    }

    const gapTokens = count(content.slice(open.end, segment.start));
    if (open.tokens + gapTokens + segmentTokens > coreBudget) {
      close(open);
      open = {
        start: segment.start,
        end: segment.end,
        tokens: segmentTokens,
        headingPath: segment.headingPath,
      };
    } else {
      open.end = segment.end;
      open.tokens += gapTokens + segmentTokens;
    }
  }

  if (open) close(open);
  return cores;
}

/**
 * Split one oversized region, trying each remaining boundary tier in turn and
 * repacking the parts. Terminates because every tier either produces at least
 * two strictly smaller regions or is skipped, and the tier list is finite with a
 * hard character cut at the bottom.
 */
function splitRegion(
  content: string,
  region: Span,
  budget: number,
  count: TokenCounter,
  tiers: readonly BoundaryKind[],
): Span[] {
  if (region.end <= region.start) return [];
  if (count(content.slice(region.start, region.end)) <= budget) {
    return [{ start: region.start, end: region.end }];
  }

  const tier = tiers[0];
  if (tier === undefined) return hardCut(content, region, budget, count);
  const rest = tiers.slice(1);

  const parts = splitAtTier(content, region, tier);
  if (parts.length < 2) return splitRegion(content, region, budget, count, rest);

  const packed: Span[] = [];
  let open: { start: number; end: number; tokens: number } | null = null;
  for (const part of parts) {
    const partTokens = count(content.slice(part.start, part.end));
    if (partTokens > budget) {
      if (open) packed.push({ start: open.start, end: open.end });
      open = null;
      packed.push(...splitRegion(content, part, budget, count, rest));
      continue;
    }
    if (open === null) {
      open = { start: part.start, end: part.end, tokens: partTokens };
      continue;
    }
    const gapTokens = count(content.slice(open.end, part.start));
    if (open.tokens + gapTokens + partTokens > budget) {
      packed.push({ start: open.start, end: open.end });
      open = { start: part.start, end: part.end, tokens: partTokens };
    } else {
      open.end = part.end;
      open.tokens += gapTokens + partTokens;
    }
  }
  if (open) packed.push({ start: open.start, end: open.end });

  // Defensive: if this tier failed to make the region any smaller, drop to the
  // next one rather than recurse on an identical region.
  const only = packed.length === 1 ? packed[0] : undefined;
  if (only && only.start === region.start && only.end === region.end) {
    return splitRegion(content, region, budget, count, rest);
  }
  return packed;
}

function splitAtTier(content: string, region: Span, tier: BoundaryKind): Span[] {
  switch (tier) {
    case 'paragraph':
      return groupNonBlankLines(content, region);
    case 'line':
      return scanLines(content.slice(region.start, region.end))
        .map((line) => trimSpan(content, line.start + region.start, line.end + region.start))
        .filter((span): span is Span => span !== null);
    case 'sentence':
      return splitAtSentences(content, region);
    case 'word':
      return [...content.slice(region.start, region.end).matchAll(/\S+/g)].map((match) => ({
        start: (match.index ?? 0) + region.start,
        end: (match.index ?? 0) + region.start + match[0].length,
      }));
    default: {
      const unreachable: never = tier;
      throw new ChunkingError(`Unknown boundary kind: ${String(unreachable)}`);
    }
  }
}

function splitAtSentences(content: string, region: Span): Span[] {
  const text = content.slice(region.start, region.end);
  const spans: Span[] = [];
  let from = 0;
  for (const match of text.matchAll(SENTENCE_BOUNDARY)) {
    const at = (match.index ?? -1) + match[0].length;
    if (at <= from || at >= text.length) continue;
    const span = trimSpan(content, from + region.start, at + region.start);
    if (span) spans.push(span);
    from = at;
  }
  const tail = trimSpan(content, from + region.start, region.end);
  if (tail) spans.push(tail);
  return spans;
}

function groupNonBlankLines(content: string, region: Span): Span[] {
  const groups: Span[] = [];
  let start = -1;
  let end = -1;
  for (const line of scanLines(content.slice(region.start, region.end))) {
    if (line.text.trim().length === 0) {
      if (start >= 0) groups.push({ start: start + region.start, end: end + region.start });
      start = -1;
      continue;
    }
    if (start < 0) start = line.start;
    end = line.end;
  }
  if (start >= 0) groups.push({ start: start + region.start, end: end + region.start });
  return groups
    .map((group) => trimSpan(content, group.start, group.end))
    .filter((span): span is Span => span !== null);
}

/**
 * Last resort: cut on raw character counts. Only reached when a region has no
 * whitespace at all (one enormous word, a base64 blob, minified JSON on one
 * line). Cuts are nudged off surrogate pairs and combining marks so a chunk can
 * never contain half a character.
 */
function hardCut(content: string, region: Span, budget: number, count: TokenCounter): Span[] {
  const spans: Span[] = [];
  let position = region.start;
  while (position < region.end) {
    const remaining = count(content.slice(position, region.end));
    if (remaining <= budget) {
      spans.push({ start: position, end: region.end });
      break;
    }
    const charsPerToken = (region.end - position) / Math.max(1, remaining);
    let cut = safeCut(content, position, position + Math.floor(budget * charsPerToken));
    if (cut >= region.end) cut = safeCut(content, position, region.end - 1);
    while (cut > position + 1 && count(content.slice(position, cut)) > budget) {
      cut = safeCut(content, position, position + Math.floor((cut - position) * 0.8));
    }
    spans.push({ start: position, end: cut });
    position = cut;
  }
  return spans;
}

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_15 = 0xfe0e;
const VARIATION_SELECTOR_16 = 0xfe0f;

/** Move a cut offset backwards off anything that must stay attached to its left neighbour. */
function safeCut(content: string, lower: number, candidate: number): number {
  let cut = Math.min(Math.max(candidate, lower + 1), content.length);
  for (let guard = 0; guard < 8 && cut > lower + 1; guard += 1) {
    const code = content.charCodeAt(cut);
    const splitsSurrogatePair = code >= 0xdc00 && code <= 0xdfff;
    const splitsGrapheme =
      code === ZERO_WIDTH_JOINER ||
      code === VARIATION_SELECTOR_15 ||
      code === VARIATION_SELECTOR_16 ||
      COMBINING.test(content.charAt(cut)) ||
      content.charCodeAt(cut - 1) === ZERO_WIDTH_JOINER;
    if (splitsSurrogatePair || splitsGrapheme) {
      cut -= 1;
      continue;
    }
    break;
  }
  return cut;
}

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

/** A safe place to start an overlap: always a word start, ranked by how clean it is. */
interface CutCandidate {
  offset: number;
  /** 2 = start of a line, 1 = start of a sentence, 0 = start of a word. */
  tier: number;
}

function attachOverlap(
  content: string,
  cores: readonly CoreChunk[],
  overlapTokens: number,
  count: TokenCounter,
): WorkingChunk[] {
  const chunks: WorkingChunk[] = [];
  let previousStart = -1;
  let previousCore: CoreChunk | null = null;

  for (const core of cores) {
    let charStart = core.start;
    if (previousCore && core.allowOverlap && overlapTokens > 0) {
      const from = chooseOverlapStart(content, previousCore, overlapTokens, count, previousStart);
      if (from !== null && from < core.start) charStart = from;
    }

    // Forward progress is the classic way an overlapping chunker hangs, so the
    // guarantee is checked rather than assumed. `chooseOverlapStart` only ever
    // returns offsets past `previousStart`, and cores are strictly ordered, so
    // this should be unreachable.
    if (charStart <= previousStart) {
      throw new ChunkingError('Chunker failed to make forward progress', {
        details: { charStart, previousStart, coreStart: core.start },
      });
    }

    const text = content.slice(charStart, core.end);
    chunks.push({
      charStart,
      charEnd: core.end,
      text,
      tokenCount: count(text),
      headingPath: core.headingPath,
    });
    previousStart = charStart;
    previousCore = core;
  }

  return chunks;
}

/**
 * Pick where the next chunk should start so that it repeats roughly
 * `targetTokens` of the previous chunk.
 *
 * Candidates are word starts inside the previous chunk, tagged by quality. We
 * take the *largest* overlap that fits the budget, then prefer the cleanest
 * boundary among the candidates that still carry at least half the budget — the
 * half-budget floor stops a stray short final line from collapsing a 64-token
 * overlap into a 3-token one just because it happens to be a line start.
 */
function chooseOverlapStart(
  content: string,
  core: Span,
  targetTokens: number,
  count: TokenCounter,
  exclusiveMin: number,
): number | null {
  const candidates = cutCandidates(content, core).filter((c) => c.offset > exclusiveMin);
  if (candidates.length === 0) return null;

  // Suffix token counts, accumulated from the end. Valid because every candidate
  // sits at a word start preceded by whitespace, where the estimator is additive.
  const suffix = new Array<number>(candidates.length).fill(0);
  let accumulated = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const from = candidates[i]?.offset ?? core.end;
    const to = i + 1 < candidates.length ? (candidates[i + 1]?.offset ?? core.end) : core.end;
    accumulated += count(content.slice(from, to));
    suffix[i] = accumulated;
  }

  let firstFit = -1;
  for (let i = 0; i < candidates.length; i += 1) {
    if ((suffix[i] ?? 0) <= targetTokens) {
      firstFit = i;
      break;
    }
  }
  if (firstFit < 0) return null;

  let generous = firstFit;
  while (generous < candidates.length && (suffix[generous] ?? 0) >= targetTokens / 2) {
    generous += 1;
  }
  const stop = generous > firstFit ? generous : candidates.length;

  let bestTier = -1;
  let bestOffset: number | null = null;
  for (let i = firstFit; i < stop; i += 1) {
    const candidate = candidates[i];
    if (candidate && candidate.tier > bestTier) {
      bestTier = candidate.tier;
      bestOffset = candidate.offset;
    }
  }
  return bestOffset;
}

function cutCandidates(content: string, region: Span): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  let sawNewline = false;
  let afterSentence = false;

  for (let i = region.start; i < region.end; i += 1) {
    const ch = content.charAt(i);
    if (WHITESPACE.test(ch)) {
      if (ch === '\n') sawNewline = true;
      continue;
    }
    if (i > region.start && WHITESPACE.test(content.charAt(i - 1))) {
      candidates.push({ offset: i, tier: sawNewline ? 2 : afterSentence ? 1 : 0 });
    }
    sawNewline = false;
    if (SENTENCE_TERMINATOR.test(ch)) afterSentence = true;
    else if (!SENTENCE_TRAILER.test(ch)) afterSentence = false;
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Minimum size
// ---------------------------------------------------------------------------

/**
 * Fold chunks below `minTokens` into a neighbour, in place, and report how many
 * were folded. A 4-token chunk is noise in a vector index: it retrieves on a
 * single keyword and tells the reader nothing.
 *
 * Merging into the *previous* chunk is preferred because the common case is a
 * short tail; only a leading runt merges forwards. A merged chunk can therefore
 * exceed `chunkSizeTokens` by up to `minChunkTokens`, which is the cheaper of
 * the two evils.
 */
function mergeUndersized(
  content: string,
  chunks: WorkingChunk[],
  minTokens: number,
  count: TokenCounter,
): number {
  if (minTokens <= 0) return 0;

  let merged = 0;
  let i = 0;
  while (chunks.length > 1 && i < chunks.length) {
    const chunk = chunks[i];
    if (!chunk || chunk.tokenCount >= minTokens) {
      i += 1;
      continue;
    }

    if (i > 0) {
      const previous = chunks[i - 1];
      if (!previous) break;
      previous.charEnd = Math.max(previous.charEnd, chunk.charEnd);
      previous.text = content.slice(previous.charStart, previous.charEnd);
      previous.tokenCount = count(previous.text);
      chunks.splice(i, 1);
    } else {
      const next = chunks[1];
      if (!next) break;
      next.charStart = Math.min(next.charStart, chunk.charStart);
      next.text = content.slice(next.charStart, next.charEnd);
      next.tokenCount = count(next.text);
      next.headingPath = chunk.headingPath;
      chunks.splice(0, 1);
    }
    merged += 1;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Shrink a span to its non-whitespace core. Null when nothing is left. */
function trimSpan(content: string, start: number, end: number): Span | null {
  let from = Math.max(0, start);
  let to = Math.min(content.length, end);
  while (from < to && WHITESPACE.test(content.charAt(from))) from += 1;
  while (to > from && WHITESPACE.test(content.charAt(to - 1))) to -= 1;
  return to > from ? { start: from, end: to } : null;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Strip tags and decode the handful of entities that actually show up in headings. */
function htmlToText(html: string): string {
  const withoutTags = html.replace(/<[^>]*>/g, '');
  const decoded = withoutTags.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (whole: string, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return fromCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
      }
      if (body.startsWith('#')) {
        return fromCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
      }
      return HTML_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
  return decoded.replace(/\s+/g, ' ').trim();
}

function fromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
  return String.fromCodePoint(code);
}
