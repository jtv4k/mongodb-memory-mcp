/**
 * Service-layer contract.
 *
 * `KnowledgeService` is the single seam between transports (MCP tools, REST
 * routes, EJS pages, CLI) and the ingestion/search implementation. Transports
 * hold NO business logic: they validate input with `domain/schemas.ts`, call a
 * method here, and shape the result for their wire format.
 */
import type { Db } from 'mongodb';

import type { AppConfig } from '../config/env.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type {
  DeleteContentInput,
  ListDocumentsInput,
  ListSourcesInput,
  ReembedInput,
  SearchKnowledgeInput,
  StoreContentInput,
} from '../domain/schemas.js';
import type {
  DeleteContentResult,
  DocumentDetail,
  EmbeddingCoverage,
  ListDocumentsResult,
  ListSourcesResult,
  ReembedResult,
  SearchKnowledgeResult,
  StoreContentResult,
} from '../domain/types.js';
import type { Logger } from '../logger.js';

/** Which surface a call arrived on, plus correlation ids for logging. */
export interface RequestContext {
  channel: 'mcp' | 'rest' | 'web' | 'cli';
  requestId: string;
  logger: Logger;
  /** MCP client name/version when known, for ingest attribution. */
  clientName?: string;
  clientVersion?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface KnowledgeServiceDeps {
  db: Db;
  embeddings: EmbeddingProvider;
  config: AppConfig;
  logger: Logger;
}

export interface KnowledgeService {
  /** Chunk → embed → persist. Idempotent: an unchanged content hash is a no-op. */
  storeContent(input: StoreContentInput, ctx: RequestContext): Promise<StoreContentResult>;

  /** Vector, text, or RRF-fused hybrid search over chunks. */
  searchKnowledge(input: SearchKnowledgeInput, ctx: RequestContext): Promise<SearchKnowledgeResult>;

  listSources(input: ListSourcesInput, ctx: RequestContext): Promise<ListSourcesResult>;

  /** Deletes a document and every chunk that references it. */
  deleteContent(input: DeleteContentInput, ctx: RequestContext): Promise<DeleteContentResult>;

  /** Browse view for the web UI. Excludes full content; returns an excerpt. */
  listDocuments(input: ListDocumentsInput, ctx: RequestContext): Promise<ListDocumentsResult>;

  /** Single document plus its chunks (vectors excluded). Null when absent. */
  getDocument(idOrSourceId: string, ctx: RequestContext): Promise<DocumentDetail | null>;

  /** Re-embed chunks whose vector was produced by a different model/dimension. */
  reembed(input: ReembedInput, ctx: RequestContext): Promise<ReembedResult>;

  /** Which embedding models are present in the corpus, and how much of it. */
  embeddingCoverage(ctx: RequestContext): Promise<EmbeddingCoverage[]>;
}
