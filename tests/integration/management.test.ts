/**
 * Knowledge-base management against a real database: listing, browsing, fetching
 * and deleting.
 *
 * The assertion that earns this file its place in the suite is the delete one.
 * Chunks live in their own collection, so "delete the document" is really two
 * writes, and a bug that drops the document but keeps its chunks leaves rows
 * that are invisible in every management view yet still returned by search. Each
 * delete case therefore checks the chunk count is zero, and the file ends with a
 * whole-database orphan sweep.
 *
 * Search indexes are created but not waited on up front: most paths here ride
 * the standard b-tree indexes — in particular the unique `sourceId` index that
 * makes re-ingest version rather than duplicate. The one exception is browse
 * substring search, which runs through the documents MongoDB Search index; those
 * assertions poll for their own visibility instead of stalling every test
 * behind an index build.
 */
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTIONS } from '../../src/db/collections.js';
import {
  deleteContentSchema,
  listDocumentsSchema,
  listSourcesSchema,
  parseInput,
} from '../../src/domain/schemas.js';
import type { StoreContentResult } from '../../src/domain/types.js';
import {
  ATLAS_GUIDE,
  INCIDENT_RUNBOOK,
  PIPELINE_SNIPPET,
  storeInput,
  type Fixture,
} from './helpers/fixtures.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
const stored = new Map<string, StoreContentResult>();

/** A second runbook and a second snippet, so paging and sorting have real work. */
const DEPLOYMENT_RUNBOOK = {
  sourceId: 'runbooks/deployment-rollback',
  title: 'Deployment Runbook',
  tags: ['runbook', 'deploy'],
  content: `# Deployment Runbook

## Rolling back a release

Roll the previous artefact forward rather than reverting the tag: a rollback that
rewrites history leaves the registry and the cluster disagreeing about which
build is live. Drain the old replicas before the new ones accept traffic.
`,
};

const ARCHIVE_SNIPPET = {
  sourceId: 'snippets/archive-job',
  title: 'Archive job helper',
  tags: ['code', 'archive'],
  content: `// Moves cold records into the archive bucket once a night.
export function selectExpired(rows, cutoff) {
  return rows.filter((row) => row.lastTouchedAt < cutoff && !row.legalHold);
}
`,
};

const BASELINE_SOURCE_IDS = [
  ATLAS_GUIDE.sourceId,
  INCIDENT_RUNBOOK.sourceId,
  PIPELINE_SNIPPET.sourceId,
  DEPLOYMENT_RUNBOOK.sourceId,
  ARCHIVE_SNIPPET.sourceId,
];

async function store(fixture: Fixture, overrides = {}): Promise<StoreContentResult> {
  const result = await h.service.storeContent(storeInput(fixture, overrides), h.context());
  stored.set(result.sourceId, result);
  return result;
}

beforeAll(async () => {
  h = await createHarness({ waitForQueryable: false });

  await store(ATLAS_GUIDE);
  await store(INCIDENT_RUNBOOK);
  await store(PIPELINE_SNIPPET);
  await store(INCIDENT_RUNBOOK, DEPLOYMENT_RUNBOOK);
  await store(PIPELINE_SNIPPET, ARCHIVE_SNIPPET);
});

afterAll(async () => {
  await h?.teardown();
});

const sources = (input: Record<string, unknown> = {}) =>
  h.service.listSources(parseInput(listSourcesSchema, input, 'list_sources'), h.context());

const browse = (input: Record<string, unknown> = {}) =>
  h.service.listDocuments(parseInput(listDocumentsSchema, input, 'list_documents'), h.context());

const remove = (input: Record<string, unknown>) =>
  h.service.deleteContent(parseInput(deleteContentSchema, input, 'delete_content'), h.context());

describe('listSources', () => {
  it('reports every source with an accurate total and real chunk counts', async () => {
    const result = await sources({ limit: 50 });

    expect(result.total).toBe(BASELINE_SOURCE_IDS.length);
    expect(result.sources).toHaveLength(BASELINE_SOURCE_IDS.length);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.sources.map((entry) => entry.sourceId).sort()).toEqual(
      [...BASELINE_SOURCE_IDS].sort(),
    );

    for (const summary of result.sources) {
      const actual = await h.chunks.countDocuments({ sourceId: summary.sourceId });
      expect(summary.chunkCount).toBe(actual);
      expect(summary.chunkCount).toBe(stored.get(summary.sourceId)?.chunkCount);
      expect(summary.version).toBe(1);
      expect(summary.contentLength).toBeGreaterThan(0);
      // One model across the corpus means no backfill is half-finished.
      expect(summary.embeddingModels).toEqual([h.config.embedding.model]);
      expect(summary.createdAt).toBeInstanceOf(Date);
      expect(summary.updatedAt).toBeInstanceOf(Date);
    }
  });

  it('pages without repeating or skipping a source', async () => {
    const first = await sources({ limit: 2, offset: 0, sort: 'title', order: 'asc' });
    const second = await sources({ limit: 2, offset: 2, sort: 'title', order: 'asc' });
    const third = await sources({ limit: 2, offset: 4, sort: 'title', order: 'asc' });

    expect(first.total).toBe(BASELINE_SOURCE_IDS.length);
    expect(second.total).toBe(BASELINE_SOURCE_IDS.length);
    expect(first.sources).toHaveLength(2);
    expect(second.sources).toHaveLength(2);
    expect(third.sources).toHaveLength(1);
    expect(third.offset).toBe(4);

    const paged = [...first.sources, ...second.sources, ...third.sources].map(
      (entry) => entry.sourceId,
    );
    expect(new Set(paged).size).toBe(BASELINE_SOURCE_IDS.length);
    expect(paged.sort()).toEqual([...BASELINE_SOURCE_IDS].sort());
  });

  it('filters by tag and by substring, with the total following the filter', async () => {
    const byTag = await sources({ tag: 'runbook' });
    expect(byTag.total).toBe(2);
    expect(byTag.sources.map((entry) => entry.sourceId).sort()).toEqual(
      [DEPLOYMENT_RUNBOOK.sourceId, INCIDENT_RUNBOOK.sourceId].sort(),
    );

    // Tags are stored lowercased, so a differently cased filter must still match.
    const byUpperTag = await sources({ tag: 'RUNBOOK' });
    expect(byUpperTag.total).toBe(2);

    // Substring search runs through the documents MongoDB Search index, which
    // builds asynchronously and indexes writes eventually — so poll until every
    // seeded document is visible before asserting. The helper swallows the
    // IndexError the service raises while the index is still building.
    const searchTotal = async (search: string): Promise<number> => {
      try {
        return (await sources({ search })).total;
      } catch {
        return -1;
      }
    };
    await h.waitFor(
      'substring search served by the documents text index',
      async () =>
        (await searchTotal('runbook')) === 2 &&
        (await searchTotal('Atlas Operations')) === 1 &&
        (await searchTotal('archive')) === 1,
    );

    const bySubstring = await sources({ search: 'runbook' });
    expect(bySubstring.total).toBe(2);
    expect(bySubstring.sources.map((entry) => entry.sourceId).sort()).toEqual(
      [DEPLOYMENT_RUNBOOK.sourceId, INCIDENT_RUNBOOK.sourceId].sort(),
    );

    const byTitleFragment = await sources({ search: 'Atlas Operations' });
    expect(byTitleFragment.total).toBe(1);
    expect(byTitleFragment.sources[0]?.sourceId).toBe(ATLAS_GUIDE.sourceId);

    // Search and tag together exercise the compound-with-filter query shape.
    const searchAndTag = await sources({ search: 'runbook', tag: 'deploy' });
    expect(searchAndTag.total).toBe(1);
    expect(searchAndTag.sources[0]?.sourceId).toBe(DEPLOYMENT_RUNBOOK.sourceId);

    const noMatch = await sources({ search: 'quantum tunnelling' });
    expect(noMatch.total).toBe(0);
    expect(noMatch.sources).toEqual([]);
  });

  it('sorts by the requested field in both directions', async () => {
    const ascending = await sources({ sort: 'title', order: 'asc', limit: 50 });
    const descending = await sources({ sort: 'title', order: 'desc', limit: 50 });

    const titles = ascending.sources.map((entry) => entry.title);
    expect(titles).toEqual([...titles].sort());
    expect(descending.sources.map((entry) => entry.title)).toEqual([...titles].reverse());

    const byChunks = await sources({ sort: 'chunkCount', order: 'desc', limit: 50 });
    const counts = byChunks.sources.map((entry) => entry.chunkCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe('getDocument and listDocuments', () => {
  it('resolves a document by ObjectId and by sourceId to the same detail', async () => {
    const documentId = stored.get(ATLAS_GUIDE.sourceId)?.documentId ?? '';
    expect(documentId).toMatch(/^[0-9a-f]{24}$/u);

    const byId = await h.service.getDocument(documentId, h.context());
    const bySourceId = await h.service.getDocument(ATLAS_GUIDE.sourceId, h.context());

    expect(byId).not.toBeNull();
    expect(byId).toEqual(bySourceId);
    expect(byId?.document.id).toBe(documentId);
    expect(byId?.document.sourceId).toBe(ATLAS_GUIDE.sourceId);
    expect(byId?.document.content).toBe(ATLAS_GUIDE.content);
    expect(byId?.chunks).toHaveLength(stored.get(ATLAS_GUIDE.sourceId)?.chunkCount ?? -1);

    for (const chunk of byId?.chunks ?? []) {
      expect(chunk.documentId).toBe(documentId);
      // The 1024-float vector is projected away; nothing here needs it.
      expect(chunk).not.toHaveProperty('embedding');
      expect(chunk.embeddingModel).toBe(h.config.embedding.model);
    }
  });

  it('returns null for an unknown id or sourceId', async () => {
    expect(await h.service.getDocument(new ObjectId().toHexString(), h.context())).toBeNull();
    expect(await h.service.getDocument('nothing/here', h.context())).toBeNull();
  });

  it('listDocuments returns an excerpt and never the full content', async () => {
    const result = await browse({ limit: 50 });

    expect(result.total).toBe(BASELINE_SOURCE_IDS.length);
    expect(result.documents).toHaveLength(BASELINE_SOURCE_IDS.length);

    for (const row of result.documents) {
      expect(row).not.toHaveProperty('content');
      expect(row.excerpt.length).toBeGreaterThan(0);
      expect(row.excerpt.length).toBeLessThanOrEqual(240);
      // Condensed to a single line so a browse card cannot be blown apart by
      // whatever whitespace the ingested document happened to contain.
      expect(row.excerpt).not.toMatch(/\s{2,}/u);
      expect(row.id).toMatch(/^[0-9a-f]{24}$/u);
      expect(row.chunking.chunkCount).toBeGreaterThan(0);
    }

    const paged = await browse({ limit: 2, offset: 0 });
    expect(paged.documents).toHaveLength(2);
    expect(paged.total).toBe(BASELINE_SOURCE_IDS.length);

    const filtered = await browse({ tag: 'code' });
    expect(filtered.total).toBe(2);

    // Already indexed: the listSources test above polled this document into
    // visibility, and both listings share the documents text index.
    const searched = await browse({ search: 'archive' });
    expect(searched.total).toBe(1);
    expect(searched.documents[0]?.sourceId).toBe(ARCHIVE_SNIPPET.sourceId);
  });
});

describe('deleteContent', () => {
  /** Documents created inside this block only, so the listing tests stay stable. */
  const EPHEMERAL_TAGS = ['ephemeral', 'sweep'];

  async function seed(sourceId: string, tags: string[]): Promise<StoreContentResult> {
    return h.service.storeContent(
      storeInput(INCIDENT_RUNBOOK, {
        sourceId,
        title: `Temporary ${sourceId}`,
        tags,
        content: `# Temporary ${sourceId}\n\nDisposable content for the delete test of ${sourceId}.\nIt exists only so that removing it can be observed end to end.\n`,
      }),
      h.context(),
    );
  }

  it('deletes by sourceId, taking every chunk with it', async () => {
    const seeded = await seed('ephemeral/by-source-id', ['ephemeral']);
    expect(await h.chunks.countDocuments({ sourceId: seeded.sourceId })).toBe(seeded.chunkCount);

    const result = await remove({ sourceId: seeded.sourceId });

    expect(result).toEqual({
      deletedDocuments: 1,
      deletedChunks: seeded.chunkCount,
      sourceIds: [seeded.sourceId],
    });
    expect(await h.documents.countDocuments({ sourceId: seeded.sourceId })).toBe(0);
    expect(await h.chunks.countDocuments({ sourceId: seeded.sourceId })).toBe(0);
    expect(await h.chunks.countDocuments({ documentId: new ObjectId(seeded.documentId) })).toBe(0);
  });

  it('deletes by documentId, taking every chunk with it', async () => {
    const seeded = await seed('ephemeral/by-document-id', ['ephemeral']);

    const result = await remove({ documentId: seeded.documentId });

    expect(result.deletedDocuments).toBe(1);
    expect(result.deletedChunks).toBe(seeded.chunkCount);
    expect(result.sourceIds).toEqual([seeded.sourceId]);
    expect(await h.chunks.countDocuments({ documentId: new ObjectId(seeded.documentId) })).toBe(0);
  });

  it('deletes every document carrying ALL of the given tags', async () => {
    const first = await seed('ephemeral/tagged-one', EPHEMERAL_TAGS);
    const second = await seed('ephemeral/tagged-two', EPHEMERAL_TAGS);
    // Carries only one of the two tags, so an ANY-match bug would take it too.
    const spared = await seed('ephemeral/tagged-partial', ['ephemeral']);

    const result = await remove({ tags: EPHEMERAL_TAGS });

    expect(result.deletedDocuments).toBe(2);
    expect(result.deletedChunks).toBe(first.chunkCount + second.chunkCount);
    expect(result.sourceIds.sort()).toEqual([first.sourceId, second.sourceId].sort());

    expect(await h.chunks.countDocuments({ sourceId: first.sourceId })).toBe(0);
    expect(await h.chunks.countDocuments({ sourceId: second.sourceId })).toBe(0);
    expect(await h.documents.countDocuments({ sourceId: spared.sourceId })).toBe(1);
    expect(await h.chunks.countDocuments({ sourceId: spared.sourceId })).toBe(spared.chunkCount);

    await remove({ sourceId: spared.sourceId });
  });

  it('returns zeros rather than throwing when nothing matches', async () => {
    const zero = { deletedDocuments: 0, deletedChunks: 0, sourceIds: [] };

    expect(await remove({ sourceId: 'does/not/exist' })).toEqual(zero);
    expect(await remove({ documentId: new ObjectId().toHexString() })).toEqual(zero);
    expect(await remove({ tags: ['no-such-tag'] })).toEqual(zero);
  });

  it('leaves no orphan chunks anywhere in the database', async () => {
    const orphans = await h.chunks
      .aggregate<{ _id: unknown }>([
        {
          $lookup: {
            from: COLLECTIONS.documents,
            localField: 'documentId',
            foreignField: '_id',
            as: 'parent',
          },
        },
        { $match: { parent: { $size: 0 } } },
        { $project: { _id: 1 } },
      ])
      .toArray();

    expect(orphans).toEqual([]);

    // And the baseline corpus is exactly what the listing tests expected.
    const remaining = await h.documents.distinct('sourceId');
    expect(remaining.sort()).toEqual([...BASELINE_SOURCE_IDS].sort());
  });
});
