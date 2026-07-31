/**
 * The embedding-model migration path, end to end.
 *
 * Staleness is simulated the only honest way available offline: ingest with the
 * configured model, then rewrite the *provenance* fields on the stored chunks so
 * they look like the output of an older model. The vectors themselves are left
 * alone, which is exactly the state a real half-finished migration leaves behind
 * — and because `buildVectorFilter` pins `embeddingModel` and
 * `embeddingDimensions`, those chunks genuinely drop out of the search space
 * until they are re-embedded. The last test proves that round trip against the
 * real vector index rather than asserting it on the collection alone.
 *
 * Each test restores the corpus to a fully current state before it finishes, so
 * the file reads as a sequence of independent scenarios rather than a chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseInput, reembedSchema } from '../../src/domain/schemas.js';
import type { StoreContentResult } from '../../src/domain/types.js';
import { EmbeddingError } from '../../src/errors.js';
import type {
  DocumentEmbeddingResult,
  EmbedOptions,
  EmbeddingProvider,
  EmbeddingProviderInfo,
  QueryEmbeddingResult,
} from '../../src/embeddings/provider.js';
import {
  ATLAS_GUIDE,
  INCIDENT_RUNBOOK,
  PIPELINE_SNIPPET,
  QUERIES,
  searchInput,
  storeInput,
} from './helpers/fixtures.js';
import { chunksOf, createHarness, type Harness } from './helpers/harness.js';

/** A model name that is definitely not the configured one. */
const OLD_MODEL = 'voyage-context-2';
const OLD_DIMENSIONS = 512;

/** Appears in the guide and in neither of the other two fixtures. */
const GUIDE_ONLY_MARKER = 'shard key';

let h: Harness;
const stored = new Map<string, StoreContentResult>();

/**
 * An embedding provider that fails for one specific document.
 *
 * Wraps the harness provider rather than replacing it, so every other document
 * in the same backfill run embeds normally — which is the whole point: one bad
 * document must be counted and skipped, never abort the run.
 */
class FailForMarkerProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly marker: string,
  ) {
    this.info = inner.info;
  }

  async embedDocumentChunks(
    documents: readonly (readonly string[])[],
    options: EmbedOptions = {},
  ): Promise<DocumentEmbeddingResult> {
    for (const chunks of documents) {
      if (chunks.some((chunk) => chunk.includes(this.marker))) {
        throw new EmbeddingError('simulated upstream embedding outage', {
          details: { marker: this.marker },
        });
      }
    }
    return this.inner.embedDocumentChunks(documents, options);
  }

  async embedQueries(
    queries: readonly string[],
    options: EmbedOptions = {},
  ): Promise<QueryEmbeddingResult> {
    return this.inner.embedQueries(queries, options);
  }

  /** The wrapped provider belongs to the harness, so this closes nothing. */
  async close(): Promise<void> {
    return;
  }
}

const reembed = (input: Record<string, unknown> = {}) =>
  h.service.reembed(parseInput(reembedSchema, input, 'reembed'), h.context());

/** Rewrite provenance on one source's chunks to look like an older model. */
async function makeStale(
  sourceId: string,
  patch: { embeddingModel?: string; embeddingDimensions?: number },
): Promise<void> {
  const result = await h.chunks.updateMany({ sourceId }, { $set: patch });
  expect(result.modifiedCount).toBe(stored.get(sourceId)?.chunkCount);
}

/** Chunks anywhere in the corpus that are not on the configured model/width. */
function staleFilter(): Record<string, unknown> {
  return {
    $or: [
      { embeddingModel: { $ne: h.config.embedding.model } },
      { embeddingDimensions: { $ne: h.config.embedding.dimensions } },
    ],
  };
}

const staleCount = () => h.chunks.countDocuments(staleFilter());

const chunkCountOf = (sourceId: string): number => stored.get(sourceId)?.chunkCount ?? -1;

beforeAll(async () => {
  h = await createHarness();

  for (const fixture of [ATLAS_GUIDE, INCIDENT_RUNBOOK, PIPELINE_SNIPPET]) {
    const result = await h.service.storeContent(storeInput(fixture), h.context());
    stored.set(fixture.sourceId, result);
  }

  for (const [sourceId, result] of stored) {
    await h.waitForIndexedChunks(sourceId, result.chunkCount);
  }
});

afterAll(async () => {
  await h?.teardown();
});

describe('reembed', () => {
  it('has the provenance index the stale scan is designed around', async () => {
    const listed = await h.chunks.listIndexes().toArray();
    const provenance = listed.find((entry) => entry.name === 'chunks_embeddingModel_dimensions');

    expect(provenance).toBeDefined();
    expect(provenance?.key).toEqual({ embeddingModel: 1, embeddingDimensions: 1 });
    // Whether the planner picks it for a `$ne` scan is the planner's business;
    // what this suite owns is that the index the design depends on is really there.
  });

  it('dry run reports the stale set and writes nothing', async () => {
    await makeStale(ATLAS_GUIDE.sourceId, { embeddingModel: OLD_MODEL });
    await makeStale(INCIDENT_RUNBOOK.sourceId, { embeddingDimensions: OLD_DIMENSIONS });

    const expectedStale =
      chunkCountOf(ATLAS_GUIDE.sourceId) + chunkCountOf(INCIDENT_RUNBOOK.sourceId);
    expect(await staleCount()).toBe(expectedStale);

    const before = await chunksOf(h, ATLAS_GUIDE.sourceId);
    const result = await reembed({ dryRun: true });

    expect(result).toMatchObject({
      staleChunks: expectedStale,
      documentsProcessed: 2,
      chunksReembedded: 0,
      chunksFailed: 0,
      dryRun: true,
      totalTokensEmbedded: 0,
      targetModel: h.config.embedding.model,
      targetDimensions: h.config.embedding.dimensions,
    });

    const after = await chunksOf(h, ATLAS_GUIDE.sourceId);
    expect(after.map((row) => row.embeddingModel)).toEqual(before.map(() => OLD_MODEL));
    expect(after.map((row) => row.embeddedAt.getTime())).toEqual(
      before.map((row) => row.embeddedAt.getTime()),
    );
    expect(await staleCount()).toBe(expectedStale);
  });

  it('re-embeds and re-stamps every chunk of each stale document', async () => {
    const before = await chunksOf(h, ATLAS_GUIDE.sourceId);
    const expectedStale =
      chunkCountOf(ATLAS_GUIDE.sourceId) + chunkCountOf(INCIDENT_RUNBOOK.sourceId);

    const result = await reembed();

    expect(result).toMatchObject({
      staleChunks: expectedStale,
      documentsProcessed: 2,
      // Every chunk of a touched document, not just the stale ones: the
      // contextual model needs the whole document in order.
      chunksReembedded: expectedStale,
      chunksFailed: 0,
      dryRun: false,
    });
    expect(result.totalTokensEmbedded).toBeGreaterThan(0);

    const after = await chunksOf(h, ATLAS_GUIDE.sourceId);
    // Re-embedding updates in place; it must not recreate the chunk documents.
    expect(after.map((row) => row._id.toHexString())).toEqual(
      before.map((row) => row._id.toHexString()),
    );

    after.forEach((row, index) => {
      expect(row.embeddingModel).toBe(h.config.embedding.model);
      expect(row.embeddingDimensions).toBe(h.config.embedding.dimensions);
      expect(row.embeddingProvider).toBe('fake');
      expect(row.embedding).toHaveLength(h.config.embedding.dimensions);
      const previous = before[index];
      expect(row.embeddedAt.getTime()).toBeGreaterThanOrEqual(previous?.embeddedAt.getTime() ?? 0);
    });

    // The parent's stamp is what management views read, so it has to follow.
    const document = await h.documents.findOne({ sourceId: ATLAS_GUIDE.sourceId });
    expect(document?.embedding).toEqual({
      provider: 'fake',
      model: h.config.embedding.model,
      dimensions: h.config.embedding.dimensions,
      contextual: h.config.embedding.contextual,
    });

    expect(await staleCount()).toBe(0);

    const coverage = await h.service.embeddingCoverage(h.context());
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({
      model: h.config.embedding.model,
      dimensions: h.config.embedding.dimensions,
      provider: 'fake',
      documentCount: 3,
    });
  });

  it('honours sourceIds, leaving other stale documents untouched', async () => {
    await makeStale(ATLAS_GUIDE.sourceId, { embeddingModel: OLD_MODEL });
    await makeStale(PIPELINE_SNIPPET.sourceId, { embeddingModel: OLD_MODEL });

    const result = await reembed({ sourceIds: [ATLAS_GUIDE.sourceId] });

    expect(result.documentsProcessed).toBe(1);
    expect(result.chunksReembedded).toBe(chunkCountOf(ATLAS_GUIDE.sourceId));
    // The stale total is scoped by the same filter, so it counts only that source.
    expect(result.staleChunks).toBe(chunkCountOf(ATLAS_GUIDE.sourceId));
    expect(result.chunksFailed).toBe(0);

    expect(
      await h.chunks.countDocuments({ sourceId: ATLAS_GUIDE.sourceId, ...staleFilter() }),
    ).toBe(0);
    expect(await staleCount()).toBe(chunkCountOf(PIPELINE_SNIPPET.sourceId));

    await reembed();
    expect(await staleCount()).toBe(0);
  });

  it('honours maxDocuments while still reporting the full stale count', async () => {
    for (const fixture of [ATLAS_GUIDE, INCIDENT_RUNBOOK, PIPELINE_SNIPPET]) {
      await makeStale(fixture.sourceId, { embeddingModel: OLD_MODEL });
    }
    const totalStale = await staleCount();

    const first = await reembed({ maxDocuments: 1 });

    expect(first.documentsProcessed).toBe(1);
    // Capped work, uncapped reporting: an operator running incremental batches
    // needs to see how much is left.
    expect(first.staleChunks).toBe(totalStale);
    expect(first.chunksReembedded).toBeGreaterThan(0);
    expect(first.chunksReembedded).toBeLessThan(totalStale);

    const remaining = await staleCount();
    expect(remaining).toBe(totalStale - first.chunksReembedded);

    const rest = await reembed();
    expect(rest.documentsProcessed).toBe(2);
    expect(await staleCount()).toBe(0);
  });

  it('counts a document that fails to embed and keeps going', async () => {
    await makeStale(ATLAS_GUIDE.sourceId, { embeddingModel: OLD_MODEL });
    await makeStale(INCIDENT_RUNBOOK.sourceId, { embeddingModel: OLD_MODEL });

    const brittle = h.serviceWith(new FailForMarkerProvider(h.embeddings, GUIDE_ONLY_MARKER));
    const result = await brittle.reembed(parseInput(reembedSchema, {}, 'reembed'), h.context());

    expect(result.chunksFailed).toBe(chunkCountOf(ATLAS_GUIDE.sourceId));
    // The healthy document still got done — the run did not abort.
    expect(result.documentsProcessed).toBe(1);
    expect(result.chunksReembedded).toBe(chunkCountOf(INCIDENT_RUNBOOK.sourceId));

    expect(
      await h.chunks.countDocuments({ sourceId: INCIDENT_RUNBOOK.sourceId, ...staleFilter() }),
    ).toBe(0);
    expect(
      await h.chunks.countDocuments({ sourceId: ATLAS_GUIDE.sourceId, ...staleFilter() }),
    ).toBe(chunkCountOf(ATLAS_GUIDE.sourceId));

    await reembed();
    expect(await staleCount()).toBe(0);
  });

  it('stale vectors leave the search space and come back after the backfill', async () => {
    const guideChunks = chunkCountOf(ATLAS_GUIDE.sourceId);
    const currentModel = { embeddingModel: { $eq: h.config.embedding.model } };
    const guideOnCurrentModel = {
      $and: [{ sourceId: { $eq: ATLAS_GUIDE.sourceId } }, currentModel],
    };

    await makeStale(ATLAS_GUIDE.sourceId, { embeddingModel: OLD_MODEL });
    await h.waitFor(
      'the stale guide chunks to disappear from the current-model vector space',
      async () => (await h.countVectorIndexed(guideOnCurrentModel)) === 0,
    );

    const whileStale = await h.service.searchKnowledge(
      searchInput(QUERIES.oplog, { mode: 'vector', limit: 10 }),
      h.context(),
    );
    // A mixed vector space would produce confidently wrong answers, so the
    // service returns fewer results instead of mixing two models.
    expect(whileStale.hits.every((hit) => hit.sourceId !== ATLAS_GUIDE.sourceId)).toBe(true);

    await reembed();
    await h.waitFor(
      'the re-embedded guide chunks to return to the vector index',
      async () => (await h.countVectorIndexed(guideOnCurrentModel)) === guideChunks,
    );

    const afterwards = await h.service.searchKnowledge(
      searchInput(QUERIES.oplog, { mode: 'hybrid', limit: 10 }),
      h.context(),
    );

    expect(afterwards.effectiveMode).toBe('hybrid');
    const oplogRank = afterwards.hits.findIndex((hit) =>
      hit.headingPath.includes('Replica sets and the oplog'),
    );
    expect(oplogRank).toBeGreaterThanOrEqual(0);
    expect(oplogRank).toBeLessThan(3);
  });
});
