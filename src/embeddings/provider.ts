/**
 * Embedding provider interface.
 *
 * Only Voyage ships today, but ingestion and search must never import a Voyage
 * type. Everything behind this interface can be swapped — model, dimensions, or
 * the whole vendor — and the only code that changes is a provider module plus a
 * re-embedding run.
 *
 * ## Why documents-of-chunks and not a flat list of strings
 *
 * The configured default is `voyage-context-3`, a *contextualised* embedding
 * model: it embeds each chunk conditioned on the sibling chunks of the same
 * document, so a chunk that says "it returns null in that case" still lands near
 * the function it is talking about. That requires the provider to receive chunks
 * grouped by parent document, in order.
 *
 * A non-contextual provider satisfies the same interface by ignoring the
 * grouping and embedding each string independently — callers are unaffected.
 */

/** Voyage distinguishes document-side and query-side embeddings; both are asymmetric. */
export type EmbeddingInputType = 'document' | 'query';

export interface EmbeddingProviderInfo {
  /** Vendor slug, e.g. 'voyage' | 'fake'. Persisted on every chunk. */
  provider: string;
  /** Model identifier, e.g. 'voyage-context-3'. Persisted on every chunk. */
  model: string;
  /** Vector length. MUST equal the `numDimensions` of the Atlas vector index. */
  dimensions: number;
  /** True when chunk vectors are conditioned on their sibling chunks. */
  contextual: boolean;
  /** Max documents per upstream request; callers batch to this. */
  maxBatchSize: number;
}

export interface EmbeddingUsage {
  /** Tokens billed by the provider. 0 for providers that do not report usage. */
  totalTokens: number;
  /** Upstream HTTP requests made (batching means this is >= 1). */
  requests: number;
}

/** Result of embedding chunks grouped by parent document. */
export interface DocumentEmbeddingResult {
  /**
   * `embeddings[d][c]` is the vector for chunk `c` of input document `d`.
   * Shape is guaranteed to mirror the input exactly — same outer length, same
   * inner lengths — or the provider throws {@link EmbeddingError}.
   */
  embeddings: number[][][];
  usage: EmbeddingUsage;
  info: EmbeddingProviderInfo;
}

/** Result of embedding query strings. `embeddings[q]` matches `queries[q]`. */
export interface QueryEmbeddingResult {
  embeddings: number[][];
  usage: EmbeddingUsage;
  info: EmbeddingProviderInfo;
}

export interface EmbedOptions {
  /** Abort in-flight HTTP requests (request cancellation, shutdown). */
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  /**
   * Embed the ordered chunks of one or more documents with `input_type=document`.
   *
   * @param documents `documents[d][c]` is chunk `c` of document `d`. Order is
   *   significant for contextual models. Empty inner arrays are rejected.
   * @throws {EmbeddingError} on transport failure, rate limiting after retries,
   *   an unexpected response shape, or a dimension mismatch against `info`.
   */
  embedDocumentChunks(
    documents: readonly (readonly string[])[],
    options?: EmbedOptions,
  ): Promise<DocumentEmbeddingResult>;

  /** Embed search queries with `input_type=query`. */
  embedQueries(queries: readonly string[], options?: EmbedOptions): Promise<QueryEmbeddingResult>;

  /** Release any pooled resources. Safe to call more than once. */
  close(): Promise<void>;
}

/** Convenience wrapper for the common single-query case. */
export async function embedQuery(
  provider: EmbeddingProvider,
  query: string,
  options?: EmbedOptions,
): Promise<number[]> {
  const result = await provider.embedQueries([query], options);
  const vector = result.embeddings[0];
  if (!vector) {
    throw new Error(`${provider.info.provider} returned no embedding for the query`);
  }
  return vector;
}

/** Split documents into provider-sized batches, preserving order. */
export function batchDocuments<T>(documents: readonly T[], batchSize: number): T[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: T[][] = [];
  for (let i = 0; i < documents.length; i += size) {
    batches.push(documents.slice(i, i + size) as T[]);
  }
  return batches;
}
