/**
 * Domain + persistence types.
 *
 * Data-model note (spec requirement): chunks live in their OWN collection and
 * reference their parent via `documentId`. They are deliberately NOT an array
 * inside the parent document — a document can produce thousands of chunks, and
 * an unbounded array would blow the 16MB document limit and make vector
 * indexing impossible.
 *
 * Denormalisation note: each chunk carries a copy of its parent's `title`,
 * `uri`, `tags` and `contentType`. That is intentional. `$vectorSearch` can only
 * filter on fields indexed in the vector index itself, and search results need
 * source attribution without a `$lookup` per hit.
 */
import type { ObjectId } from 'mongodb';

export type ContentType = 'markdown' | 'text' | 'code' | 'html' | 'json';

export const CONTENT_TYPES = ['markdown', 'text', 'code', 'html', 'json'] as const;

/** Who sent us this content — an AI client, agent or human operator. */
export interface IngestActor {
  agent: string | null;
  sessionId: string | null;
  clientName: string | null;
  clientVersion: string | null;
}

export interface IngestInfo extends IngestActor {
  at: Date;
  /** 'mcp' | 'rest' | 'cli' — which surface accepted the content. */
  channel: string;
}

export interface DocumentChunkingInfo {
  strategy: string;
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
  chunkCount: number;
}

/** Which model produced this document's chunk vectors, so re-embedding is safe. */
export interface EmbeddingStamp {
  provider: string;
  model: string;
  dimensions: number;
  contextual: boolean;
}

// ---------------------------------------------------------------------------
// Collection: documents
// ---------------------------------------------------------------------------

export interface DocumentDoc {
  _id: ObjectId;
  /** Stable caller-facing identity. Unique; re-ingesting the same id versions it. */
  sourceId: string;
  title: string;
  uri: string | null;
  contentType: ContentType;
  /** The raw ingested content, verbatim. */
  content: string;
  /** sha256 of normalised content — powers idempotent re-ingest and staleness checks. */
  contentHash: string;
  contentLength: number;
  tags: string[];
  metadata: Record<string, unknown>;
  ingest: IngestInfo;
  chunking: DocumentChunkingInfo;
  embedding: EmbeddingStamp;
  /** Incremented each time the same `sourceId` is re-ingested with new content. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Collection: chunks
// ---------------------------------------------------------------------------

export interface ChunkDoc {
  _id: ObjectId;
  documentId: ObjectId;
  sourceId: string;
  /** 0-based position within the parent document. */
  chunkIndex: number;
  text: string;
  /** Character offsets into the parent's `content`, for exact provenance. */
  charStart: number;
  charEnd: number;
  tokenCount: number;
  /** Breadcrumb of enclosing markdown headings, outermost first. */
  headingPath: string[];

  // --- denormalised from the parent document (see module doc) ---
  title: string;
  uri: string | null;
  contentType: ContentType;
  tags: string[];
  documentVersion: number;
  documentContentHash: string;

  // --- the vector and its provenance (flattened so it is filterable) ---
  embedding: number[];
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

/** A chunk projected without its vector — what callers and the UI actually read. */
export type ChunkView = Omit<ChunkDoc, 'embedding'>;

// ---------------------------------------------------------------------------
// Chunker output (pure, storage-free)
// ---------------------------------------------------------------------------

/** One chunk as produced by the pure chunking module. No DB or vector concerns. */
export interface Chunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  headingPath: string[];
}

export interface ChunkingResult {
  chunks: Chunk[];
  /** Which splitter ran, e.g. 'markdown-structural' | 'code-block' | 'paragraph'. */
  strategy: string;
  stats: {
    inputChars: number;
    chunkCount: number;
    totalTokens: number;
    /** Chunks merged into a neighbour for being under the minimum size. */
    mergedUndersized: number;
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchMode = 'vector' | 'text' | 'hybrid';

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  uri: string | null;
  contentType: ContentType;
  chunkIndex: number;
  headingPath: string[];
  tags: string[];
  text: string;
  /** Final ranking score. For hybrid this is the fused (RRF) score. */
  score: number;
  /** Raw per-strategy scores/ranks — null when that strategy did not retrieve it. */
  vectorScore: number | null;
  textScore: number | null;
  vectorRank: number | null;
  textRank: number | null;
  /** Query-term fragments for UI highlighting. Empty when text search did not run. */
  highlights: string[];
}

export interface SearchKnowledgeResult {
  query: string;
  mode: SearchMode;
  /** The mode actually used — falls back to 'vector' if the text index is absent. */
  effectiveMode: SearchMode;
  totalHits: number;
  hits: SearchHit[];
  tookMs: number;
  embedding: { model: string; dimensions: number };
}

// ---------------------------------------------------------------------------
// Ingestion / management results
// ---------------------------------------------------------------------------

export interface StoreContentResult {
  documentId: string;
  sourceId: string;
  title: string;
  version: number;
  chunkCount: number;
  /** 'created' | 'updated' | 'unchanged' — 'unchanged' means the hash matched. */
  outcome: 'created' | 'updated' | 'unchanged';
  chunkingStrategy: string;
  embedding: { provider: string; model: string; dimensions: number };
  totalTokensEmbedded: number;
  tookMs: number;
}

export interface SourceSummary {
  sourceId: string;
  title: string;
  uri: string | null;
  contentType: ContentType;
  tags: string[];
  chunkCount: number;
  contentLength: number;
  version: number;
  /** Distinct embedding models across this source's chunks — >1 means mid-backfill. */
  embeddingModels: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ListSourcesResult {
  sources: SourceSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeleteContentResult {
  deletedDocuments: number;
  deletedChunks: number;
  sourceIds: string[];
}

export interface DocumentDetail {
  document: Omit<DocumentDoc, '_id'> & { id: string };
  chunks: Array<Omit<ChunkView, '_id' | 'documentId'> & { id: string; documentId: string }>;
}

export interface ListDocumentsResult {
  documents: Array<Omit<DocumentDoc, '_id' | 'content'> & { id: string; excerpt: string }>;
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Re-embedding / backfill
// ---------------------------------------------------------------------------

export interface ReembedResult {
  /** Chunks whose embeddingModel/dimensions did not match the target. */
  staleChunks: number;
  documentsProcessed: number;
  chunksReembedded: number;
  chunksFailed: number;
  targetModel: string;
  targetDimensions: number;
  dryRun: boolean;
  totalTokensEmbedded: number;
  tookMs: number;
}

export interface EmbeddingCoverage {
  model: string;
  dimensions: number;
  provider: string;
  chunkCount: number;
  documentCount: number;
}
