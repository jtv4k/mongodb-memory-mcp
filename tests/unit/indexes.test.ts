/**
 * Index management, without a database.
 *
 * Everything here runs against a small hand-rolled fake that records the driver
 * calls it receives. The point is to pin down the decisions — strip `$comment`,
 * substitute `numDimensions`, created/unchanged/updated, and above all *never
 * drop a vector index by itself* — because those are the parts that are painful
 * to exercise against a real Atlas Search index in CI.
 */
import type { Db, Document, IndexDescription } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import {
  buildVectorIndexDefinition,
  CHECKED_IN_VECTOR_DIMENSIONS,
  CHUNKS_TEXT_DEFINITION,
  CHUNKS_VECTOR_BASE_DEFINITION,
  desiredSearchIndexes,
  DOCUMENTS_TEXT_DEFINITION,
  ensureIndexes,
  planIndexes,
  searchIndexIsQueryable,
  STANDARD_INDEXES,
  waitForSearchIndex,
} from '../../src/db/indexes.js';
import { IndexError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';

import rawChunksVector from '../../src/db/index-definitions/chunks.vector.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    MONGODB_URI: 'mongodb://localhost:27017/?directConnection=true',
    MONGODB_DB_NAME: 'rag_kb_test',
    MCP_AUTH_TOKEN: 'unit-test-token-0123456789',
    EMBEDDING_PROVIDER: 'fake',
    ...overrides,
  });
}

function createRecordingLogger(): {
  logger: Logger;
  records: Array<{ level: string; message: string }>;
} {
  const records: Array<{ level: string; message: string }> = [];
  const at = (level: string) => (_obj: unknown, message?: string) => {
    records.push({ level, message: message ?? '' });
  };
  const logger = {
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    child: () => logger,
  } as unknown as Logger;
  return { logger, records };
}

function mongoError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

interface FakeSearchIndex {
  name: string;
  type: string;
  status: string;
  queryable: boolean;
  latestDefinition: Document;
  message?: string;
}

interface FakeCall {
  op: string;
  collection: string;
  arg?: unknown;
}

interface FakeState {
  collections: Set<string>;
  standard: Map<string, Document[]>;
  search: Map<string, FakeSearchIndex[]>;
  calls: FakeCall[];
  /** Status a search index gets when this fake "builds" it. */
  buildResult: { status: string; queryable: boolean };
  failures: { listSearchIndexes?: unknown; updateSearchIndex?: unknown };
}

function createFakeDb(
  seed: { collections?: string[]; search?: Record<string, FakeSearchIndex[]> } = {},
): { db: Db; state: FakeState } {
  const state: FakeState = {
    collections: new Set(seed.collections ?? []),
    standard: new Map(),
    search: new Map(Object.entries(seed.search ?? {})),
    calls: [],
    buildResult: { status: 'PENDING', queryable: false },
    failures: {},
  };

  const collection = (name: string) => ({
    listIndexes() {
      return {
        toArray: async (): Promise<Document[]> => {
          state.calls.push({ op: 'listIndexes', collection: name });
          if (!state.collections.has(name)) throw mongoError(`ns not found: ${name}`, 26);
          return [{ name: '_id_', key: { _id: 1 } }, ...(state.standard.get(name) ?? [])];
        },
      };
    },
    async createIndexes(descriptions: IndexDescription[]): Promise<string[]> {
      state.calls.push({ op: 'createIndexes', collection: name, arg: descriptions });
      const existing = state.standard.get(name) ?? [];
      for (const description of descriptions) {
        if (existing.some((entry) => entry.name === description.name)) continue;
        existing.push({
          name: description.name,
          key: description.key,
          unique: description.unique === true,
        });
      }
      state.standard.set(name, existing);
      return descriptions.map((description) => String(description.name));
    },
    listSearchIndexes(indexName?: string) {
      return {
        toArray: async (): Promise<Document[]> => {
          state.calls.push({ op: 'listSearchIndexes', collection: name, arg: indexName });
          if (state.failures.listSearchIndexes) throw state.failures.listSearchIndexes;
          if (!state.collections.has(name)) throw mongoError(`ns not found: ${name}`, 26);
          const all = state.search.get(name) ?? [];
          return indexName === undefined ? all : all.filter((entry) => entry.name === indexName);
        },
      };
    },
    async createSearchIndex(description: {
      name?: string;
      type?: string;
      definition: Document;
    }): Promise<string> {
      state.calls.push({ op: 'createSearchIndex', collection: name, arg: description });
      const all = state.search.get(name) ?? [];
      all.push({
        name: String(description.name),
        type: String(description.type),
        status: state.buildResult.status,
        queryable: state.buildResult.queryable,
        latestDefinition: structuredClone(description.definition),
      });
      state.search.set(name, all);
      return String(description.name);
    },
    async updateSearchIndex(indexName: string, definition: Document): Promise<void> {
      state.calls.push({
        op: 'updateSearchIndex',
        collection: name,
        arg: { indexName, definition },
      });
      if (state.failures.updateSearchIndex) throw state.failures.updateSearchIndex;
      const found = (state.search.get(name) ?? []).find((entry) => entry.name === indexName);
      if (found) found.latestDefinition = structuredClone(definition);
    },
    async dropSearchIndex(indexName: string): Promise<void> {
      state.calls.push({ op: 'dropSearchIndex', collection: name, arg: indexName });
      state.search.set(
        name,
        (state.search.get(name) ?? []).filter((entry) => entry.name !== indexName),
      );
    },
  });

  const db = {
    async createCollection(name: string): Promise<unknown> {
      state.calls.push({ op: 'createCollection', collection: name });
      if (state.collections.has(name)) throw mongoError(`collection ${name} already exists`, 48);
      state.collections.add(name);
      return collection(name);
    },
    collection,
  };

  return { db: db as unknown as Db, state };
}

function ready(name: string, type: string, definition: Document): FakeSearchIndex {
  return {
    name,
    type,
    status: 'READY',
    queryable: true,
    latestDefinition: structuredClone(definition),
  };
}

function opsOf(state: FakeState, op: string): FakeCall[] {
  return state.calls.filter((call) => call.op === op);
}

// ---------------------------------------------------------------------------

describe('index definitions', () => {
  it('strips $comment from every definition it sends to the server', () => {
    expect(CHUNKS_VECTOR_BASE_DEFINITION).not.toHaveProperty('$comment');
    expect(CHUNKS_TEXT_DEFINITION).not.toHaveProperty('$comment');
    expect(DOCUMENTS_TEXT_DEFINITION).not.toHaveProperty('$comment');

    for (const desired of desiredSearchIndexes(testConfig())) {
      expect(JSON.stringify(desired.definition)).not.toContain('$comment');
    }
  });

  it('keeps the checked-in definition intact apart from numDimensions', () => {
    const definition = buildVectorIndexDefinition(testConfig({ EMBEDDING_DIMENSIONS: '512' }));

    const expected = structuredClone(rawChunksVector) as Record<string, unknown>;
    delete expected['$comment'];
    const expectedFields = (expected['fields'] as Array<Record<string, unknown>>).map((field) =>
      field['type'] === 'vector' ? { ...field, numDimensions: 512 } : field,
    );

    expect(definition).toEqual({ ...expected, fields: expectedFields });
    expect(definition.fields[0]).toEqual({
      type: 'vector',
      path: 'embedding',
      numDimensions: 512,
      similarity: 'cosine',
    });
  });

  it('substitutes numDimensions per call without mutating the shared base', () => {
    expect(
      buildVectorIndexDefinition(testConfig({ EMBEDDING_DIMENSIONS: '256' })).fields[0],
    ).toMatchObject({ numDimensions: 256 });
    expect(
      buildVectorIndexDefinition(testConfig({ EMBEDDING_DIMENSIONS: '2048' })).fields[0],
    ).toMatchObject({ numDimensions: 2048 });
    expect(CHUNKS_VECTOR_BASE_DEFINITION.fields[0]).toMatchObject({
      numDimensions: CHECKED_IN_VECTOR_DIMENSIONS,
    });
  });

  it('warns when the configured dimension differs from the checked-in one', async () => {
    const { logger, records } = createRecordingLogger();
    const { db } = createFakeDb();

    await ensureIndexes(db, testConfig({ EMBEDDING_DIMENSIONS: '512' }), logger);

    const warning = records.find((record) => record.level === 'warn');
    expect(warning?.message).toContain(`from ${CHECKED_IN_VECTOR_DIMENSIONS}`);
    expect(warning?.message).toContain('to 512');
  });

  it('names the index from config, never a hardcoded string', () => {
    const desired = desiredSearchIndexes(
      testConfig({
        MONGODB_VECTOR_INDEX_NAME: 'custom_vector',
        MONGODB_TEXT_INDEX_NAME: 'custom_chunk_text',
        MONGODB_DOCUMENTS_TEXT_INDEX_NAME: 'custom_doc_text',
      }),
    );

    expect(desired.map((entry) => [entry.collection, entry.name, entry.type])).toEqual([
      ['chunks', 'custom_vector', 'vectorSearch'],
      ['chunks', 'custom_chunk_text', 'search'],
      ['documents', 'custom_doc_text', 'search'],
    ]);
  });
});

describe('ensureIndexes', () => {
  it('creates both collections, every standard index and every search index', async () => {
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb();
    const config = testConfig();

    const result = await ensureIndexes(db, config, logger);

    expect([...state.collections].sort()).toEqual(['chunks', 'documents']);
    expect(result.standard).toEqual(STANDARD_INDEXES.map((spec) => spec.name));
    expect(result.search).toEqual([
      {
        name: config.mongo.vectorIndexName,
        collection: 'chunks',
        type: 'vectorSearch',
        action: 'created',
        queryable: false,
      },
      {
        name: config.mongo.textIndexName,
        collection: 'chunks',
        type: 'search',
        action: 'created',
        queryable: false,
      },
      {
        name: config.mongo.documentsTextIndexName,
        collection: 'documents',
        type: 'search',
        action: 'created',
        queryable: false,
      },
    ]);
  });

  it('declares the unique constraints the data model depends on', async () => {
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb();

    await ensureIndexes(db, testConfig(), logger);

    const submitted = opsOf(state, 'createIndexes').flatMap(
      (call) => call.arg as IndexDescription[],
    );
    const unique = submitted.filter((description) => description.unique === true);
    expect(unique.map((description) => description.name)).toEqual([
      'documents_sourceId_unique',
      'chunks_documentId_chunkIndex_unique',
    ]);
    expect(submitted.find((d) => d.name === 'chunks_embeddingModel_dimensions')?.key).toEqual({
      embeddingModel: 1,
      embeddingDimensions: 1,
    });
    // Every index we declare must be named explicitly, never left to MongoDB.
    expect(submitted.every((description) => typeof description.name === 'string')).toBe(true);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb();
    const config = testConfig();

    await ensureIndexes(db, config, logger);
    const createdFirstRun = opsOf(state, 'createSearchIndex').length;
    const second = await ensureIndexes(db, config, logger);

    expect(createdFirstRun).toBe(3);
    expect(second.search.map((outcome) => outcome.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
    expect(opsOf(state, 'createSearchIndex')).toHaveLength(3);
    expect(opsOf(state, 'updateSearchIndex')).toHaveLength(0);
    expect(second.standard).toEqual(STANDARD_INDEXES.map((spec) => spec.name));
  });

  it('tolerates the defaults the server adds back to a definition', async () => {
    const config = testConfig();
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb({ collections: ['documents', 'chunks'] });

    // Exactly what we asked for, plus the extras Atlas fills in: top-level
    // analyzer/storedSource, per-field options, quantization on the vector field,
    // and a single-element field mapping collapsed to a bare object.
    state.search.set('chunks', [
      ready(config.mongo.vectorIndexName, 'vectorSearch', {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions: 1024,
            similarity: 'cosine',
            quantization: 'none',
          },
          { type: 'filter', path: 'sourceId' },
          { type: 'filter', path: 'documentId' },
          { type: 'filter', path: 'tags' },
          { type: 'filter', path: 'contentType' },
          { type: 'filter', path: 'embeddingModel' },
          { type: 'filter', path: 'embeddingDimensions' },
        ],
      }),
      ready(config.mongo.textIndexName, 'search', {
        analyzer: 'lucene.standard',
        searchAnalyzer: 'lucene.standard',
        storedSource: false,
        mappings: {
          dynamic: false,
          fields: {
            text: { type: 'string', analyzer: 'lucene.standard', norms: 'include', store: true },
            title: [{ type: 'string', analyzer: 'lucene.standard', indexOptions: 'offsets' }],
            headingPath: [{ type: 'string', analyzer: 'lucene.standard' }],
            tags: [{ type: 'token', normalizer: 'lowercase' }],
            sourceId: [{ type: 'token', normalizer: 'lowercase' }],
            contentType: [{ type: 'token', normalizer: 'lowercase' }],
            embeddingModel: [{ type: 'token', normalizer: 'lowercase' }],
            documentId: [{ type: 'objectId' }],
          },
        },
      }),
    ]);

    const result = await ensureIndexes(db, config, logger);
    const chunkOutcomes = result.search.filter((outcome) => outcome.collection === 'chunks');

    expect(chunkOutcomes.map((outcome) => outcome.action)).toEqual(['unchanged', 'unchanged']);
    expect(chunkOutcomes.every((outcome) => outcome.queryable)).toBe(true);
    expect(opsOf(state, 'updateSearchIndex')).toHaveLength(0);
  });

  it('updates an index whose definition drifted', async () => {
    const config = testConfig();
    const drifted = structuredClone(buildVectorIndexDefinition(config));
    drifted.fields = drifted.fields.filter((field) => field.path !== 'embeddingModel');

    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb({
      collections: ['documents', 'chunks'],
      search: { chunks: [ready(config.mongo.vectorIndexName, 'vectorSearch', drifted)] },
    });

    const result = await ensureIndexes(db, config, logger);

    expect(result.search[0]?.action).toBe('updated');
    const update = opsOf(state, 'updateSearchIndex')[0];
    expect(update?.arg).toEqual({
      indexName: config.mongo.vectorIndexName,
      definition: buildVectorIndexDefinition(config),
    });
    expect(opsOf(state, 'dropSearchIndex')).toHaveLength(0);
  });

  it('refuses to change numDimensions in place and explains the remediation', async () => {
    const config = testConfig({ EMBEDDING_DIMENSIONS: '1024' });
    const existing = structuredClone(buildVectorIndexDefinition(config));
    existing.fields[0] = {
      type: 'vector',
      path: 'embedding',
      numDimensions: 512,
      similarity: 'cosine',
    };

    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb({
      collections: ['documents', 'chunks'],
      search: { chunks: [ready(config.mongo.vectorIndexName, 'vectorSearch', existing)] },
    });

    const error = await ensureIndexes(db, config, logger).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(IndexError);
    const message = (error as IndexError).message;
    expect(message).toContain('numDimensions=512');
    expect(message).toContain('numDimensions=1024');
    expect(message).toContain('dropSearchIndex');
    expect(message).toContain('re-embedded');
    expect((error as IndexError).details).toMatchObject({
      existingDimensions: 512,
      desiredDimensions: 1024,
    });
    // Nothing destructive happened on the way out.
    expect(opsOf(state, 'dropSearchIndex')).toHaveLength(0);
    expect(opsOf(state, 'updateSearchIndex')).toHaveLength(0);
  });

  it('explains the recovery when the server refuses to update a vector index in place', async () => {
    const config = testConfig();
    // Same dimensions, so the proactive guard passes and the update is attempted.
    const drifted = structuredClone(buildVectorIndexDefinition(config));
    drifted.fields = drifted.fields.filter((field) => field.path !== 'tags');

    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb({
      collections: ['documents', 'chunks'],
      search: { chunks: [ready(config.mongo.vectorIndexName, 'vectorSearch', drifted)] },
    });
    // The literal error Atlas Local 8.0 answers with for ANY vector index update.
    state.failures.updateSearchIndex = mongoError('"mappings" is required', 2);

    const error = await ensureIndexes(db, config, logger).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(IndexError);
    expect((error as IndexError).message).toContain('"mappings" is required');
    expect((error as IndexError).message).toContain('dropSearchIndex');
    // numDimensions did not change, so it must not scare anyone into a re-embed.
    expect((error as IndexError).message).toContain('no re-embedding is needed');
    expect((error as IndexError).details).toMatchObject({ dimensionsChanged: false });
  });

  it('reports a failed text index update plainly, with no drop-and-recreate advice', async () => {
    const config = testConfig();
    const drifted = structuredClone(CHUNKS_TEXT_DEFINITION);
    delete (drifted['mappings'] as Record<string, unknown>)['fields'];

    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb({
      collections: ['documents', 'chunks'],
      search: {
        chunks: [
          ready(config.mongo.vectorIndexName, 'vectorSearch', buildVectorIndexDefinition(config)),
          ready(config.mongo.textIndexName, 'search', drifted),
        ],
      },
    });
    state.failures.updateSearchIndex = mongoError('unknown analyzer lucene.standard', 2);

    const error = await ensureIndexes(db, config, logger).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(IndexError);
    expect((error as IndexError).message).toContain('Could not update search index');
    expect((error as IndexError).message).not.toContain('dropSearchIndex');
  });

  it('rejects an index of the same name but the wrong type', async () => {
    const config = testConfig();
    const { logger } = createRecordingLogger();
    const { db } = createFakeDb({
      collections: ['documents', 'chunks'],
      search: {
        chunks: [ready(config.mongo.vectorIndexName, 'search', { mappings: { dynamic: true } })],
      },
    });

    await expect(ensureIndexes(db, config, logger)).rejects.toThrow(
      /already exists as type "search"/,
    );
  });

  it('swallows NamespaceExists when the collections are already there', async () => {
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb({ collections: ['documents', 'chunks'] });

    await expect(ensureIndexes(db, testConfig(), logger)).resolves.toBeTruthy();
    expect(opsOf(state, 'createCollection')).toHaveLength(2);
  });

  it('explains itself on a deployment without Atlas Search', async () => {
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb({ collections: ['documents', 'chunks'] });
    state.failures.listSearchIndexes = mongoError(
      "Unrecognized pipeline stage name: '$listSearchIndexes'",
      40324,
    );

    await expect(ensureIndexes(db, testConfig(), logger)).rejects.toThrow(
      /does not support Atlas Search indexes/,
    );
  });

  it('waits for readiness when asked', async () => {
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb();
    state.buildResult = { status: 'READY', queryable: true };

    const result = await ensureIndexes(db, testConfig(), logger, {
      waitForQueryable: true,
      timeoutMs: 5_000,
    });

    expect(result.search.every((outcome) => outcome.queryable)).toBe(true);
  });
});

describe('planIndexes', () => {
  it('reports what would change without writing anything', async () => {
    const config = testConfig();
    const { logger } = createRecordingLogger();
    const { db, state } = createFakeDb();

    const plan = await planIndexes(db, config, logger);

    expect(opsOf(state, 'createCollection')).toHaveLength(0);
    expect(opsOf(state, 'createIndexes')).toHaveLength(0);
    expect(opsOf(state, 'createSearchIndex')).toHaveLength(0);
    expect(opsOf(state, 'updateSearchIndex')).toHaveLength(0);
    expect(plan).toHaveLength(STANDARD_INDEXES.length + 3);
    expect(plan.every((entry) => entry.action === 'created')).toBe(true);
    expect(
      plan.filter((entry) => entry.kind === 'vectorSearch').map((entry) => entry.name),
    ).toEqual([config.mongo.vectorIndexName]);
  });

  it('reports an already-applied database as entirely unchanged', async () => {
    const config = testConfig();
    const { logger } = createRecordingLogger();
    const { db } = createFakeDb();

    await ensureIndexes(db, config, logger);
    const plan = await planIndexes(db, config, logger);

    expect(plan.every((entry) => entry.action === 'unchanged')).toBe(true);
    expect(
      plan.filter((entry) => entry.kind === 'standard').every((entry) => entry.queryable),
    ).toBe(true);
  });
});

describe('waitForSearchIndex', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true as soon as the index is READY and queryable', async () => {
    const { logger } = createRecordingLogger();
    const { db } = createFakeDb({
      collections: ['chunks'],
      search: { chunks: [ready('chunks_vector_index', 'vectorSearch', { fields: [] })] },
    });

    await expect(
      waitForSearchIndex(db, 'chunks', 'chunks_vector_index', 60_000, logger),
    ).resolves.toBe(true);
  });

  it('returns false when the index is still building at the timeout', async () => {
    const { logger, records } = createRecordingLogger();
    const { db, state } = createFakeDb({
      collections: ['chunks'],
      search: {
        chunks: [
          {
            name: 'chunks_vector_index',
            type: 'vectorSearch',
            status: 'PENDING',
            queryable: false,
            latestDefinition: { fields: [] },
          },
        ],
      },
    });

    const pending = waitForSearchIndex(db, 'chunks', 'chunks_vector_index', 10_000, logger);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe(false);
    // 2s poll interval: t=0,2,4,6,8 then the deadline check at t=10.
    expect(opsOf(state, 'listSearchIndexes')).toHaveLength(6);
    expect(records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('keeps waiting for an index that only becomes queryable later', async () => {
    const { logger } = createRecordingLogger();
    const index: FakeSearchIndex = {
      name: 'chunks_text_index',
      type: 'search',
      status: 'PENDING',
      queryable: false,
      latestDefinition: {},
    };
    const { db } = createFakeDb({ collections: ['chunks'], search: { chunks: [index] } });

    const pending = waitForSearchIndex(db, 'chunks', 'chunks_text_index', 60_000, logger);
    await vi.advanceTimersByTimeAsync(4_000);
    index.status = 'READY';
    index.queryable = true;
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toBe(true);
  });

  it('throws IndexError with the server message when the build FAILED', async () => {
    const { logger } = createRecordingLogger();
    const { db } = createFakeDb({
      collections: ['chunks'],
      search: {
        chunks: [
          {
            name: 'chunks_text_index',
            type: 'search',
            status: 'FAILED',
            queryable: false,
            latestDefinition: {},
            message: 'analyzer lucene.nonsense is not a known analyzer',
          },
        ],
      },
    });

    const error = await waitForSearchIndex(db, 'chunks', 'chunks_text_index', 60_000, logger).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(IndexError);
    expect((error as IndexError).message).toContain('lucene.nonsense');
  });

  it('returns false when the index never appears at all', async () => {
    const { logger } = createRecordingLogger();
    const { db } = createFakeDb({ collections: ['chunks'] });

    const pending = waitForSearchIndex(db, 'chunks', 'missing_index', 4_000, logger);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(pending).resolves.toBe(false);
  });
});

describe('searchIndexIsQueryable', () => {
  it('is true only for a READY, queryable index', async () => {
    const { db } = createFakeDb({
      collections: ['chunks'],
      search: {
        chunks: [
          ready('ready_index', 'search', {}),
          {
            name: 'building',
            type: 'search',
            status: 'PENDING',
            queryable: false,
            latestDefinition: {},
          },
        ],
      },
    });

    await expect(searchIndexIsQueryable(db, 'chunks', 'ready_index')).resolves.toBe(true);
    await expect(searchIndexIsQueryable(db, 'chunks', 'building')).resolves.toBe(false);
    await expect(searchIndexIsQueryable(db, 'chunks', 'nope')).resolves.toBe(false);
  });

  it('answers false rather than throwing when the probe itself fails', async () => {
    const { db, state } = createFakeDb({ collections: ['chunks'] });
    state.failures.listSearchIndexes = mongoError('connection reset', 6);

    await expect(searchIndexIsQueryable(db, 'chunks', 'anything')).resolves.toBe(false);
  });
});
