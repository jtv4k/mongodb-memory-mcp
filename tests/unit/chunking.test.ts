/**
 * Unit tests for the pure chunking module.
 *
 * The point of these is not coverage, it is the invariants: a chunk's offsets
 * must address the exact source text, the chunker must always move forward, and
 * structure (headings, fences) must survive splitting. Everything here runs with
 * zero infrastructure — no database, no network, no clock.
 */
import { describe, expect, it } from 'vitest';

import {
  CHUNKING_STRATEGIES,
  chunkContent,
  estimateTokens,
  parseMarkdownBlocks,
} from '../../src/chunking/index.js';
import type { ChunkingConfig } from '../../src/config/env.js';
import type { ChunkingResult, ContentType } from '../../src/domain/types.js';
import { ChunkingError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const README = [
  '# MongoDB RAG KB',
  '',
  'The knowledge base accepts content from AI clients over MCP, chunks it with a',
  'structure-aware splitter, embeds the chunks with Voyage and stores both the raw',
  'document and its chunks in MongoDB.',
  '',
  '## Install',
  '',
  'Two supported paths: a local Node process pointed at cloud Atlas, or the dev',
  'compose stack, which brings up Atlas Local so that vector search works with no',
  'cloud dependency at all.',
  '',
  '### Docker',
  '',
  'The dev compose file bind-mounts the source tree and runs tsx in watch mode, so',
  'edits made from the host IDE are picked up without rebuilding the image.',
  '',
  '#### Compose',
  '',
  '```yaml',
  'services:',
  '  app:',
  '    build:',
  '      target: dev',
  '    environment:',
  '      # this comment looks like a heading but it is not one',
  '      ## and neither is this',
  '      MONGODB_URI: mongodb://atlas:27017/?directConnection=true',
  '    depends_on:',
  '      - atlas',
  '```',
  '',
  'Wait for the health check to report ready before ingesting anything.',
  '',
  '### Manual',
  '',
  'Clone the repository, run the install, then start the watcher. The watcher',
  'restarts the process whenever a source file underneath src changes.',
  '',
  '## Search',
  '',
  'Hybrid search runs a vector aggregation and a text aggregation and fuses the',
  'two ranked lists with reciprocal rank fusion in application code.',
].join('\n');

const PROSE = [
  'Reciprocal rank fusion combines two ranked lists without requiring their scores',
  'to be comparable. That is exactly the property we need here, because one list',
  'comes from cosine similarity over embeddings and the other from BM25 relevance.',
  '',
  'The alternative would be score normalisation, which is fragile: the range of a',
  'vector score depends on the model, and the range of a text score depends on the',
  'corpus. Neither is stable across a re-embedding or across a bulk import.',
  '',
  'So the fusion happens in application code. It is a pure function of two ranked',
  'lists and a smoothing constant, which means it can be unit tested without any',
  'database at all, and it behaves identically on Atlas Local and on cloud Atlas.',
].join('\n');

const JSON_DOC = [
  '{',
  '  "alpha": {',
  '    "description": "the first service defined in the compose file",',
  '    "ports": [27017, 27027]',
  '  },',
  '  "beta": {',
  '    "description": "the second service defined in the compose file",',
  '    "ports": [3000]',
  '  }',
  '}',
].join('\n');

const UNICODE = [
  '# 使用指南 🚀',
  '',
  'この文書は日本語と絵文字 👩‍💻 を含みます。オフセットは UTF-16 コード単位で数えます。',
  '',
  'Ünïcödé combining marks such as é and à must survive the splitter.',
].join('\n');

const config = (overrides: Partial<ChunkingConfig> = {}): ChunkingConfig => ({
  chunkSizeTokens: 120,
  chunkOverlapTokens: 24,
  minChunkTokens: 16,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/**
 * Every invariant the module documents, checked on every chunk. Called from
 * most tests so that a regression shows up wherever it is introduced.
 */
function expectChunkInvariants(content: string, result: ChunkingResult): void {
  const { chunks } = result;
  expect(chunks.length).toBeGreaterThan(0);

  let previousStart = -1;
  let previousEnd = -1;
  for (const [i, chunk] of chunks.entries()) {
    expect(chunk.index).toBe(i);
    expect(chunk.charStart).toBeGreaterThanOrEqual(0);
    expect(chunk.charStart).toBeLessThan(chunk.charEnd);
    expect(chunk.charEnd).toBeLessThanOrEqual(content.length);

    // The load-bearing invariant: offsets address the exact source text.
    expect(chunk.text).toBe(content.slice(chunk.charStart, chunk.charEnd));
    expect(chunk.text).toBe(chunk.text.trim());
    expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    expect(Array.isArray(chunk.headingPath)).toBe(true);

    // Forward progress, in both directions.
    expect(chunk.charStart).toBeGreaterThan(previousStart);
    expect(chunk.charEnd).toBeGreaterThan(previousEnd);

    // Nothing but whitespace may be dropped between consecutive chunks.
    if (i > 0 && chunk.charStart > previousEnd) {
      expect(content.slice(previousEnd, chunk.charStart).trim()).toBe('');
    }

    previousStart = chunk.charStart;
    previousEnd = chunk.charEnd;
  }

  expect(chunks[0]?.charStart).toBe(content.length - content.trimStart().length);
  expect(chunks.at(-1)?.charEnd).toBe(content.trimEnd().length);

  expect(result.stats.inputChars).toBe(content.length);
  expect(result.stats.chunkCount).toBe(chunks.length);
  expect(result.stats.totalTokens).toBe(
    chunks.reduce((total, chunk) => total + chunk.tokenCount, 0),
  );
  expect(result.stats.mergedUndersized).toBeGreaterThanOrEqual(0);
}

/** True when `offset` is preceded only by blanks back to a line break. */
function startsALine(content: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i -= 1) {
    const ch = content.charAt(i);
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

/** True when `offset` is followed only by blanks up to a line break. */
function endsALine(content: string, offset: number): boolean {
  for (let i = offset; i < content.length; i += 1) {
    const ch = content.charAt(i);
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function fenceBlockOf(content: string): { start: number; end: number } {
  const fences = parseMarkdownBlocks(content).filter((block) => block.kind === 'fence');
  expect(fences).toHaveLength(1);
  const fence = fences[0];
  if (!fence) throw new Error('fixture has no fenced code block');
  return { start: fence.start, end: fence.end };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns zero for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('lands on the BPE count for the canonical pangram', () => {
    // cl100k_base tokenises this as exactly 10 tokens.
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.')).toBe(10);
  });

  it('stays within 15% of a hand-counted BPE figure for a prose sentence', () => {
    const sentence =
      'MongoDB MongoDB Vector Search enables semantic retrieval over embeddings ' +
      'stored alongside your operational data.';
    // cl100k_base: 16 tokens.
    const estimate = estimateTokens(sentence);
    expect(estimate).toBeGreaterThanOrEqual(Math.floor(16 * 0.85));
    expect(estimate).toBeLessThanOrEqual(Math.ceil(16 * 1.15));
  });

  it('counts CJK per character', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('東京')).toBe(2);
  });

  it('is additive across cuts made at whitespace, which the packer relies on', () => {
    expect(estimateTokens('alpha beta')).toBe(estimateTokens('alpha') + estimateTokens(' beta'));
    expect(estimateTokens('one\n\ntwo')).toBe(estimateTokens('one') + estimateTokens('\n\ntwo'));
  });

  it('applies the chars-per-token correction to unmergeable long runs', () => {
    // 2 tokens for the first 12 characters, then one per four.
    expect(estimateTokens('x'.repeat(1000))).toBe(2 + Math.ceil(988 / 4));
    expect(estimateTokens('x'.repeat(1000))).toBeGreaterThan(estimateTokens('x'.repeat(100)));
  });

  it('is deterministic', () => {
    expect(estimateTokens(README)).toBe(estimateTokens(README));
  });
});

// ---------------------------------------------------------------------------
// Markdown structure
// ---------------------------------------------------------------------------

describe('parseMarkdownBlocks', () => {
  it('builds a heading breadcrumb that pushes on deeper and pops on shallower', () => {
    const headings = parseMarkdownBlocks(README)
      .filter((block) => block.kind === 'heading')
      .map((block) => block.headingPath);

    expect(headings).toEqual([
      ['MongoDB RAG KB'],
      ['MongoDB RAG KB', 'Install'],
      ['MongoDB RAG KB', 'Install', 'Docker'],
      ['MongoDB RAG KB', 'Install', 'Docker', 'Compose'],
      ['MongoDB RAG KB', 'Install', 'Manual'],
      ['MongoDB RAG KB', 'Search'],
    ]);
  });

  it('does not treat heading-looking lines inside a fence as headings', () => {
    const paths = parseMarkdownBlocks(README).map((block) => block.headingPath.join(' > '));
    expect(paths.some((path) => path.includes('this comment looks like a heading'))).toBe(false);
    expect(paths.some((path) => path.includes('and neither is this'))).toBe(false);

    const fence = fenceBlockOf(README);
    const text = README.slice(fence.start, fence.end);
    expect(text.startsWith('```yaml')).toBe(true);
    expect(text.endsWith('```')).toBe(true);
    expect(text).toContain('# this comment looks like a heading but it is not one');
  });

  it('recognises setext headings and keeps the paragraph above them separate', () => {
    const doc = [
      'Overview',
      '========',
      '',
      'Intro line.',
      '',
      'Details',
      '-------',
      '',
      'Body.',
    ].join('\n');
    const headings = parseMarkdownBlocks(doc)
      .filter((block) => block.kind === 'heading')
      .map((block) => block.headingPath);
    expect(headings).toEqual([['Overview'], ['Overview', 'Details']]);
  });

  it('keeps YAML front matter opaque so its keys never become headings', () => {
    const doc = [
      '---',
      'title: Runbook',
      'tags: [ops]',
      '---',
      '',
      '# Real Heading',
      '',
      'Body.',
    ].join('\n');
    const headings = parseMarkdownBlocks(doc)
      .filter((block) => block.kind === 'heading')
      .map((block) => block.headingPath);
    expect(headings).toEqual([['Real Heading']]);
  });

  it('treats an unterminated fence as running to the end of the document', () => {
    const doc = ['# Title', '', '```sh', 'echo hi', '# still code'].join('\n');
    const fences = parseMarkdownBlocks(doc).filter((block) => block.kind === 'fence');
    expect(fences).toHaveLength(1);
    expect(fences[0]?.end).toBe(doc.length);
  });
});

// ---------------------------------------------------------------------------
// chunkContent — degenerate input
// ---------------------------------------------------------------------------

describe('chunkContent degenerate input', () => {
  it('throws ChunkingError on empty content', () => {
    expect(() => chunkContent({ content: '', contentType: 'text', options: config() })).toThrow(
      ChunkingError,
    );
  });

  it('throws ChunkingError on whitespace-only content', () => {
    expect(() =>
      chunkContent({ content: '  \n\t\r\n   \n ', contentType: 'markdown', options: config() }),
    ).toThrow(ChunkingError);
  });

  it('rejects a non-positive chunk size rather than looping', () => {
    expect(() =>
      chunkContent({
        content: 'anything at all',
        contentType: 'text',
        options: config({ chunkSizeTokens: 0, chunkOverlapTokens: 0, minChunkTokens: 0 }),
      }),
    ).toThrow(ChunkingError);
  });

  it('still chunks a single enormous word through the hard-cut fallback', () => {
    const content = 'x'.repeat(50_000);
    const options = config({ chunkSizeTokens: 120, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content, contentType: 'text', options });

    expectChunkInvariants(content, result);
    expect(result.chunks.length).toBeGreaterThan(10);
    for (const chunk of result.chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(120);
    // No overlap is possible without a boundary, so the pieces tile exactly.
    expect(result.chunks.map((chunk) => chunk.text).join('')).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// chunkContent — strategy selection
// ---------------------------------------------------------------------------

describe('chunkContent strategy selection', () => {
  const cases: Array<{ contentType: ContentType; content: string; strategy: string }> = [
    {
      contentType: 'markdown',
      content: '# Title\n\nSome body text here.',
      strategy: CHUNKING_STRATEGIES.markdown,
    },
    {
      contentType: 'code',
      content: 'const a = 1;\n\nconst b = 2;\n',
      strategy: CHUNKING_STRATEGIES.code,
    },
    {
      contentType: 'html',
      content: '<h1>Title</h1><p>Some body text.</p>',
      strategy: CHUNKING_STRATEGIES.html,
    },
    {
      contentType: 'json',
      content: '[{"a":1},{"b":2}]',
      strategy: CHUNKING_STRATEGIES.jsonElements,
    },
    {
      contentType: 'json',
      content: '{oops, not json at all',
      strategy: CHUNKING_STRATEGIES.jsonLines,
    },
    {
      contentType: 'text',
      content: 'A paragraph.\n\nAnother paragraph.',
      strategy: CHUNKING_STRATEGIES.text,
    },
  ];

  for (const { contentType, content, strategy } of cases) {
    it(`selects ${strategy} for ${contentType}`, () => {
      const result = chunkContent({ content, contentType, options: config() });
      expect(result.strategy).toBe(strategy);
      expectChunkInvariants(content, result);
    });
  }

  it('gives every strategy a distinct name', () => {
    const names = Object.values(CHUNKING_STRATEGIES);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// chunkContent — markdown
// ---------------------------------------------------------------------------

describe('chunkContent markdown', () => {
  it('carries the enclosing heading breadcrumb on chunks', () => {
    const options = config({ chunkSizeTokens: 30, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content: README, contentType: 'markdown', options });

    expectChunkInvariants(README, result);
    expect(result.strategy).toBe(CHUNKING_STRATEGIES.markdown);
    expect(
      result.chunks.some(
        (chunk) => chunk.headingPath.join('/') === 'MongoDB RAG KB/Install/Docker/Compose',
      ),
    ).toBe(true);
    expect(
      result.chunks.some((chunk) => chunk.headingPath.join('/') === 'MongoDB RAG KB/Search'),
    ).toBe(true);
  });

  it('never splits a fenced code block that fits inside one chunk', () => {
    const fence = fenceBlockOf(README);
    const fenceText = README.slice(fence.start, fence.end);
    const fenceTokens = estimateTokens(fenceText);
    const options = config({
      chunkSizeTokens: fenceTokens + 200,
      chunkOverlapTokens: 24,
      minChunkTokens: 16,
    });

    const result = chunkContent({ content: README, contentType: 'markdown', options });
    expectChunkInvariants(README, result);
    expect(result.chunks.some((chunk) => chunk.text.includes(fenceText))).toBe(true);
  });

  it('keeps a fence whole even when it no longer fits beside an overlap prefix', () => {
    const fence = fenceBlockOf(README);
    const fenceText = README.slice(fence.start, fence.end);
    const fenceTokens = estimateTokens(fenceText);
    // Packing budget (size - overlap) is below the fence, the ceiling is above it:
    // exactly the case where the chunker must drop the overlap to stay intact.
    const options = config({
      chunkSizeTokens: fenceTokens + 5,
      chunkOverlapTokens: 20,
      minChunkTokens: 1,
    });

    const result = chunkContent({ content: README, contentType: 'markdown', options });
    expectChunkInvariants(README, result);
    expect(result.chunks.filter((chunk) => chunk.text === fenceText)).toHaveLength(1);
  });

  it('splits an oversized fence only at line boundaries', () => {
    const fence = fenceBlockOf(README);
    const fenceTokens = estimateTokens(README.slice(fence.start, fence.end));
    const options = config({
      chunkSizeTokens: Math.max(10, Math.floor(fenceTokens / 3)),
      chunkOverlapTokens: 0,
      minChunkTokens: 1,
    });

    const result = chunkContent({ content: README, contentType: 'markdown', options });
    expectChunkInvariants(README, result);

    const inFence = result.chunks.filter(
      (chunk) => chunk.charStart >= fence.start && chunk.charEnd <= fence.end,
    );
    expect(inFence.length).toBeGreaterThan(1);
    for (const chunk of inFence) {
      expect(startsALine(README, chunk.charStart)).toBe(true);
      expect(endsALine(README, chunk.charEnd)).toBe(true);
    }
  });

  it('produces identical output for identical input', () => {
    const options = config({ chunkSizeTokens: 90, chunkOverlapTokens: 18, minChunkTokens: 10 });
    const first = chunkContent({ content: README, contentType: 'markdown', options });
    const second = chunkContent({ content: README, contentType: 'markdown', options });
    expect(second).toEqual(first);
  });

  it('handles CRLF line endings without corrupting offsets', () => {
    const content = README.replace(/\n/g, '\r\n');
    const options = config({ chunkSizeTokens: 60, chunkOverlapTokens: 12, minChunkTokens: 8 });
    const result = chunkContent({ content, contentType: 'markdown', options });

    expectChunkInvariants(content, result);
    for (const chunk of result.chunks) {
      expect(chunk.text.startsWith('\r')).toBe(false);
      expect(chunk.text.endsWith('\r')).toBe(false);
    }
    expect(
      result.chunks.some((chunk) => chunk.headingPath.join('/').endsWith('Docker/Compose')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chunkContent — overlap
// ---------------------------------------------------------------------------

describe('chunkContent overlap', () => {
  it('repeats a boundary-aligned suffix of the previous chunk', () => {
    const overlapTokens = 12;
    const options = config({
      chunkSizeTokens: 40,
      chunkOverlapTokens: overlapTokens,
      minChunkTokens: 1,
    });
    const result = chunkContent({ content: PROSE, contentType: 'text', options });
    expectChunkInvariants(PROSE, result);
    expect(result.chunks.length).toBeGreaterThan(2);

    let overlapping = 0;
    for (let i = 1; i < result.chunks.length; i += 1) {
      const previous = result.chunks[i - 1];
      const chunk = result.chunks[i];
      if (!previous || !chunk) continue;
      if (chunk.charStart >= previous.charEnd) continue;
      overlapping += 1;

      const repeated = PROSE.slice(chunk.charStart, previous.charEnd);
      expect(previous.text.endsWith(repeated)).toBe(true);
      expect(chunk.text.startsWith(repeated)).toBe(true);
      // Cut on a boundary, never mid-word, and never more than the budget.
      expect(/\s/.test(PROSE.charAt(chunk.charStart - 1))).toBe(true);
      expect(estimateTokens(repeated)).toBeLessThanOrEqual(overlapTokens);
    }
    expect(overlapping).toBeGreaterThan(0);
  });

  it('keeps the whole chunk, overlap included, inside the token ceiling', () => {
    const options = config({ chunkSizeTokens: 45, chunkOverlapTokens: 15, minChunkTokens: 1 });
    const result = chunkContent({ content: PROSE, contentType: 'text', options });
    expectChunkInvariants(PROSE, result);
    for (const chunk of result.chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(45);
  });

  it('makes forward progress under a pathological overlap configuration', () => {
    // overlap = size - 1 is the configuration that hangs a naive chunker.
    const options = config({ chunkSizeTokens: 10, chunkOverlapTokens: 9, minChunkTokens: 1 });
    const result = chunkContent({ content: PROSE, contentType: 'text', options });

    expectChunkInvariants(PROSE, result);
    expect(result.chunks.length).toBeLessThan(PROSE.length);
  });

  it('emits no overlap when the overlap budget is zero', () => {
    const options = config({ chunkSizeTokens: 40, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content: PROSE, contentType: 'text', options });
    expectChunkInvariants(PROSE, result);
    for (let i = 1; i < result.chunks.length; i += 1) {
      const previous = result.chunks[i - 1];
      const chunk = result.chunks[i];
      if (!previous || !chunk) continue;
      expect(chunk.charStart).toBeGreaterThanOrEqual(previous.charEnd);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkContent — minimum size
// ---------------------------------------------------------------------------

describe('chunkContent minimum chunk size', () => {
  it('merges an undersized trailing chunk into its neighbour and counts it', () => {
    // 100 one-token words split into two full 50-token chunks, then a two-token
    // tail that cannot stand on its own.
    const content = `${Array.from({ length: 100 }, () => 'word').join(' ')}\n\nEnd.`;
    const options = config({ chunkSizeTokens: 50, chunkOverlapTokens: 0, minChunkTokens: 10 });
    const result = chunkContent({ content, contentType: 'text', options });

    expectChunkInvariants(content, result);
    expect(result.chunks).toHaveLength(2);
    expect(result.stats.mergedUndersized).toBe(1);
    expect(result.chunks[1]?.text.endsWith('End.')).toBe(true);
    for (const chunk of result.chunks) expect(chunk.tokenCount).toBeGreaterThanOrEqual(10);
  });

  it('leaves a single short document as one chunk rather than dropping it', () => {
    const content = 'Just a note.';
    const options = config({ chunkSizeTokens: 50, chunkOverlapTokens: 0, minChunkTokens: 40 });
    const result = chunkContent({ content, contentType: 'text', options });

    expectChunkInvariants(content, result);
    expect(result.chunks).toHaveLength(1);
    expect(result.stats.mergedUndersized).toBe(0);
  });

  it('never leaves an undersized chunk behind when several could merge', () => {
    const options = config({ chunkSizeTokens: 40, chunkOverlapTokens: 8, minChunkTokens: 20 });
    const result = chunkContent({ content: README, contentType: 'markdown', options });

    expectChunkInvariants(README, result);
    if (result.chunks.length > 1) {
      for (const chunk of result.chunks) expect(chunk.tokenCount).toBeGreaterThanOrEqual(20);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkContent — non-markdown content types
// ---------------------------------------------------------------------------

describe('chunkContent code', () => {
  const SOURCE = [
    'import { z } from "zod";',
    '',
    'export const schema = z.object({',
    '  sourceId: z.string().min(1),',
    '  title: z.string().min(1),',
    '});',
    '',
    'export function parse(input: unknown) {',
    '  const parsed = schema.safeParse(input);',
    '  if (!parsed.success) throw new Error("bad input");',
    '  return parsed.data;',
    '}',
  ].join('\n');

  it('splits between whole lines and never inside one', () => {
    const options = config({ chunkSizeTokens: 20, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content: SOURCE, contentType: 'code', options });

    expectChunkInvariants(SOURCE, result);
    expect(result.strategy).toBe(CHUNKING_STRATEGIES.code);
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(startsALine(SOURCE, chunk.charStart)).toBe(true);
      expect(endsALine(SOURCE, chunk.charEnd)).toBe(true);
    }
  });
});

describe('chunkContent html', () => {
  const PAGE = '<h1>Guide</h1><p>Intro paragraph.</p><h2>Setup</h2><p>Do the thing first.</p>';

  it('breaks on block-level tags and derives the breadcrumb from h1-h6', () => {
    const options = config({ chunkSizeTokens: 12, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content: PAGE, contentType: 'html', options });

    expectChunkInvariants(PAGE, result);
    expect(result.strategy).toBe(CHUNKING_STRATEGIES.html);
    expect(result.chunks.some((chunk) => chunk.headingPath.join('/') === 'Guide')).toBe(true);
    expect(result.chunks.some((chunk) => chunk.headingPath.join('/') === 'Guide/Setup')).toBe(true);
  });

  it('decodes entities and strips inline tags out of heading titles', () => {
    const page = '<h1>Tips &amp; <em>Tricks</em></h1><p>Body text goes here.</p>';
    const options = config({ chunkSizeTokens: 12, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content: page, contentType: 'html', options });
    expect(result.chunks.some((chunk) => chunk.headingPath.includes('Tips & Tricks'))).toBe(true);
  });
});

describe('chunkContent json', () => {
  it('splits on top-level entries and uses the key as the breadcrumb', () => {
    const options = config({ chunkSizeTokens: 40, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content: JSON_DOC, contentType: 'json', options });

    expectChunkInvariants(JSON_DOC, result);
    expect(result.strategy).toBe(CHUNKING_STRATEGIES.jsonElements);
    expect(result.chunks.some((chunk) => chunk.headingPath.join('/') === 'alpha')).toBe(true);
    expect(result.chunks.some((chunk) => chunk.headingPath.join('/') === 'beta')).toBe(true);
  });

  it('keeps a top-level array element whole when it fits', () => {
    const content = JSON.stringify(
      [
        { id: 1, note: 'the first record, long enough to matter for chunk sizing' },
        { id: 2, note: 'the second record, also long enough to matter for sizing' },
      ],
      null,
      2,
    );
    const options = config({ chunkSizeTokens: 60, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content, contentType: 'json', options });

    expectChunkInvariants(content, result);
    expect(result.chunks.some((chunk) => chunk.text.includes('"id": 1'))).toBe(true);
    expect(result.chunks.some((chunk) => chunk.text.includes('"id": 2'))).toBe(true);
  });

  it('falls back to line splitting, under its own strategy name, for invalid JSON', () => {
    const content = ['{', '  "broken": ', '  no closing brace here'].join('\n');
    const options = config({ chunkSizeTokens: 20, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content, contentType: 'json', options });

    expectChunkInvariants(content, result);
    expect(result.strategy).toBe(CHUNKING_STRATEGIES.jsonLines);
  });
});

// ---------------------------------------------------------------------------
// Unicode
// ---------------------------------------------------------------------------

describe('chunkContent unicode', () => {
  it('keeps code-unit offsets exact across CJK, emoji and combining marks', () => {
    const options = config({ chunkSizeTokens: 25, chunkOverlapTokens: 5, minChunkTokens: 1 });
    const result = chunkContent({ content: UNICODE, contentType: 'markdown', options });

    expectChunkInvariants(UNICODE, result);
    for (const chunk of result.chunks) {
      expect(LONE_SURROGATE.test(chunk.text)).toBe(false);
    }
    expect(result.chunks.map((chunk) => chunk.text).join('')).toContain('👩‍💻');
  });

  it('never cuts a surrogate pair in half when hard-cutting', () => {
    const content = '🚀'.repeat(3000);
    const options = config({ chunkSizeTokens: 100, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const result = chunkContent({ content, contentType: 'text', options });

    expectChunkInvariants(content, result);
    expect(result.chunks.length).toBeGreaterThan(10);
    for (const chunk of result.chunks) {
      expect(LONE_SURROGATE.test(chunk.text)).toBe(false);
    }
    expect(result.chunks.map((chunk) => chunk.text).join('')).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Swappable token counter
// ---------------------------------------------------------------------------

describe('chunkContent token counter injection', () => {
  it('sizes chunks with the supplied counter instead of the default heuristic', () => {
    const options = config({ chunkSizeTokens: 40, chunkOverlapTokens: 0, minChunkTokens: 1 });
    const oneTokenPerCharacter = chunkContent({
      content: PROSE,
      contentType: 'text',
      options,
      countTokens: (text) => text.length,
    });
    const heuristic = chunkContent({ content: PROSE, contentType: 'text', options });

    // A character-per-token counter fills a 40-token budget far sooner.
    expect(oneTokenPerCharacter.chunks.length).toBeGreaterThan(heuristic.chunks.length);
    // `tokenCount` reports whichever counter was actually used to size the chunk.
    for (const chunk of oneTokenPerCharacter.chunks) {
      expect(chunk.tokenCount).toBe(chunk.text.length);
    }
    for (const chunk of heuristic.chunks) {
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.text));
    }
  });
});
