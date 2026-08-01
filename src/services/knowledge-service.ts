/**
 * The knowledge service — ingestion, search, management and re-embedding.
 *
 * This is the only module that knows how the product actually works. Transports
 * (MCP tools, REST routes, EJS pages, CLI) validate their input, call a method
 * here and format the answer; they hold no business logic and never build a
 * pipeline of their own. Everything below therefore has to be complete: no
 * "the caller will check that", no half-applied writes, and no raw
 * `MongoServerError` escaping to a wire format.
 *
 * ## Hybrid search
 *
 * Two aggregations — one `$vectorSearch`, one `$search` — run concurrently and
 * are fused in {@link reciprocalRankFusion}. We deliberately do NOT use
 * `$rankFusion`: doing the fusion here means Atlas Local 8.0 and cloud Atlas
 * behave identically and the ranking itself is unit-testable without a database.
 *
 * ## Vector-space hygiene
 *
 * Every vector query pins `embeddingModel` and `embeddingDimensions` to the
 * configured model. A half-finished backfill therefore returns fewer results
 * rather than silently mixing two incompatible vector spaces in one ranking,
 * which would produce confidently wrong answers.
 */
import { MongoServerError, ObjectId, type Document, type Filter } from 'mongodb';

import { chunkContent } from '../chunking/index.js';
import type { ChunkingConfig } from '../config/env.js';
import {
  CHUNK_VIEW_PROJECTION,
  COLLECTIONS,
  chunksCollection,
  documentsCollection,
} from '../db/collections.js';
import { searchIndexIsQueryable } from '../db/indexes.js';
import type {
  DeleteContentInput,
  ListDocumentsInput,
  ListSourcesInput,
  ReembedInput,
  SearchFilters,
  SearchKnowledgeInput,
  StoreContentInput,
} from '../domain/schemas.js';
import type {
  ChunkDoc,
  ChunkingResult,
  ContentType,
  DeleteContentResult,
  DocumentDetail,
  EmbeddingCoverage,
  EmbeddingStamp,
  ListDocumentsResult,
  ListSourcesResult,
  ReembedResult,
  SearchHit,
  SearchKnowledgeResult,
  SearchMode,
  SourceSummary,
  StoreContentResult,
  DocumentDoc,
} from '../domain/types.js';
import { embedQuery } from '../embeddings/provider.js';
import {
  ChunkingError,
  EmbeddingError,
  IndexError,
  InternalError,
  SearchError,
  StorageError,
  ValidationError,
  describeError,
  isAppError,
} from '../errors.js';
import { logAppError, type Logger } from '../logger.js';
import { buildHighlightFragments } from './highlight.js';
import { computeContentHash, deriveSourceId, deriveTitle, normalizeContent } from './identity.js';
import {
  reciprocalRankFusion,
  type FusedCandidate,
  type RankedCandidate,
} from './search-fusion.js';
import type { KnowledgeService, KnowledgeServiceDeps, RequestContext } from './types.js';

/**
 * Candidates retrieved per leg, relative to the requested limit. Fusion needs
 * depth to work with: if both legs only ever returned the final `limit` rows,
 * a chunk ranked 11th by both — the classic hybrid win — could never surface.
 */
const CANDIDATE_OVERFETCH = 4;
const MIN_CANDIDATE_POOL = 20;
const MAX_CANDIDATE_POOL = 500;
/** Atlas caps `numCandidates` at 10,000. */
const MAX_NUM_CANDIDATES = 10_000;

/** Characters pulled from `content` to build a browse excerpt, then condensed. */
const EXCERPT_SOURCE_CHARS = 600;
const EXCERPT_CHARS = 240;

/** Atlas can return a highlight per matched region; a UI wants two or three. */
const MAX_HIGHLIGHT_FRAGMENTS = 3;

/** Matches `reembedSchema.maxDocuments`; an unbounded backfill needs a ceiling. */
const REEMBED_DOCUMENT_CEILING = 100_000;

const SOURCE_SORT_FIELDS = {
  updatedAt: 'updatedAt',
  createdAt: 'createdAt',
  title: 'title',
  // The stored count, so sorting does not require joining every matched source.
  chunkCount: 'chunking.chunkCount',
} as const satisfies Record<ListSourcesInput['sort'], string>;

/**
 * `$facet.total` stages for a `$search`-backed listing, reshaped to the
 * `$count` form the non-search path produces. The count itself is computed by
 * mongot (`count: { type: 'total' }`) and read back through `$$SEARCH_META`.
 */
const SEARCH_TOTAL_FACET = [
  { $replaceWith: '$$SEARCH_META' },
  { $limit: 1 },
  { $project: { value: '$count.total' } },
];

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
  const { db, embeddings, config } = deps;
  const documents = documentsCollection(db);
  const chunks = chunksCollection(db);

  /**
   * Set once we have degraded to vector-only, so a knowledge base whose text
   * index is still building logs one warning instead of one per query. Reset on
   * the first successful text leg, so the recovery is visible too.
   */
  let textIndexDegradationLogged = false;

  /** Set once each index has been seen to exist; see {@link confirmIndex}. */
  let vectorIndexConfirmed = false;
  let textIndexConfirmed = false;
  let documentsIndexConfirmed = false;

  // -------------------------------------------------------------------------
  // storeContent
  // -------------------------------------------------------------------------

  async function storeContent(
    input: StoreContentInput,
    ctx: RequestContext,
  ): Promise<StoreContentResult> {
    const startedAt = Date.now();
    const logger = ctx.logger;
    const now = new Date();

    const content = normalizeContent(input.content);
    const contentHash = computeContentHash(content);
    const sourceId = deriveSourceId({
      sourceId: input.sourceId,
      uri: input.uri,
      title: input.title,
      contentHash,
    });
    const title = deriveTitle({ title: input.title, content, sourceId });

    const existing = await guarded(logger, 'documents.findOne', () =>
      documents.findOne({ sourceId }),
    );

    if (existing && existing.contentHash === contentHash) {
      const currency = await guarded(logger, 'chunks.currency', () => chunkCurrency(existing._id));

      // Three things must hold to skip the work: the chunks exist, all of them
      // exist (a crash between delete and insert leaves fewer than the document
      // claims), and they were embedded by the model we would use today.
      const complete =
        currency.total > 0 &&
        currency.total === existing.chunking.chunkCount &&
        currency.stale === 0;

      if (complete) {
        logger.debug(
          {
            event: 'ingest.unchanged',
            sourceId,
            documentId: existing._id.toHexString(),
            chunkCount: currency.total,
          },
          'content hash unchanged and embeddings current; skipping chunking and embedding',
        );

        return {
          documentId: existing._id.toHexString(),
          sourceId,
          title: existing.title,
          version: existing.version,
          chunkCount: currency.total,
          outcome: 'unchanged',
          chunkingStrategy: existing.chunking.strategy,
          embedding: {
            provider: embeddings.info.provider,
            model: embeddings.info.model,
            dimensions: embeddings.info.dimensions,
          },
          totalTokensEmbedded: 0,
          tookMs: Date.now() - startedAt,
        };
      }

      logger.debug(
        {
          event: 'ingest.repair',
          sourceId,
          documentId: existing._id.toHexString(),
          storedChunks: currency.total,
          expectedChunks: existing.chunking.chunkCount,
          staleChunks: currency.stale,
        },
        'content unchanged but chunks are missing or embedded by another model; re-ingesting',
      );
    }

    assertNotAborted(ctx);

    const chunkingOptions = resolveChunkingOptions(input);
    const chunking = runChunking(
      { content, contentType: input.contentType, options: chunkingOptions },
      logger,
      sourceId,
    );

    assertNotAborted(ctx);

    const chunkTexts = chunking.chunks.map((chunk) => chunk.text);
    const embedded = await embedDocument(chunkTexts, logger, ctx, { sourceId });

    const documentId = existing?._id ?? new ObjectId();
    const contentChanged = !existing || existing.contentHash !== contentHash;
    const stamp: EmbeddingStamp = {
      provider: embedded.info.provider,
      model: embedded.info.model,
      dimensions: embedded.info.dimensions,
      contextual: embedded.info.contextual,
    };

    const documentDoc: Omit<DocumentDoc, '_id'> = {
      sourceId,
      title,
      uri: input.uri ?? null,
      contentType: input.contentType,
      content,
      contentHash,
      contentLength: content.length,
      tags: input.tags,
      metadata: input.metadata,
      ingest: {
        agent: input.agent ?? null,
        sessionId: input.sessionId ?? ctx.sessionId ?? null,
        clientName: ctx.clientName ?? null,
        clientVersion: ctx.clientVersion ?? null,
        at: now,
        channel: ctx.channel,
      },
      chunking: {
        strategy: chunking.strategy,
        chunkSizeTokens: chunkingOptions.chunkSizeTokens,
        chunkOverlapTokens: chunkingOptions.chunkOverlapTokens,
        chunkCount: chunking.chunks.length,
      },
      embedding: stamp,
      // `version` tracks *content* revisions, so a pure re-embed of unchanged
      // text is not a new version and does not reorder an "updated recently"
      // list. Only a genuinely different body bumps either field.
      version: existing ? existing.version + (contentChanged ? 1 : 0) : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: contentChanged ? now : (existing?.updatedAt ?? now),
    };

    const chunkDocs: ChunkDoc[] = chunking.chunks.map((chunk, index) => ({
      _id: new ObjectId(),
      documentId,
      sourceId,
      chunkIndex: chunk.index,
      text: chunk.text,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      tokenCount: chunk.tokenCount,
      headingPath: chunk.headingPath,
      title,
      uri: input.uri ?? null,
      contentType: input.contentType,
      tags: input.tags,
      documentVersion: documentDoc.version,
      documentContentHash: contentHash,
      // `embedded.vectors` was length-checked against the chunk list already.
      embedding: embedded.vectors[index] ?? [],
      embeddingProvider: stamp.provider,
      embeddingModel: stamp.model,
      embeddingDimensions: stamp.dimensions,
      embeddedAt: now,
      createdAt: now,
      updatedAt: now,
    }));

    await guarded(logger, 'documents.persist', () =>
      persist(documentId, documentDoc, chunkDocs, logger),
    );

    return {
      documentId: documentId.toHexString(),
      sourceId,
      title,
      version: documentDoc.version,
      chunkCount: chunkDocs.length,
      outcome: existing ? 'updated' : 'created',
      chunkingStrategy: chunking.strategy,
      embedding: {
        provider: stamp.provider,
        model: stamp.model,
        dimensions: stamp.dimensions,
      },
      totalTokensEmbedded: embedded.totalTokens,
      tookMs: Date.now() - startedAt,
    };
  }

  /** How many chunks a document has, and how many were embedded by another model. */
  async function chunkCurrency(documentId: ObjectId): Promise<{ total: number; stale: number }> {
    const [row] = await chunks
      .aggregate<{ total: number; stale: number }>([
        { $match: { documentId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            stale: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$embeddingModel', config.embedding.model] },
                      { $eq: ['$embeddingDimensions', config.embedding.dimensions] },
                    ],
                  },
                  0,
                  1,
                ],
              },
            },
          },
        },
      ])
      .toArray();

    return { total: row?.total ?? 0, stale: row?.stale ?? 0 };
  }

  function resolveChunkingOptions(input: StoreContentInput): ChunkingConfig {
    const chunkSizeTokens = input.chunkSizeTokens ?? config.chunking.chunkSizeTokens;

    // A per-request size override can be smaller than the configured overlap or
    // minimum, which the chunker would rightly reject. The caller only asked for
    // smaller chunks, so scale the other two down rather than failing the call.
    return {
      chunkSizeTokens,
      chunkOverlapTokens: Math.min(
        input.chunkOverlapTokens ?? config.chunking.chunkOverlapTokens,
        chunkSizeTokens - 1,
      ),
      minChunkTokens: Math.min(config.chunking.minChunkTokens, chunkSizeTokens),
    };
  }

  /**
   * Persist the document and swap in its new chunks.
   *
   * Preferred path is a transaction: Atlas Local and cloud Atlas are both replica
   * sets, so the document row and the whole chunk set land together or not at
   * all, and a concurrent search can never observe a document whose chunks are
   * half old and half new.
   *
   * The trade-off is the 16MB oplog-entry limit on a single transaction. A very
   * large document (roughly 1,900+ chunks of 1024 float64s) exceeds it, so we
   * fall back to a non-transactional replace → delete → insert. That sequence
   * can only ever *under*-populate the chunk set on a crash, never mix
   * generations, and `storeContent` detects the shortfall on the next call for
   * the same `sourceId` (stored `chunking.chunkCount` vs actual) and repairs it.
   */
  async function persist(
    documentId: ObjectId,
    documentDoc: Omit<DocumentDoc, '_id'>,
    chunkDocs: ChunkDoc[],
    logger: Logger,
  ): Promise<void> {
    const session = db.client.startSession();
    let committed = false;

    try {
      await session.withTransaction(async (active) => {
        await documents.replaceOne({ _id: documentId }, documentDoc, {
          upsert: true,
          session: active,
        });
        await chunks.deleteMany({ documentId }, { session: active });
        if (chunkDocs.length > 0) {
          await chunks.insertMany(chunkDocs, { session: active, ordered: true });
        }
      });
      committed = true;
    } catch (error) {
      if (!isTransactionUnavailable(error)) throw error;
      logger.warn(
        {
          event: 'ingest.transaction_unavailable',
          documentId: documentId.toHexString(),
          chunkCount: chunkDocs.length,
          reason: describeError(error),
        },
        'transactional chunk swap unavailable; falling back to a non-atomic replace',
      );
    } finally {
      await session.endSession();
    }

    if (committed) return;

    await documents.replaceOne({ _id: documentId }, documentDoc, { upsert: true });
    await chunks.deleteMany({ documentId });
    if (chunkDocs.length > 0) await chunks.insertMany(chunkDocs, { ordered: true });
  }

  function runChunking(
    input: { content: string; contentType: ContentType; options: ChunkingConfig },
    logger: Logger,
    sourceId: string,
  ): ChunkingResult {
    try {
      const result = chunkContent(input);
      if (result.chunks.length === 0) {
        throw new ChunkingError('Content produced no chunks', {
          details: { sourceId, contentType: input.contentType, inputChars: input.content.length },
        });
      }
      return result;
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : new ChunkingError(`Could not chunk content: ${describeError(error)}`, {
            cause: error,
            details: { sourceId, contentType: input.contentType },
          });
      // Logged here, distinctly from a validation failure, per the spec.
      logAppError(logger, appError, 'chunking failed', { sourceId });
      throw appError;
    }
  }

  /**
   * Embed one document's chunks as a single group.
   *
   * The default model (`voyage-context-3`) is contextual: it conditions each
   * chunk vector on its siblings, so the chunks must arrive together and in
   * order. That is also why this is one call rather than a batch loop.
   */
  async function embedDocument(
    chunkTexts: string[],
    logger: Logger,
    ctx: RequestContext,
    context: Record<string, unknown>,
  ): Promise<{ vectors: number[][]; totalTokens: number; info: typeof embeddings.info }> {
    try {
      const result = await embeddings.embedDocumentChunks([chunkTexts], { signal: ctx.signal });
      const vectors = result.embeddings[0];

      if (!vectors || vectors.length !== chunkTexts.length) {
        throw new EmbeddingError(
          `Embedding provider returned ${vectors?.length ?? 0} vectors for ${chunkTexts.length} chunks`,
          { details: { ...context, expected: chunkTexts.length, received: vectors?.length ?? 0 } },
        );
      }

      // A wrong width is unrecoverable: the vector index would reject the write
      // or, worse, accept it and never match. Check before anything is stored.
      for (const [index, vector] of vectors.entries()) {
        if (vector.length !== config.embedding.dimensions) {
          throw new EmbeddingError(
            `Embedding ${index} has ${vector.length} dimensions, expected ${config.embedding.dimensions}`,
            { details: { ...context, chunkIndex: index, dimensions: vector.length } },
          );
        }
      }

      return { vectors, totalTokens: result.usage.totalTokens, info: result.info };
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : new EmbeddingError(`Embedding request failed: ${describeError(error)}`, {
            cause: error,
            details: context,
          });
      logAppError(logger, appError, 'embedding failed', context);
      throw appError;
    }
  }

  // -------------------------------------------------------------------------
  // searchKnowledge
  // -------------------------------------------------------------------------

  async function searchKnowledge(
    input: SearchKnowledgeInput,
    ctx: RequestContext,
  ): Promise<SearchKnowledgeResult> {
    const startedAt = Date.now();
    const logger = ctx.logger;

    const limit = Math.max(
      1,
      Math.min(input.limit ?? config.search.defaultLimit, config.search.maxLimit),
    );
    // `hybridEnabled` sets the default; an explicit `mode` is the caller's call.
    const mode: SearchMode = input.mode ?? (config.search.hybridEnabled ? 'hybrid' : 'vector');
    const poolSize = Math.min(
      MAX_CANDIDATE_POOL,
      Math.max(limit * CANDIDATE_OVERFETCH, MIN_CANDIDATE_POOL),
    );

    assertNotAborted(ctx);

    const queryVector = mode === 'text' ? null : await embedSearchQuery(input.query, ctx);

    const [vectorLeg, textOutcome] = await Promise.all([
      queryVector === null
        ? Promise.resolve(emptyLeg())
        : runVectorLeg(queryVector, input.filters, poolSize, logger),
      mode === 'vector'
        ? Promise.resolve<TextLegOutcome>({ status: 'skipped' })
        : runTextLeg(input.query, input.filters, poolSize),
    ]);

    let effectiveMode: SearchMode = mode;
    let textLeg = emptyLeg();

    if (textOutcome.status === 'ok') {
      textLeg = textOutcome.leg;
      textIndexDegradationLogged = false;
    } else if (textOutcome.status === 'failed') {
      if (mode === 'text') throw textLegError(textOutcome.error, logger);
      // Hybrid degrades rather than failing: half a good answer beats a 503,
      // and on a fresh knowledge base the text index is routinely still
      // building while vectors are already queryable.
      effectiveMode = 'vector';
      reportTextDegradation(textOutcome, logger);
    }

    const vectorWeight =
      effectiveMode === 'hybrid' ? config.search.vectorWeight : effectiveMode === 'vector' ? 1 : 0;

    const fused = reciprocalRankFusion({
      vector: vectorLeg.candidates,
      text: textLeg.candidates,
      k: config.search.rrfK,
      vectorWeight,
    });

    // The final score is known before hydration, so `minScore` and the limit are
    // applied first and only the survivors are read back from the collection.
    const selected: FusedCandidate[] = [];
    for (const candidate of fused) {
      const score = finalScore(candidate, effectiveMode);
      if (input.minScore !== undefined && score < input.minScore) continue;
      selected.push({ ...candidate, score });
      if (selected.length >= limit) break;
    }

    const hits = await guarded(logger, 'chunks.hydrate', () => hydrate(selected, input, textLeg));

    return {
      query: input.query,
      mode,
      effectiveMode,
      // Candidate depth is capped by the overfetch, so any number larger than
      // what we return would be a guess dressed up as a total.
      totalHits: hits.length,
      hits,
      tookMs: Date.now() - startedAt,
      embedding: { model: embeddings.info.model, dimensions: embeddings.info.dimensions },
    };
  }

  async function embedSearchQuery(query: string, ctx: RequestContext): Promise<number[]> {
    try {
      const vector = await embedQuery(embeddings, query, { signal: ctx.signal });
      if (vector.length !== config.embedding.dimensions) {
        throw new EmbeddingError(
          `Query embedding has ${vector.length} dimensions, expected ${config.embedding.dimensions}`,
          { details: { dimensions: vector.length } },
        );
      }
      return vector;
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : new EmbeddingError(`Could not embed the search query: ${describeError(error)}`, {
            cause: error,
          });
      logAppError(ctx.logger, appError, 'query embedding failed');
      throw appError;
    }
  }

  async function runVectorLeg(
    queryVector: number[],
    filters: SearchFilters,
    poolSize: number,
    logger: Logger,
  ): Promise<LegResult> {
    const numCandidates = Math.min(
      MAX_NUM_CANDIDATES,
      Math.max(poolSize * config.search.candidateMultiplier, poolSize),
    );

    let rows: Array<{ _id: ObjectId; score: number }>;

    try {
      rows = await chunks
        .aggregate<{ _id: ObjectId; score: number }>([
          {
            $vectorSearch: {
              index: config.mongo.vectorIndexName,
              path: 'embedding',
              queryVector,
              numCandidates,
              limit: poolSize,
              filter: buildVectorFilter(filters),
            },
          },
          { $project: { _id: 1, score: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();
    } catch (error) {
      const appError = isMissingSearchIndexError(error)
        ? missingIndexError(config.mongo.vectorIndexName, COLLECTIONS.chunks, error)
        : new SearchError(`Vector search failed: ${describeError(error)}`, {
            cause: error,
            details: { index: config.mongo.vectorIndexName },
          });

      logAppError(logger, appError, 'vector search leg failed');
      throw appError;
    }

    if (rows.length === 0) {
      // Missing vector index is fatal — silently returning nothing would send an
      // operator hunting for missing content that is actually sitting right there.
      const queryable = await confirmIndex('vector', config.mongo.vectorIndexName);
      if (!queryable) {
        const appError = missingIndexError(config.mongo.vectorIndexName, COLLECTIONS.chunks, null);
        logAppError(logger, appError, 'vector search index is not queryable');
        throw appError;
      }
    } else {
      vectorIndexConfirmed = true;
    }

    return {
      candidates: rows.map((row) => ({ chunkId: row._id.toHexString(), score: row.score })),
      highlights: new Map(),
    };
  }

  /**
   * Is this search index actually there?
   *
   * Only ever called when a leg came back empty, because Atlas Local answers a
   * query against an index that does not exist with an empty result set rather
   * than an error — so "no hits" is genuinely ambiguous between "nothing
   * matched" and "nothing is indexed". Cloud Atlas may raise instead, which the
   * `catch` above already handles. The confirmation is cached after the first
   * success, so the hot path never pays for it and a populated knowledge base
   * pays once at most.
   */
  async function confirmIndex(
    leg: 'vector' | 'text' | 'documents',
    name: string,
  ): Promise<boolean> {
    const confirmed =
      leg === 'vector'
        ? vectorIndexConfirmed
        : leg === 'text'
          ? textIndexConfirmed
          : documentsIndexConfirmed;
    if (confirmed) return true;

    const collection = leg === 'documents' ? COLLECTIONS.documents : COLLECTIONS.chunks;
    const queryable = await searchIndexIsQueryable(db, collection, name);
    if (!queryable) return false;

    if (leg === 'vector') vectorIndexConfirmed = true;
    else if (leg === 'text') textIndexConfirmed = true;
    else documentsIndexConfirmed = true;
    return true;
  }

  function missingIndexError(name: string, collection: string, cause: unknown): IndexError {
    return new IndexError(
      `Search index "${name}" is missing or not yet queryable on ${collection}. ` +
        'Run "npm run db:indexes" to create it, then retry.',
      {
        ...(cause === null ? {} : { cause }),
        details: { index: name, collection },
        retryable: true,
      },
    );
  }

  /**
   * Error boundary for the `$search`-backed browse listing.
   *
   * Browse search is an explicit request against one index, so unlike the
   * hybrid text leg there is nothing to degrade to: a failure surfaces as the
   * right AppError instead. `guarded` is wrong here — it would file a search
   * failure under `storage.failed`.
   */
  async function browseSearch<T>(
    logger: Logger,
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isAppError(error)) throw error;
      const appError = isMissingSearchIndexError(error)
        ? missingIndexError(config.mongo.documentsTextIndexName, COLLECTIONS.documents, error)
        : new SearchError(`Browse search failed: ${describeError(error)}`, {
            cause: error,
            details: { index: config.mongo.documentsTextIndexName, operation },
          });
      logAppError(logger, appError, 'browse search failed');
      throw appError;
    }
  }

  /**
   * Atlas Local answers a query against a missing index with an empty result
   * set, so a zero-hit browse search is ambiguous. Resolve it the way the
   * vector leg does: probe once, and treat a missing index as fatal — silently
   * listing nothing would send an operator hunting for documents that are
   * sitting right there.
   */
  async function assertBrowseSearchServed(total: number, logger: Logger): Promise<void> {
    if (total > 0) {
      documentsIndexConfirmed = true;
      return;
    }
    if (await confirmIndex('documents', config.mongo.documentsTextIndexName)) return;

    const appError = missingIndexError(
      config.mongo.documentsTextIndexName,
      COLLECTIONS.documents,
      null,
    );
    logAppError(logger, appError, 'documents search index is not queryable');
    throw appError;
  }

  async function runTextLeg(
    query: string,
    filters: SearchFilters,
    poolSize: number,
  ): Promise<TextLegOutcome> {
    let rows: Array<{ _id: ObjectId; score: number; highlights?: SearchHighlightMeta[] }>;

    try {
      rows = await chunks
        .aggregate<{ _id: ObjectId; score: number; highlights?: SearchHighlightMeta[] }>([
          {
            $search: {
              index: config.mongo.textIndexName,
              compound: {
                must: [{ text: { query, path: ['text', 'title', 'headingPath'] } }],
                filter: buildTextFilter(filters),
              },
              highlight: { path: 'text' },
            },
          },
          { $limit: poolSize },
          {
            $project: {
              _id: 1,
              score: { $meta: 'searchScore' },
              highlights: { $meta: 'searchHighlights' },
            },
          },
        ])
        .toArray();
    } catch (error) {
      // Never rethrown from here: hybrid callers degrade and a text-only caller
      // converts this into the right AppError. Detection is by the server's own
      // error rather than a `listSearchIndexes` pre-flight on every query.
      return { status: 'failed', error, missingIndex: isMissingSearchIndexError(error) };
    }

    if (rows.length === 0 && !(await confirmIndex('text', config.mongo.textIndexName))) {
      return {
        status: 'failed',
        error: missingIndexError(config.mongo.textIndexName, COLLECTIONS.chunks, null),
        missingIndex: true,
      };
    }

    const highlights = new Map<string, string[]>();
    for (const row of rows) {
      const fragments = (row.highlights ?? [])
        .slice(0, MAX_HIGHLIGHT_FRAGMENTS)
        // Atlas returns the whole indexed field when it is short, which is not a
        // snippet. Re-window it so both search paths hand the UI the same shape.
        .flatMap((entry) =>
          buildHighlightFragments(entry.texts.map((part) => part.value).join(''), query, {
            maxFragments: 1,
          }),
        )
        .filter((fragment) => fragment.trim().length > 0);
      if (fragments.length > 0) highlights.set(row._id.toHexString(), fragments);
    }

    return {
      status: 'ok',
      leg: {
        candidates: rows.map((row) => ({ chunkId: row._id.toHexString(), score: row.score })),
        highlights,
      },
    };
  }

  function textLegError(error: unknown, logger: Logger): Error {
    const appError = isAppError(error)
      ? error
      : isMissingSearchIndexError(error)
        ? missingIndexError(config.mongo.textIndexName, COLLECTIONS.chunks, error)
        : new SearchError(`Text search failed: ${describeError(error)}`, { cause: error });

    logAppError(logger, appError, 'text search leg failed');
    return appError;
  }

  function reportTextDegradation(
    outcome: Extract<TextLegOutcome, { status: 'failed' }>,
    logger: Logger,
  ): void {
    if (outcome.missingIndex) {
      if (textIndexDegradationLogged) return;
      textIndexDegradationLogged = true;
      logger.warn(
        {
          event: 'search.text_index_unavailable',
          index: config.mongo.textIndexName,
          reason: describeError(outcome.error),
        },
        'text index unavailable; serving vector-only results until it is queryable ' +
          '(run "npm run db:indexes")',
      );
      return;
    }

    // Not a missing index: something else broke. Still degrade — the semantic
    // half of the answer is worth returning — but log it loudly every time.
    logAppError(
      logger,
      new SearchError(`Text search leg failed: ${describeError(outcome.error)}`, {
        cause: outcome.error,
        details: { index: config.mongo.textIndexName },
      }),
      'text search leg failed; degrading to vector-only',
    );
  }

  function buildVectorFilter(filters: SearchFilters): Document {
    const clauses: Document[] = [
      { embeddingModel: { $eq: config.embedding.model } },
      { embeddingDimensions: { $eq: config.embedding.dimensions } },
    ];

    if (filters?.sourceIds?.length) clauses.push({ sourceId: { $in: filters.sourceIds } });
    if (filters?.documentIds?.length) {
      clauses.push({ documentId: { $in: filters.documentIds.map((id) => new ObjectId(id)) } });
    }
    if (filters?.contentTypes?.length) clauses.push({ contentType: { $in: filters.contentTypes } });

    // `$vectorSearch` filters support no `$all`, so ALL-of-these-tags is an $and
    // of single-element `$in`s, each of which matches any element of the array.
    for (const tag of normalizeTags(filters?.tags)) clauses.push({ tags: { $in: [tag] } });

    return { $and: clauses };
  }

  function buildTextFilter(filters: SearchFilters): Document[] {
    // `embeddingDimensions` is not in chunks.text.json, so the text leg can only
    // pin the model. That is enough in practice: two configurations that share a
    // model name but differ in width are the pathological case, and the vector
    // leg pins both anyway.
    const clauses: Document[] = [tokenEquals('embeddingModel', [config.embedding.model])];

    if (filters?.sourceIds?.length) clauses.push(tokenEquals('sourceId', filters.sourceIds));
    if (filters?.contentTypes?.length)
      clauses.push(tokenEquals('contentType', filters.contentTypes));
    if (filters?.documentIds?.length) {
      clauses.push(
        anyOf(
          filters.documentIds.map((id) => ({
            equals: { path: 'documentId', value: new ObjectId(id) },
          })),
        ),
      );
    }
    for (const tag of normalizeTags(filters?.tags)) clauses.push(tokenEquals('tags', [tag]));

    return clauses;
  }

  async function hydrate(
    selected: FusedCandidate[],
    input: SearchKnowledgeInput,
    textLeg: LegResult,
  ): Promise<SearchHit[]> {
    if (selected.length === 0) return [];

    const rows = await chunks
      .find(
        { _id: { $in: selected.map((candidate) => new ObjectId(candidate.chunkId)) } },
        { projection: CHUNK_VIEW_PROJECTION },
      )
      .toArray();

    const byId = new Map(rows.map((row) => [row._id.toHexString(), row]));
    const hits: SearchHit[] = [];

    for (const candidate of selected) {
      const row = byId.get(candidate.chunkId);
      // A chunk deleted between the search and the hydration is simply gone.
      if (!row) continue;

      hits.push({
        chunkId: candidate.chunkId,
        documentId: row.documentId.toHexString(),
        sourceId: row.sourceId,
        title: row.title,
        uri: row.uri,
        contentType: row.contentType,
        chunkIndex: row.chunkIndex,
        headingPath: row.headingPath,
        tags: row.tags,
        text: input.includeText ? row.text : '',
        score: candidate.score,
        vectorScore: candidate.vectorScore,
        textScore: candidate.textScore,
        vectorRank: candidate.vectorRank,
        textRank: candidate.textRank,
        // Atlas highlights when the text leg found this chunk; otherwise a
        // locally computed window, so vector-only results still get a snippet.
        highlights:
          textLeg.highlights.get(candidate.chunkId) ??
          buildHighlightFragments(row.text, input.query),
      });
    }

    return hits;
  }

  // -------------------------------------------------------------------------
  // listSources
  // -------------------------------------------------------------------------

  async function listSources(
    input: ListSourcesInput,
    ctx: RequestContext,
  ): Promise<ListSourcesResult> {
    const direction = input.order === 'asc' ? 1 : -1;
    const sortField = SOURCE_SORT_FIELDS[input.sort];

    const pageStages: Document[] = [
      { $skip: input.offset },
      { $limit: input.limit },
      {
        // Joined after the page is cut, so the per-source chunk stats are
        // computed for `limit` documents, not for the whole match.
        $lookup: {
          from: COLLECTIONS.chunks,
          localField: '_id',
          foreignField: 'documentId',
          as: 'chunkStats',
          pipeline: [
            {
              $group: {
                _id: null,
                chunkCount: { $sum: 1 },
                embeddingModels: { $addToSet: '$embeddingModel' },
              },
            },
          ],
        },
      },
      {
        $project: {
          sourceId: 1,
          title: 1,
          uri: 1,
          contentType: 1,
          tags: 1,
          contentLength: 1,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
          stats: { $first: '$chunkStats' },
        },
      },
    ];

    // `$search` sorts on indexed fields only, so `_id` cannot break ties there;
    // dates tie on the millisecond at worst, but counts and titles tie often
    // enough to earn a recency tie-break.
    const searchSort: Document = { [sortField]: direction };
    if (sortField !== 'updatedAt') searchSort['updatedAt'] = -1;

    // Both shapes are one round trip: a separate countDocuments would be a
    // second pass over the same match, and could disagree with the page under
    // concurrent writes.
    const pipeline: Document[] = input.search
      ? [
          buildDocumentSearchStage(
            config.mongo.documentsTextIndexName,
            input.search,
            input.tag,
            searchSort,
          ),
          { $facet: { total: SEARCH_TOTAL_FACET, page: pageStages } },
        ]
      : [
          { $match: buildDocumentMatch(input.tag) },
          {
            $facet: {
              total: [{ $count: 'value' }],
              // `_id` breaks ties so pagination cannot repeat or skip a row.
              page: [{ $sort: { [sortField]: direction, _id: direction } }, ...pageStages],
            },
          },
        ];

    const run = () => documents.aggregate<FacetResult<SourceRow>>(pipeline).toArray();
    const [facet] = input.search
      ? await browseSearch(ctx.logger, 'documents.listSources', run)
      : await guarded(ctx.logger, 'documents.listSources', run);

    const total = facet?.total[0]?.value ?? 0;
    if (input.search) await assertBrowseSearchServed(total, ctx.logger);

    const sources: SourceSummary[] = (facet?.page ?? []).map((row) => ({
      sourceId: row.sourceId,
      title: row.title,
      uri: row.uri,
      contentType: row.contentType,
      tags: row.tags,
      // The real count, not the document's stored one: a mismatch is exactly
      // what an operator needs to see after an interrupted ingest.
      chunkCount: row.stats?.chunkCount ?? 0,
      contentLength: row.contentLength,
      version: row.version,
      // More than one model means a backfill is mid-flight.
      embeddingModels: [...(row.stats?.embeddingModels ?? [])].sort(),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return { sources, total, limit: input.limit, offset: input.offset };
  }

  // -------------------------------------------------------------------------
  // deleteContent
  // -------------------------------------------------------------------------

  async function deleteContent(
    input: DeleteContentInput,
    ctx: RequestContext,
  ): Promise<DeleteContentResult> {
    const logger = ctx.logger;
    const selector = buildDeleteSelector(input);

    const targets = await guarded(logger, 'documents.resolveDelete', () =>
      documents.find(selector, { projection: { _id: 1, sourceId: 1 } }).toArray(),
    );

    // A selector that matches nothing is a no-op, not an error: an AI client
    // cleaning up after itself should be able to retry a delete safely.
    if (targets.length === 0) return { deletedDocuments: 0, deletedChunks: 0, sourceIds: [] };

    const documentIds = targets.map((target) => target._id);
    const sourceIds = targets.map((target) => target.sourceId);

    // Chunks first. The reverse order could leave chunks whose parent is gone,
    // and those are invisible in every management view — true orphans.
    const chunkResult = await guarded(logger, 'chunks.deleteMany', () =>
      chunks.deleteMany({ documentId: { $in: documentIds } }),
    );

    let documentResult;
    try {
      documentResult = await documents.deleteMany({ _id: { $in: documentIds } });
    } catch (error) {
      const appError = new StorageError(
        `Deleted ${chunkResult.deletedCount} chunks but could not delete the ` +
          `${documentIds.length} parent document(s); the knowledge base now has documents ` +
          'with no chunks. Re-run the same delete to finish.',
        {
          cause: error,
          details: { sourceIds, deletedChunks: chunkResult.deletedCount },
          retryable: true,
        },
      );
      logAppError(logger, appError, 'document delete failed after chunk delete');
      throw appError;
    }

    logger.info(
      {
        event: 'content.deleted',
        deletedDocuments: documentResult.deletedCount,
        deletedChunks: chunkResult.deletedCount,
        sourceIds,
      },
      'deleted content',
    );

    return {
      deletedDocuments: documentResult.deletedCount,
      deletedChunks: chunkResult.deletedCount,
      sourceIds,
    };
  }

  function buildDeleteSelector(input: DeleteContentInput): Filter<DocumentDoc> {
    if (input.documentId) return { _id: new ObjectId(input.documentId) };
    if (input.sourceId) return { sourceId: input.sourceId };
    const tags = normalizeTags(input.tags);
    // ALL of the given tags, per the tool description — an ANY match would make
    // a broad delete far too easy to trigger by accident.
    if (tags.length > 0) return { tags: { $all: tags } };

    throw new ValidationError('delete_content requires one of sourceId, documentId or tags');
  }

  // -------------------------------------------------------------------------
  // listDocuments / getDocument
  // -------------------------------------------------------------------------

  async function listDocuments(
    input: ListDocumentsInput,
    ctx: RequestContext,
  ): Promise<ListDocumentsResult> {
    const pageStages: Document[] = [
      { $skip: input.offset },
      { $limit: input.limit },
      // The excerpt is cut server-side and `content` is dropped, so a browse
      // page never pulls megabytes of body text over the wire.
      { $addFields: { excerpt: { $substrCP: ['$content', 0, EXCERPT_SOURCE_CHARS] } } },
      { $project: { content: 0 } },
    ];

    const pipeline: Document[] = input.search
      ? [
          buildDocumentSearchStage(config.mongo.documentsTextIndexName, input.search, input.tag, {
            updatedAt: -1,
          }),
          { $facet: { total: SEARCH_TOTAL_FACET, page: pageStages } },
        ]
      : [
          { $match: buildDocumentMatch(input.tag) },
          {
            $facet: {
              total: [{ $count: 'value' }],
              page: [{ $sort: { updatedAt: -1, _id: -1 } }, ...pageStages],
            },
          },
        ];

    const run = () => documents.aggregate<FacetResult<DocumentListRow>>(pipeline).toArray();
    const [facet] = input.search
      ? await browseSearch(ctx.logger, 'documents.listDocuments', run)
      : await guarded(ctx.logger, 'documents.listDocuments', run);

    const total = facet?.total[0]?.value ?? 0;
    if (input.search) await assertBrowseSearchServed(total, ctx.logger);

    const documentsPage = (facet?.page ?? []).map((row) => {
      const { _id, excerpt, ...rest } = row;
      return { ...rest, id: _id.toHexString(), excerpt: condenseExcerpt(excerpt) };
    });

    return { documents: documentsPage, total, limit: input.limit, offset: input.offset };
  }

  async function getDocument(
    idOrSourceId: string,
    ctx: RequestContext,
  ): Promise<DocumentDetail | null> {
    return guarded(ctx.logger, 'documents.getDocument', async () => {
      // Try the ObjectId reading first, then the sourceId: a 24-hex string is a
      // legal `sourceId` too, so both have to be attempted rather than guessed.
      const document =
        (ObjectId.isValid(idOrSourceId) && /^[0-9a-fA-F]{24}$/u.test(idOrSourceId)
          ? await documents.findOne({ _id: new ObjectId(idOrSourceId) })
          : null) ?? (await documents.findOne({ sourceId: idOrSourceId }));

      if (!document) return null;

      const chunkRows = await chunks
        .find({ documentId: document._id }, { projection: CHUNK_VIEW_PROJECTION })
        .sort({ chunkIndex: 1 })
        .toArray();

      const { _id, ...documentRest } = document;

      return {
        document: { ...documentRest, id: _id.toHexString() },
        chunks: chunkRows.map((row) => {
          const { _id: chunkId, documentId, ...chunkRest } = row;
          return {
            ...chunkRest,
            id: chunkId.toHexString(),
            documentId: documentId.toHexString(),
          };
        }),
      };
    });
  }

  // -------------------------------------------------------------------------
  // reembed / embeddingCoverage
  // -------------------------------------------------------------------------

  /**
   * Backfill chunks whose vector came from a different model or width.
   *
   * Work is grouped by document and every chunk of a touched document is
   * re-embedded, not just the stale ones: the contextual model needs the whole
   * document in chunk order, and leaving a document with vectors from two runs
   * is the mixed-vector-space problem this whole exercise exists to avoid.
   *
   * One bad document must never abort a long backfill, so failures are counted
   * and logged and the loop continues.
   */
  async function reembed(input: ReembedInput, ctx: RequestContext): Promise<ReembedResult> {
    const startedAt = Date.now();
    const logger = ctx.logger;
    const targetModel = input.targetModel ?? config.embedding.model;
    const targetDimensions = input.targetDimensions ?? config.embedding.dimensions;

    if (
      targetModel !== config.embedding.model ||
      targetDimensions !== config.embedding.dimensions
    ) {
      // The provider can only produce what it is configured for, so a target it
      // cannot reach would re-select the same chunks forever.
      throw new ValidationError(
        `Re-embedding target ${targetModel}@${targetDimensions} does not match the configured ` +
          `provider (${config.embedding.model}@${config.embedding.dimensions}). Change ` +
          'EMBEDDING_MODEL / EMBEDDING_DIMENSIONS and restart, then run the backfill.',
        { details: { targetModel, targetDimensions } },
      );
    }

    const staleFilter: Filter<ChunkDoc> = {
      $or: [
        { embeddingModel: { $ne: targetModel } },
        { embeddingDimensions: { $ne: targetDimensions } },
      ],
    };
    if (input.sourceIds?.length) staleFilter.sourceId = { $in: input.sourceIds };

    const [facet] = await guarded(logger, 'chunks.findStale', () =>
      chunks
        .aggregate<FacetResult<{ _id: ObjectId; staleChunks: number }>>([
          { $match: staleFilter },
          {
            $facet: {
              total: [{ $count: 'value' }],
              page: [
                { $group: { _id: '$documentId', staleChunks: { $sum: 1 } } },
                // Stable order, so successive capped runs make progress through
                // the corpus instead of re-picking the same documents.
                { $sort: { _id: 1 } },
                { $limit: input.maxDocuments ?? REEMBED_DOCUMENT_CEILING },
              ],
            },
          },
        ])
        .toArray(),
    );

    const staleChunks = facet?.total[0]?.value ?? 0;
    const candidates = facet?.page ?? [];

    if (input.dryRun) {
      logger.info(
        { event: 'reembed.dry_run', staleChunks, documents: candidates.length, targetModel },
        're-embedding dry run',
      );
      return {
        staleChunks,
        documentsProcessed: candidates.length,
        chunksReembedded: 0,
        chunksFailed: 0,
        targetModel,
        targetDimensions,
        dryRun: true,
        totalTokensEmbedded: 0,
        tookMs: Date.now() - startedAt,
      };
    }

    let documentsProcessed = 0;
    let chunksReembedded = 0;
    let chunksFailed = 0;
    let totalTokensEmbedded = 0;

    for (const candidate of candidates) {
      if (ctx.signal?.aborted === true) {
        logger.warn(
          { event: 'reembed.aborted', documentsProcessed, chunksReembedded },
          'backfill aborted by the caller',
        );
        break;
      }

      try {
        const chunkRows = await chunks
          .find({ documentId: candidate._id }, { projection: CHUNK_VIEW_PROJECTION })
          .sort({ chunkIndex: 1 })
          .toArray();

        if (chunkRows.length === 0) continue;

        const embedded = await embedDocument(
          chunkRows.map((row) => row.text),
          logger,
          ctx,
          { documentId: candidate._id.toHexString(), sourceId: chunkRows[0]?.sourceId },
        );

        const embeddedAt = new Date();
        const operations = chunkRows.map((row, index) => ({
          updateOne: {
            filter: { _id: row._id },
            update: {
              $set: {
                embedding: embedded.vectors[index] ?? [],
                embeddingProvider: embedded.info.provider,
                embeddingModel: embedded.info.model,
                embeddingDimensions: embedded.info.dimensions,
                embeddedAt,
                updatedAt: embeddedAt,
              },
            },
          },
        }));

        await chunks.bulkWrite(operations, { ordered: false });

        // Keep the parent's stamp honest; management views read it.
        await documents.updateOne(
          { _id: candidate._id },
          {
            $set: {
              embedding: {
                provider: embedded.info.provider,
                model: embedded.info.model,
                dimensions: embedded.info.dimensions,
                contextual: embedded.info.contextual,
              },
            },
          },
        );

        documentsProcessed += 1;
        chunksReembedded += chunkRows.length;
        totalTokensEmbedded += embedded.totalTokens;
      } catch (error) {
        // `staleChunks` for this document, so the failure count stays comparable
        // with the `staleChunks` total rather than counting healthy siblings.
        chunksFailed += candidate.staleChunks;
        logAppError(logger, error, 'document re-embedding failed; continuing backfill', {
          documentId: candidate._id.toHexString(),
        });
      }
    }

    logger.info(
      {
        event: 'reembed.completed',
        staleChunks,
        documentsProcessed,
        chunksReembedded,
        chunksFailed,
        targetModel,
        targetDimensions,
      },
      're-embedding run finished',
    );

    return {
      staleChunks,
      documentsProcessed,
      chunksReembedded,
      chunksFailed,
      targetModel,
      targetDimensions,
      dryRun: false,
      totalTokensEmbedded,
      tookMs: Date.now() - startedAt,
    };
  }

  async function embeddingCoverage(ctx: RequestContext): Promise<EmbeddingCoverage[]> {
    const rows = await guarded(ctx.logger, 'chunks.coverage', () =>
      chunks
        .aggregate<CoverageRow>([
          // Grouped in two passes rather than `$addToSet`-ing every documentId:
          // a single group holding a set of ids for a large corpus can exceed
          // the 100MB group limit, and this cannot.
          {
            $group: {
              _id: {
                provider: '$embeddingProvider',
                model: '$embeddingModel',
                dimensions: '$embeddingDimensions',
                documentId: '$documentId',
              },
              chunkCount: { $sum: 1 },
            },
          },
          {
            $group: {
              _id: {
                provider: '$_id.provider',
                model: '$_id.model',
                dimensions: '$_id.dimensions',
              },
              chunkCount: { $sum: '$chunkCount' },
              documentCount: { $sum: 1 },
            },
          },
          { $sort: { chunkCount: -1, '_id.model': 1 } },
        ])
        .toArray(),
    );

    return rows.map((row) => ({
      model: row._id.model,
      dimensions: row._id.dimensions,
      provider: row._id.provider,
      chunkCount: row.chunkCount,
      documentCount: row.documentCount,
    }));
  }

  return {
    storeContent,
    searchKnowledge,
    listSources,
    deleteContent,
    listDocuments,
    getDocument,
    reembed,
    embeddingCoverage,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface LegResult {
  candidates: RankedCandidate[];
  /** chunkId → MongoDB Search highlight fragments. Empty for the vector leg. */
  highlights: Map<string, string[]>;
}

type TextLegOutcome =
  | { status: 'ok'; leg: LegResult }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown; missingIndex: boolean };

interface SearchHighlightMeta {
  score: number;
  path: string;
  texts: Array<{ value: string; type: string }>;
}

interface FacetResult<T> {
  total: Array<{ value: number }>;
  page: T[];
}

interface SourceRow {
  sourceId: string;
  title: string;
  uri: string | null;
  contentType: DocumentDoc['contentType'];
  tags: string[];
  contentLength: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  stats?: { chunkCount: number; embeddingModels: string[] };
}

type DocumentListRow = Omit<DocumentDoc, 'content'> & { excerpt: string };

interface CoverageRow {
  _id: { provider: string; model: string; dimensions: number };
  chunkCount: number;
  documentCount: number;
}

function emptyLeg(): LegResult {
  return { candidates: [], highlights: new Map() };
}

/**
 * Which number a caller sees as `score`.
 *
 * Fused RRF scores are tiny and only comparable within one response, so a
 * single-strategy search reports that strategy's own score instead — which is
 * also what makes `minScore` usable as a cosine-similarity cut-off. `mode` here
 * is the *effective* mode, so a degraded hybrid reports cosine, matching the
 * `effectiveMode` it returns.
 */
function finalScore(candidate: FusedCandidate, mode: SearchMode): number {
  if (mode === 'vector') return candidate.vectorScore ?? candidate.score;
  if (mode === 'text') return candidate.textScore ?? candidate.score;
  return candidate.score;
}

/** MongoDB Search `equals` over token-indexed values, ORed when there are several. */
function tokenEquals(path: string, values: readonly string[]): Document {
  // The index normalises tokens to lowercase; normalise the query side too so a
  // filter matches regardless of how the caller cased it.
  return anyOf(values.map((value) => ({ equals: { path, value: value.toLowerCase() } })));
}

/**
 * Wrap alternatives in a `compound.should`.
 *
 * Deliberately built from `equals` rather than the `in` operator: `equals` is
 * supported by every mongot version we might meet, including whatever ships
 * inside the Atlas Local image, and a filter clause is not worth a version
 * dependency.
 */
function anyOf(clauses: Document[]): Document {
  const [first] = clauses;
  if (clauses.length === 1 && first) return first;
  return { compound: { should: clauses, minimumShouldMatch: 1 } };
}

/** Tags are stored lowercased on ingest; filters must match that. */
function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags?.length) return [];
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))];
}

function buildDocumentMatch(tag: string | undefined): Filter<DocumentDoc> {
  const match: Filter<DocumentDoc> = {};
  if (tag) match.tags = tag.toLowerCase();
  return match;
}

/**
 * The browse `search` parameter as one `$search` stage.
 *
 * The contract is a case-insensitive substring match on title, sourceId and
 * uri. A `$regex` cannot deliver that on an index — case folding defeats
 * b-tree bounds even when anchored, and this match is unanchored — so it runs
 * as a Lucene `wildcard` against fields the keywordLowercase analyzer in
 * documents.text.json indexed as one lowercased term each. Wildcard queries
 * are never analyzed, so the query lowercases here to mirror that analyzer.
 */
function buildDocumentSearchStage(
  index: string,
  search: string,
  tag: string | undefined,
  sort: Document,
): Document {
  const wildcard = {
    query: `*${escapeWildcard(search.toLowerCase())}*`,
    path: ['title', 'sourceId', 'uri'],
    allowAnalyzedField: true,
  };

  return {
    $search: {
      index,
      ...(tag
        ? {
            compound: {
              must: [{ wildcard }],
              filter: [{ equals: { path: 'tags', value: tag.toLowerCase() } }],
            },
          }
        : { wildcard }),
      // The exact figure, not the default lowerBound estimate: `total` is a
      // pagination contract, and the non-search path counts exactly too.
      count: { type: 'total' },
      sort,
    },
  };
}

/** `*` and `?` are Lucene wildcard operators; a literal search must escape them. */
function escapeWildcard(value: string): string {
  return value.replace(/[*?\\]/gu, '\\$&');
}

function condenseExcerpt(excerpt: string): string {
  const collapsed = excerpt.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= EXCERPT_CHARS) return collapsed;
  return `${collapsed.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
}

/**
 * Codes MongoDB returns when a transaction is impossible rather than merely
 * failed: no replica set (20), an operation that cannot run in one (263), and
 * the two size ceilings (257, 10334).
 */
const TRANSACTION_UNAVAILABLE_CODES = new Set([20, 257, 263, 10334]);

function isTransactionUnavailable(error: unknown): boolean {
  if (error instanceof MongoServerError) {
    const code = typeof error.code === 'number' ? error.code : Number(error.code);
    if (TRANSACTION_UNAVAILABLE_CODES.has(code)) return true;
  }
  if (error instanceof Error && error.name === 'MongoCompatibilityError') return true;

  const message = error instanceof Error ? error.message : '';
  return (
    /transaction/iu.test(message) &&
    /(not supported|only allowed|unsupported|too large)/iu.test(message)
  );
}

/**
 * Did this aggregation fail because the search index is absent or still
 * building?
 *
 * Matched on the server's message rather than pre-flighting `listSearchIndexes`
 * on every query: that would add a round trip to the hot path to answer a
 * question that is almost always "yes, it is there".
 */
function isMissingSearchIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  // A server with no search support at all rejects the stage outright.
  if (/unrecognized pipeline stage name: '\$(search|vectorSearch)'/iu.test(message)) return true;

  return (
    /\bindex\b/iu.test(message) &&
    /(not found|does not exist|not queryable|is building|unknown index)/iu.test(message)
  );
}

function assertNotAborted(ctx: RequestContext): void {
  if (ctx.signal?.aborted === true) {
    throw new InternalError('Request was aborted before the operation completed', {
      details: { aborted: true },
      retryable: true,
    });
  }
}

/**
 * Run a database operation, converting anything the driver throws into a
 * `StorageError` so a raw `MongoServerError` can never reach a transport.
 *
 * `AppError`s pass through untouched: they were classified — and logged — where
 * they were raised, and re-logging them here would double every ingestion fault.
 */
async function guarded<T>(logger: Logger, operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAppError(error)) throw error;

    const wrapped = new StorageError(`MongoDB operation "${operation}" failed`, {
      cause: error,
      details: { operation },
      retryable: true,
    });
    logAppError(logger, wrapped);
    throw wrapped;
  }
}
