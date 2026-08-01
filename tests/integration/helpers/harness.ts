/**
 * One fully wired stack per integration test file.
 *
 * The harness assembles exactly what `src/index.ts` assembles — config, logger,
 * MongoDB connection, embedding provider, `KnowledgeService`, indexes — against a
 * private, randomly named database. Nothing here is a mock: the point of this
 * suite is that `$vectorSearch` really runs against a real MongoDB Vector Search
 * index, so the only substitution is the embedding provider, which is forced to
 * `fake` (a deterministic hashed bag-of-words embedder with genuine semantic
 * signal) because CI has no Voyage key.
 *
 * ## MongoDB Search is eventually consistent, so we poll — never sleep
 *
 * A chunk inserted into `chunks` is not immediately visible to `mongot`. The
 * replication lag is small but unbounded, and a `setTimeout(1500)` is the classic
 * way to turn that into a test that passes on a fast laptop and fails in CI.
 * {@link Harness.waitForIndexedChunks} therefore asks the *index itself* how many
 * chunks it can currently see for a source and polls until the answer matches,
 * failing with both numbers if it never does. A timeout here is a real signal —
 * do not "fix" it by raising the limit.
 */
import { randomUUID } from 'node:crypto';

import type { Collection, Db, Document, MongoClient } from 'mongodb';

import { buildConfig, envSchema, type AppConfig } from '../../../src/config/env.js';
import { connectMongo, type MongoConnection } from '../../../src/db/client.js';
import { chunksCollection, documentsCollection } from '../../../src/db/collections.js';
import { ensureIndexes, type IndexSetupResult } from '../../../src/db/indexes.js';
import type { ChunkDoc, DocumentDoc } from '../../../src/domain/types.js';
import { createEmbeddingProvider } from '../../../src/embeddings/factory.js';
import { embedQuery, type EmbeddingProvider } from '../../../src/embeddings/provider.js';
import { createLogger, type Logger } from '../../../src/logger.js';
import { createKnowledgeService } from '../../../src/services/index.js';
import type { KnowledgeService, RequestContext } from '../../../src/services/types.js';
import {
  connectAdminClient,
  dropDatabaseQuietly,
  integrationMongoUri,
  reserveDatabaseName,
} from './database.js';

/** How long a search index has to become queryable before the suite gives up. */
const INDEX_READY_TIMEOUT_MS = 180_000;

/** How long `mongot` has to catch up with a write. */
const SEARCH_VISIBLE_TIMEOUT_MS = 60_000;

const POLL_INTERVAL_MS = 250;

/**
 * Ceiling on the readiness probe's `$vectorSearch`. Test corpora are tens of
 * chunks, so this is far above anything a probe needs to count.
 */
const PROBE_LIMIT = 400;
const PROBE_NUM_CANDIDATES = 2_000;

/** Fixed text for the probe vector: the direction is irrelevant, determinism is not. */
const PROBE_QUERY = 'MongoDB Search index readiness probe';

export interface HarnessOptions {
  /**
   * Extra environment for `envSchema`, e.g. tighter search limits. Applied on
   * top of `process.env`; `MONGODB_DB_NAME` and `EMBEDDING_PROVIDER` are always
   * overridden by the harness itself.
   */
  env?: Record<string, string>;
  /**
   * Run `ensureIndexes` during setup. The index suite drives `ensureIndexes`
   * itself and needs a virgin database, so it passes false.
   */
  applyIndexes?: boolean;
  /** Block until every search index reports queryable. Only meaningful with `applyIndexes`. */
  waitForQueryable?: boolean;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface Harness {
  dbName: string;
  config: AppConfig;
  logger: Logger;
  client: MongoClient;
  connection: MongoConnection;
  db: Db;
  embeddings: EmbeddingProvider;
  service: KnowledgeService;
  documents: Collection<DocumentDoc>;
  chunks: Collection<ChunkDoc>;
  /** Result of the setup-time `ensureIndexes`, or null when it was skipped. */
  indexes: IndexSetupResult | null;

  /** A `RequestContext` on the quiet logger. Channel defaults to 'cli'. */
  context(overrides?: Partial<RequestContext>): RequestContext;

  /**
   * A second `KnowledgeService` over the same database but a different embedding
   * provider — used to inject an embedding failure without a second database.
   */
  serviceWith(embeddings: EmbeddingProvider): KnowledgeService;

  applyIndexes(opts?: { waitForQueryable?: boolean }): Promise<IndexSetupResult>;

  /** How many chunks the *vector index* can currently see for this filter. */
  countVectorIndexed(filter: Document): Promise<number>;

  /** How many chunks the *text index* can currently see for this sourceId. */
  countTextIndexed(sourceId: string): Promise<number>;

  /** Poll until both search indexes report exactly `expected` chunks for `sourceId`. */
  waitForIndexedChunks(sourceId: string, expected: number, opts?: WaitOptions): Promise<void>;

  /** Generic poll. Fails with `description` rather than a bare timeout. */
  waitFor(
    description: string,
    predicate: () => Promise<boolean>,
    opts?: WaitOptions,
  ): Promise<void>;

  teardown(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Build the config for a test database.
 *
 * `EMBEDDING_PROVIDER` is pinned to `fake` and `VOYAGE_API_KEY` is dropped, so a
 * developer with a key exported in their shell cannot accidentally bill a real
 * Voyage account from the integration suite. `live-voyage.test.ts` is the single
 * opt-in exception and builds its own config.
 */
function harnessConfig(dbName: string, extra: Record<string, string> = {}): AppConfig {
  const { VOYAGE_API_KEY: _ignored, ...inherited } = process.env;

  const parsed = envSchema.safeParse({
    ...inherited,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    LOG_PRETTY: 'false',
    MONGODB_URI: integrationMongoUri(),
    MONGODB_DB_NAME: dbName,
    EMBEDDING_PROVIDER: 'fake',
    ...extra,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Integration harness config is invalid:\n  ${issues.join('\n  ')}`);
  }

  return buildConfig(parsed.data);
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const admin = await connectAdminClient();
  const dbName = await reserveDatabaseName(admin);

  const config = harnessConfig(dbName, options.env);
  const logger = createLogger(config.logging);

  let connection: MongoConnection;
  try {
    connection = await connectMongo(config.mongo, logger);
  } catch (error) {
    await admin.close().catch(() => undefined);
    throw error;
  }

  const db = connection.db;
  const embeddings = createEmbeddingProvider(config.embedding, logger);
  const service = createKnowledgeService({ db, embeddings, config, logger });
  const chunks = chunksCollection(db);

  /** Cached because every readiness poll needs it and it never changes. */
  let probeVector: number[] | null = null;
  async function getProbeVector(): Promise<number[]> {
    probeVector ??= await embedQuery(embeddings, PROBE_QUERY);
    return probeVector;
  }

  async function countVectorIndexed(filter: Document): Promise<number> {
    try {
      const rows = await chunks
        .aggregate<{ value: number }>([
          {
            $vectorSearch: {
              index: config.mongo.vectorIndexName,
              path: 'embedding',
              queryVector: await getProbeVector(),
              numCandidates: PROBE_NUM_CANDIDATES,
              limit: PROBE_LIMIT,
              filter,
            },
          },
          { $count: 'value' },
        ])
        .toArray();
      return rows[0]?.value ?? 0;
    } catch {
      // The index may not exist yet on the first poll; the caller is looping.
      return -1;
    }
  }

  async function countTextIndexed(sourceId: string): Promise<number> {
    try {
      const rows = await chunks
        .aggregate<{ value: number }>([
          {
            $search: {
              index: config.mongo.textIndexName,
              // `sourceId` is a lowercase-normalised token in chunks.text.json,
              // so the query side has to be lowercased to match.
              equals: { path: 'sourceId', value: sourceId.toLowerCase() },
            },
          },
          { $count: 'value' },
        ])
        .toArray();
      return rows[0]?.value ?? 0;
    } catch {
      return -1;
    }
  }

  async function waitFor(
    description: string,
    predicate: () => Promise<boolean>,
    opts: WaitOptions = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? SEARCH_VISIBLE_TIMEOUT_MS;
    const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (await predicate()) return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
      }
      await sleep(intervalMs);
    }
  }

  async function waitForIndexedChunks(
    sourceId: string,
    expected: number,
    opts: WaitOptions = {},
  ): Promise<void> {
    let lastVector = -1;
    let lastText = -1;

    try {
      await waitFor(
        `${expected} chunk(s) of "${sourceId}" to be visible to both search indexes`,
        async () => {
          [lastVector, lastText] = await Promise.all([
            countVectorIndexed({ sourceId: { $eq: sourceId } }),
            countTextIndexed(sourceId),
          ]);
          return lastVector === expected && lastText === expected;
        },
        opts,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason}\n  vector index sees ${lastVector}, text index sees ${lastText} ` +
          `(-1 means the index rejected the query). This is a real symptom: mongot is ` +
          'not keeping up or the index is not the one being written to. Do not lengthen ' +
          'the timeout to hide it.',
      );
    }
  }

  const harness: Harness = {
    dbName,
    config,
    logger,
    client: connection.client,
    connection,
    db,
    embeddings,
    service,
    documents: documentsCollection(db),
    chunks,
    indexes: null,

    context(overrides = {}) {
      return { channel: 'cli', requestId: randomUUID(), logger, ...overrides };
    },

    serviceWith(replacement) {
      return createKnowledgeService({ db, embeddings: replacement, config, logger });
    },

    async applyIndexes(opts = {}) {
      const result = await ensureIndexes(db, config, logger, {
        waitForQueryable: opts.waitForQueryable ?? true,
        timeoutMs: INDEX_READY_TIMEOUT_MS,
      });
      harness.indexes = result;
      return result;
    },

    countVectorIndexed,
    countTextIndexed,
    waitForIndexedChunks,
    waitFor,

    async teardown() {
      // Every step is independently guarded: a failure while tearing down must
      // never replace the assertion error a failing test is trying to report.
      await dropDatabaseQuietly(connection.client, dbName);
      await embeddings.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
      await admin.close().catch(() => undefined);
    },
  };

  if (options.applyIndexes ?? true) {
    try {
      await harness.applyIndexes({ waitForQueryable: options.waitForQueryable ?? true });
    } catch (error) {
      await harness.teardown();
      throw error;
    }
  }

  return harness;
}

/** Chunk documents for one source, in order — the raw persisted rows. */
export async function chunksOf(harness: Harness, sourceId: string): Promise<ChunkDoc[]> {
  return harness.chunks.find({ sourceId }).sort({ chunkIndex: 1 }).toArray();
}
