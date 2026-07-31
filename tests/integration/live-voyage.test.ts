/**
 * Opt-in: the real Voyage AI contextual embedding call, end to end.
 *
 * Skipped unless `VOYAGE_API_KEY` is present in the environment, so CI and every
 * ordinary local run never touch the network or spend money. The key is read
 * from `process.env` only — nothing here reads a `.env` file, and no key is ever
 * written into this repository.
 *
 * Note how the key reaches the harness: `createHarness` deliberately strips
 * `VOYAGE_API_KEY` from the inherited environment and pins the provider to
 * `fake`, precisely so a developer with a key exported in their shell cannot
 * accidentally bill a real account from the rest of the suite. This file is the
 * single place that opts back in, and it has to pass the key explicitly to do it.
 *
 * What it proves that the fake cannot: that `voyage-context-3` really accepts
 * chunks grouped by parent document, that the vectors come back at exactly
 * `EMBEDDING_DIMENSIONS` — the number the Atlas vector index was built with — and
 * that a query embedded with `input_type=query` retrieves the right section
 * through the same `$vectorSearch` pipeline the product uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StoreContentResult } from '../../src/domain/types.js';
import { ATLAS_GUIDE, QUERIES, searchInput, storeInput } from './helpers/fixtures.js';
import { chunksOf, createHarness, type Harness } from './helpers/harness.js';

const apiKey = process.env.VOYAGE_API_KEY;
const enabled = typeof apiKey === 'string' && apiKey.trim().length > 0;

let h: Harness;
let ingested: StoreContentResult;

describe.skipIf(!enabled)('live Voyage embeddings', () => {
  beforeAll(async () => {
    h = await createHarness({
      env: { EMBEDDING_PROVIDER: 'voyage', VOYAGE_API_KEY: apiKey ?? '' },
    });
    ingested = await h.service.storeContent(storeInput(ATLAS_GUIDE), h.context());
    await h.waitForIndexedChunks(ATLAS_GUIDE.sourceId, ingested.chunkCount);
  });

  afterAll(async () => {
    await h?.teardown();
  });

  it('is wired to the real provider, not the fake', () => {
    expect(h.config.embedding.provider).toBe('voyage');
    expect(h.embeddings.info.provider).toBe('voyage');
    expect(h.embeddings.info.model).toBe(h.config.embedding.model);
    // voyage-context-3 conditions each chunk on its siblings; that is the whole
    // reason the provider interface takes documents-of-chunks.
    expect(h.embeddings.info.contextual).toBe(true);
  });

  it('stores one contextual vector per chunk at exactly the configured width', async () => {
    expect(ingested.outcome).toBe('created');
    expect(ingested.embedding.provider).toBe('voyage');
    expect(ingested.embedding.dimensions).toBe(h.config.embedding.dimensions);
    expect(ingested.totalTokensEmbedded).toBeGreaterThan(0);

    const rows = await chunksOf(h, ATLAS_GUIDE.sourceId);
    expect(rows).toHaveLength(ingested.chunkCount);

    const fingerprints = new Set<string>();
    for (const row of rows) {
      // The coupling that matters: a mismatch here and $vectorSearch rejects
      // every query against the index.
      expect(row.embedding).toHaveLength(h.config.embedding.dimensions);
      expect(row.embedding.every((value) => Number.isFinite(value))).toBe(true);
      expect(row.embeddingProvider).toBe('voyage');
      expect(row.embeddingModel).toBe(h.config.embedding.model);
      expect(row.embeddingDimensions).toBe(h.config.embedding.dimensions);
      fingerprints.add(row.embedding.slice(0, 8).join(','));
    }

    // Distinct chunks must produce distinct vectors, or the contextual blend has
    // collapsed the document into a single point.
    expect(fingerprints.size).toBe(rows.length);
  });

  it('retrieves the right section through a real query embedding', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERIES.oplog, { mode: 'vector', limit: 5 }),
      h.context(),
    );

    expect(result.effectiveMode).toBe('vector');
    expect(result.embedding).toEqual({
      model: h.config.embedding.model,
      dimensions: h.config.embedding.dimensions,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => (hit.vectorScore ?? 0) > 0)).toBe(true);

    const oplogRank = result.hits.findIndex((hit) =>
      hit.headingPath.includes('Replica sets and the oplog'),
    );
    expect(oplogRank).toBeGreaterThanOrEqual(0);
    expect(oplogRank).toBeLessThan(2);
  });
});
