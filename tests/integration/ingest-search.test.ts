/**
 * The core round trip: `store_content` → `search_knowledge`, against
 * a real Atlas Local with a real MongoDB Vector Search index.
 *
 * Nothing here is mocked except the embedding vendor. In particular the vector
 * leg genuinely runs `$vectorSearch`: `vectorScore` is projected from
 * `$meta: 'vectorSearchScore'`, a value MongoDB only produces from that stage, so
 * a non-null score on every hit is proof the index was queried rather than an
 * accident of a fallback path.
 *
 * Search limits are tightened for this file (`SEARCH_DEFAULT_LIMIT` 4,
 * `SEARCH_MAX_LIMIT` 6) so clamping can be asserted exactly against a 13-chunk
 * corpus instead of "some number under fifty".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SearchHit, StoreContentResult } from '../../src/domain/types.js';
import {
  ALL_FIXTURES,
  ATLAS_GUIDE,
  INCIDENT_RUNBOOK,
  PIPELINE_SNIPPET,
  QUERIES,
  expectedChunking,
  searchInput,
  storeInput,
} from './helpers/fixtures.js';
import { chunksOf, createHarness, type Harness } from './helpers/harness.js';

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 6;

let h: Harness;
const stored = new Map<string, StoreContentResult>();

function requireHit(hits: readonly SearchHit[], index = 0): SearchHit {
  const hit = hits[index];
  if (!hit) throw new Error(`expected a hit at position ${index}, got ${hits.length} hits`);
  return hit;
}

/** 0-based position of the first hit satisfying `match`, or -1. */
function rankOf(hits: readonly SearchHit[], match: (hit: SearchHit) => boolean): number {
  return hits.findIndex(match);
}

const inSection = (heading: string) => (hit: SearchHit) => hit.headingPath.includes(heading);

beforeAll(async () => {
  h = await createHarness({
    env: { SEARCH_DEFAULT_LIMIT: String(DEFAULT_LIMIT), SEARCH_MAX_LIMIT: String(MAX_LIMIT) },
  });

  for (const fixture of ALL_FIXTURES) {
    const result = await h.service.storeContent(storeInput(fixture), h.context());
    stored.set(fixture.sourceId, result);
  }

  // MongoDB Search is eventually consistent: poll each source into both indexes
  // rather than sleeping and hoping.
  for (const fixture of ALL_FIXTURES) {
    const result = stored.get(fixture.sourceId);
    await h.waitForIndexedChunks(fixture.sourceId, result?.chunkCount ?? 0);
  }
});

afterAll(async () => {
  await h?.teardown();
});

describe('ingestion', () => {
  it('chunks with the requested options and reports what it did', () => {
    const input = storeInput(ATLAS_GUIDE);
    const expectedChunks = expectedChunking(input, h.config).chunks.length;
    const result = stored.get(ATLAS_GUIDE.sourceId);

    expect(result).toBeDefined();
    expect(result?.outcome).toBe('created');
    expect(result?.version).toBe(1);
    expect(result?.chunkCount).toBe(expectedChunks);
    expect(result?.chunkingStrategy).toBe('markdown-structural');
    expect(result?.embedding).toEqual({
      provider: 'fake',
      model: h.config.embedding.model,
      dimensions: h.config.embedding.dimensions,
    });
    expect(result?.totalTokensEmbedded).toBeGreaterThan(0);
  });

  it('keeps chunks in their own collection, never as an array on the document', async () => {
    const document = await h.documents.findOne({ sourceId: ATLAS_GUIDE.sourceId });
    expect(document).not.toBeNull();

    // The unbounded-array anti-pattern, asserted directly on the raw row.
    expect(document).not.toHaveProperty('chunks');
    expect(document).not.toHaveProperty('embedding.vector');
    expect(document?.content).toBe(ATLAS_GUIDE.content);
    expect(document?.contentLength).toBe(ATLAS_GUIDE.content.length);

    const rows = await chunksOf(h, ATLAS_GUIDE.sourceId);
    expect(rows).toHaveLength(stored.get(ATLAS_GUIDE.sourceId)?.chunkCount ?? -1);

    for (const [index, row] of rows.entries()) {
      expect(row.documentId.toHexString()).toBe(stored.get(ATLAS_GUIDE.sourceId)?.documentId);
      expect(row.chunkIndex).toBe(index);
      // Denormalised attribution, so a hit needs no $lookup.
      expect(row.title).toBe(ATLAS_GUIDE.title);
      expect(row.uri).toBe(ATLAS_GUIDE.uri);
      expect(row.contentType).toBe('markdown');
      expect(row.tags).toEqual(ATLAS_GUIDE.tags);
      // Flat, filterable provenance.
      expect(row.embeddingProvider).toBe('fake');
      expect(row.embeddingModel).toBe(h.config.embedding.model);
      expect(row.embeddingDimensions).toBe(h.config.embedding.dimensions);
      expect(row.embedding).toHaveLength(h.config.embedding.dimensions);
      expect(row.embeddedAt).toBeInstanceOf(Date);
    }
  });

  it('records character offsets that slice the original content exactly', async () => {
    const detail = await h.service.getDocument(ATLAS_GUIDE.sourceId, h.context());
    expect(detail).not.toBeNull();

    const content = detail?.document.content ?? '';
    let previousStart = -1;
    let previousEnd = -1;

    for (const chunk of detail?.chunks ?? []) {
      expect(content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
      expect(chunk.charStart).toBeLessThan(chunk.charEnd);
      expect(chunk.charEnd).toBeLessThanOrEqual(content.length);
      expect(chunk.charStart).toBeGreaterThan(previousStart);
      expect(chunk.charEnd).toBeGreaterThan(previousEnd);
      previousStart = chunk.charStart;
      previousEnd = chunk.charEnd;
    }

    const paths = (detail?.chunks ?? []).map((chunk) => chunk.headingPath);
    expect(paths.every((path) => path[0] === 'MongoDB Atlas Operations Guide')).toBe(true);
    expect(paths.some((path) => path.includes('Replica sets and the oplog'))).toBe(true);
    expect(paths.some((path) => path.includes('Vector search indexes'))).toBe(true);
  });

  it('re-storing identical content is a no-op that keeps the same chunk ids', async () => {
    const before = await chunksOf(h, ATLAS_GUIDE.sourceId);
    const documentBefore = await h.documents.findOne({ sourceId: ATLAS_GUIDE.sourceId });

    const result = await h.service.storeContent(storeInput(ATLAS_GUIDE), h.context());

    expect(result.outcome).toBe('unchanged');
    expect(result.version).toBe(1);
    expect(result.chunkCount).toBe(before.length);
    expect(result.totalTokensEmbedded).toBe(0);

    const after = await chunksOf(h, ATLAS_GUIDE.sourceId);
    expect(after.map((row) => row._id.toHexString())).toEqual(
      before.map((row) => row._id.toHexString()),
    );

    const documentAfter = await h.documents.findOne({ sourceId: ATLAS_GUIDE.sourceId });
    expect(documentAfter?.updatedAt).toEqual(documentBefore?.updatedAt);
    expect(documentAfter?._id.toHexString()).toBe(documentBefore?._id.toHexString());
  });
});

describe('vector search', () => {
  it('queries the real vector index and returns scored, attributed hits', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERIES.oplog, { mode: 'vector', limit: MAX_LIMIT }),
      h.context(),
    );

    expect(result.mode).toBe('vector');
    expect(result.effectiveMode).toBe('vector');
    expect(result.embedding).toEqual({
      model: h.config.embedding.model,
      dimensions: h.config.embedding.dimensions,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.totalHits).toBe(result.hits.length);

    result.hits.forEach((hit, index) => {
      // `$meta: 'vectorSearchScore'` exists only inside a $vectorSearch pipeline,
      // so a real number here is proof the vector index was queried.
      expect(hit.vectorScore).not.toBeNull();
      expect(hit.vectorScore ?? 0).toBeGreaterThan(0);
      expect(hit.vectorScore ?? 0).toBeLessThanOrEqual(1);
      expect(hit.vectorRank).toBe(index + 1);
      // The text leg is skipped entirely in vector mode.
      expect(hit.textScore).toBeNull();
      expect(hit.textRank).toBeNull();
      // Single-strategy searches report that strategy's own score, not RRF.
      expect(hit.score).toBe(hit.vectorScore);
    });

    const scores = result.hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const top = requireHit(result.hits);
    expect(top.sourceId).toBe(ATLAS_GUIDE.sourceId);
    expect(top.title).toBe(ATLAS_GUIDE.title);
    expect(top.uri).toBe(ATLAS_GUIDE.uri);
    expect(top.contentType).toBe('markdown');
    expect(top.tags).toEqual(ATLAS_GUIDE.tags);
    expect(top.chunkId).toMatch(/^[0-9a-f]{24}$/u);
    expect(top.documentId).toBe(stored.get(ATLAS_GUIDE.sourceId)?.documentId);
    expect(top.text.length).toBeGreaterThan(0);
    expect(top.highlights.length).toBeGreaterThan(0);
  });

  it('ranks the section that shares the query vocabulary above unrelated ones', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERIES.oplog, { mode: 'vector', limit: MAX_LIMIT }),
      h.context(),
    );

    const oplogRank = rankOf(result.hits, inSection('Replica sets and the oplog'));
    const shardingRank = rankOf(result.hits, inSection('Sharding and the shard key'));
    const codeRank = rankOf(result.hits, (hit) => hit.sourceId === PIPELINE_SNIPPET.sourceId);

    // Robust rather than brittle: top-2, and strictly ahead of the clearly
    // unrelated sections, instead of pinning an exact ordering.
    expect(oplogRank).toBeGreaterThanOrEqual(0);
    expect(oplogRank).toBeLessThan(2);
    if (shardingRank >= 0) expect(oplogRank).toBeLessThan(shardingRank);
    if (codeRank >= 0) expect(oplogRank).toBeLessThan(codeRank);
  });

  it('retrieves the code snippet for a query drawn from its own vocabulary', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERIES.regionalSales, { mode: 'vector', limit: MAX_LIMIT }),
      h.context(),
    );

    const codeRank = rankOf(result.hits, (hit) => hit.sourceId === PIPELINE_SNIPPET.sourceId);
    expect(codeRank).toBeGreaterThanOrEqual(0);
    expect(codeRank).toBeLessThan(2);
    expect(requireHit(result.hits, codeRank).contentType).toBe('code');
  });
});

describe('text and hybrid search', () => {
  it('text-only mode returns MongoDB Search scores and highlight fragments', async () => {
    const result = await h.service.searchKnowledge(
      searchInput('oplog secondary election primary', { mode: 'text', limit: MAX_LIMIT }),
      h.context(),
    );

    expect(result.mode).toBe('text');
    expect(result.effectiveMode).toBe('text');
    expect(result.hits.length).toBeGreaterThan(0);

    result.hits.forEach((hit, index) => {
      expect(hit.textScore).not.toBeNull();
      // BM25 is unbounded, so the only safe claim is that it is positive.
      expect(hit.textScore ?? 0).toBeGreaterThan(0);
      expect(hit.textRank).toBe(index + 1);
      expect(hit.vectorScore).toBeNull();
      expect(hit.vectorRank).toBeNull();
      expect(hit.score).toBe(hit.textScore);
    });

    const top = requireHit(result.hits);
    expect(top.highlights.length).toBeGreaterThan(0);
    expect(top.highlights.join(' ').toLowerCase()).toMatch(/oplog|secondary|election|primary/u);
  });

  it('hybrid mode fuses both legs with reciprocal rank fusion', async () => {
    const result = await h.service.searchKnowledge(
      searchInput('oplog secondary election primary', { mode: 'hybrid', limit: MAX_LIMIT }),
      h.context(),
    );

    expect(result.mode).toBe('hybrid');
    // A degraded hybrid would report 'vector'; this asserts the text index is live.
    expect(result.effectiveMode).toBe('hybrid');
    expect(result.hits.length).toBeGreaterThan(0);

    const both = result.hits.filter((hit) => hit.vectorRank !== null && hit.textRank !== null);
    expect(both.length).toBeGreaterThan(0);

    const { rrfK, vectorWeight } = h.config.search;
    for (const hit of both) {
      const expectedScore =
        vectorWeight / (rrfK + (hit.vectorRank ?? 0)) +
        (1 - vectorWeight) / (rrfK + (hit.textRank ?? 0));
      expect(hit.score).toBeCloseTo(expectedScore, 12);
      // Fused scores live on a completely different scale from cosine.
      expect(hit.score).toBeLessThan(0.1);
      expect(hit.vectorScore ?? 0).toBeGreaterThan(0);
      expect(hit.textScore ?? 0).toBeGreaterThan(0);
    }

    const scores = result.hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('filters, limits and projections', () => {
  it('restricts by tags, sourceId and contentType', async () => {
    const unfiltered = await h.service.searchKnowledge(
      searchInput(QUERIES.escalation, { mode: 'vector', limit: MAX_LIMIT }),
      h.context(),
    );
    // Baseline: without a filter the result set really is mixed, so the filtered
    // runs below are proving something.
    expect(new Set(unfiltered.hits.map((hit) => hit.sourceId)).size).toBeGreaterThan(1);

    const byTag = await h.service.searchKnowledge(
      searchInput(QUERIES.escalation, {
        mode: 'vector',
        limit: MAX_LIMIT,
        filters: { tags: ['runbook'] },
      }),
      h.context(),
    );
    expect(byTag.hits.length).toBeGreaterThan(0);
    expect(new Set(byTag.hits.map((hit) => hit.sourceId))).toEqual(
      new Set([INCIDENT_RUNBOOK.sourceId]),
    );

    const bySource = await h.service.searchKnowledge(
      searchInput(QUERIES.escalation, {
        mode: 'vector',
        limit: MAX_LIMIT,
        filters: { sourceIds: [ATLAS_GUIDE.sourceId] },
      }),
      h.context(),
    );
    expect(bySource.hits.length).toBeGreaterThan(0);
    expect(new Set(bySource.hits.map((hit) => hit.sourceId))).toEqual(
      new Set([ATLAS_GUIDE.sourceId]),
    );

    const byContentType = await h.service.searchKnowledge(
      searchInput(QUERIES.escalation, {
        mode: 'vector',
        limit: MAX_LIMIT,
        filters: { contentTypes: ['code'] },
      }),
      h.context(),
    );
    expect(byContentType.hits.length).toBeGreaterThan(0);
    expect(byContentType.hits.every((hit) => hit.contentType === 'code')).toBe(true);

    const noMatch = await h.service.searchKnowledge(
      searchInput(QUERIES.escalation, {
        mode: 'vector',
        limit: MAX_LIMIT,
        filters: { tags: ['no-such-tag'] },
      }),
      h.context(),
    );
    expect(noMatch.hits).toEqual([]);
  });

  it('applies the configured default limit and clamps an oversized one', async () => {
    const byDefault = await h.service.searchKnowledge(
      searchInput(QUERIES.sharding, { mode: 'vector' }),
      h.context(),
    );
    expect(byDefault.hits).toHaveLength(DEFAULT_LIMIT);

    const clamped = await h.service.searchKnowledge(
      searchInput(QUERIES.sharding, { mode: 'vector', limit: 500 }),
      h.context(),
    );
    expect(clamped.hits).toHaveLength(MAX_LIMIT);

    const explicit = await h.service.searchKnowledge(
      searchInput(QUERIES.sharding, { mode: 'vector', limit: 2 }),
      h.context(),
    );
    expect(explicit.hits).toHaveLength(2);
  });

  it('drops hits below minScore', async () => {
    const baseline = await h.service.searchKnowledge(
      searchInput(QUERIES.sharding, { mode: 'vector', limit: MAX_LIMIT }),
      h.context(),
    );
    const scores = baseline.hits.map((hit) => hit.score);
    const best = Math.max(...scores);
    const worst = Math.min(...scores);
    expect(best).toBeGreaterThan(worst);

    const threshold = (best + worst) / 2;
    const filtered = await h.service.searchKnowledge(
      searchInput(QUERIES.sharding, { mode: 'vector', limit: MAX_LIMIT, minScore: threshold }),
      h.context(),
    );

    expect(filtered.hits.length).toBeGreaterThan(0);
    expect(filtered.hits.length).toBeLessThan(baseline.hits.length);
    expect(filtered.hits.every((hit) => hit.score >= threshold)).toBe(true);
  });

  it('includeText false omits the body but keeps attribution', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERIES.oplog, { mode: 'vector', limit: 3, includeText: false }),
      h.context(),
    );

    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.text).toBe('');
      expect(hit.sourceId.length).toBeGreaterThan(0);
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.chunkId).toMatch(/^[0-9a-f]{24}$/u);
    }
  });
});
