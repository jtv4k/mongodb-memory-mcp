/**
 * Voyage AI embedding provider.
 *
 * ## Two endpoints behind one interface
 *
 * The configured default, `voyage-context-3`, is a *contextualised* model served
 * from `POST /contextualizedembeddings`, whose payload is `inputs: string[][]` —
 * chunks grouped by parent document — and whose response is a nested list of
 * lists. Every other Voyage model is served from `POST /embeddings` with a flat
 * `input: string[]`. Both shapes are verified against the Voyage API reference.
 *
 * Ingestion must not care which one is in play, so the branch lives here and
 * nowhere else: the flat branch flattens the groups on the way out and re-splits
 * on the way back, which keeps `DocumentEmbeddingResult.embeddings` shaped like
 * the input regardless of model.
 *
 * ## Why the response is re-ordered rather than trusted
 *
 * Voyage returns an explicit `index` on every entry and does not promise request
 * order. We rebuild the result from those indices and reject a missing, repeated
 * or out-of-range one. Silently trusting array position would attach the wrong
 * vector to the wrong chunk — a corruption that no test downstream would notice,
 * because every vector is individually plausible.
 *
 * For the same reason every vector is length-checked against `info.dimensions`:
 * a short vector is not a query-time error, it is a document that is silently
 * missing from the MongoDB Vector Search index forever.
 */
import type { EmbeddingConfig } from '../config/env.js';
import { ConfigError, describeError, EmbeddingError, ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import {
  batchDocuments,
  type DocumentEmbeddingResult,
  type EmbedOptions,
  type EmbeddingInputType,
  type EmbeddingProvider,
  type EmbeddingProviderInfo,
  type EmbeddingUsage,
  type QueryEmbeddingResult,
} from './provider.js';

/** Contextualised models: chunks arrive grouped by parent document. */
const CONTEXTUAL_PATH = '/contextualizedembeddings';
/** Every other model: a flat list of strings. */
const FLAT_PATH = '/embeddings';

const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8_000;
/** Cap on how long upstream may make us wait via `Retry-After`. */
const MAX_RETRY_AFTER_MS = 60_000;
/** Upstream error text is echoed into our error only when it is this small. */
const MAX_ECHOED_BODY_CHARS = 512;

/** Outcome of one HTTP attempt: either a parsed body, or a classified failure. */
type AttemptOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: EmbeddingError; retryAfterMs: number | undefined };

/** One upstream call plus the bookkeeping the caller needs for logs and usage. */
interface CallResult {
  embeddings: number[][][];
  tokens: number;
  /** Actual HTTP requests, so a retried batch is honestly reported as two. */
  requests: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Missing usage is not worth failing an otherwise good response over. */
function readTotalTokens(payload: unknown): number {
  const tokens = asRecord(asRecord(payload)?.['usage'])?.['total_tokens'];
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
}

function truncate(text: string): string {
  return text.length <= MAX_ECHOED_BODY_CHARS ? text : `${text.slice(0, MAX_ECHOED_BODY_CHARS)}…`;
}

/**
 * Pull a human-useful message out of an error body. Voyage uses `{ "detail": … }`.
 * Large bodies are dropped entirely rather than truncated blindly: an HTML error
 * page from an intermediary is noise, and we would rather log nothing than 4 KB
 * of markup on every rate limit.
 */
function summariseErrorBody(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  try {
    const record = asRecord(JSON.parse(trimmed));
    for (const key of ['detail', 'error', 'message']) {
      const value = record?.[key];
      if (typeof value === 'string' && value.length > 0) return truncate(value);
    }
  } catch {
    // Not JSON. Fall through and consider the raw text instead.
  }

  return trimmed.length <= MAX_ECHOED_BODY_CHARS ? trimmed : undefined;
}

/** `Retry-After` is either delta-seconds or an HTTP-date; RFC 9110 allows both. */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  const trimmed = header?.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
  }

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.min(Math.max(when - now, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Exponential backoff with "half jitter": the delay is uniform in
 * `[ceiling/2, ceiling)`. Full jitter can collapse to ~0ms and hammer an
 * already-struggling upstream; no jitter synchronises concurrent ingests.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: EmbeddingConfig, logger: Logger, fetchImpl: typeof fetch = fetch) {
    const apiKey = cfg.voyage.apiKey?.trim();
    if (!apiKey) {
      throw new ConfigError('VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage', {
        model: cfg.model,
      });
    }

    this.apiKey = apiKey;
    this.baseUrl = cfg.voyage.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = cfg.voyage.timeoutMs;
    this.maxRetries = cfg.voyage.maxRetries;
    this.logger = logger;
    this.fetchImpl = fetchImpl;

    this.info = {
      provider: 'voyage',
      model: cfg.model,
      dimensions: cfg.dimensions,
      contextual: cfg.contextual,
      maxBatchSize: cfg.batchSize,
    };
  }

  async embedDocumentChunks(
    documents: readonly (readonly string[])[],
    options: EmbedOptions = {},
  ): Promise<DocumentEmbeddingResult> {
    // Nothing to embed is a legitimate no-op (e.g. a re-embed run with no stale
    // documents left), not an error — and it must not cost an HTTP request.
    if (documents.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0, requests: 0 }, info: this.info };
    }

    documents.forEach((chunks, d) => {
      if (chunks.length === 0) {
        throw new ValidationError(`documents[${d}] has no chunks to embed`);
      }
      chunks.forEach((chunk, c) => {
        if (chunk.trim().length === 0) {
          throw new ValidationError(`documents[${d}][${c}] is empty or whitespace only`);
        }
      });
    });

    const { embeddings, usage } = await this.embedGroups(documents, 'document', options);
    return { embeddings, usage, info: this.info };
  }

  async embedQueries(
    queries: readonly string[],
    options: EmbedOptions = {},
  ): Promise<QueryEmbeddingResult> {
    if (queries.length === 0) {
      return { embeddings: [], usage: { totalTokens: 0, requests: 0 }, info: this.info };
    }

    queries.forEach((query, q) => {
      if (query.trim().length === 0) {
        throw new ValidationError(`queries[${q}] is empty or whitespace only`);
      }
    });

    // A query has no siblings to be conditioned on, so each one is its own
    // single-chunk group. That is also what Voyage's own guidance says to send
    // to the contextual endpoint for query-side embeddings.
    const groups = queries.map((query) => [query]);
    const { embeddings, usage } = await this.embedGroups(groups, 'query', options);

    const flattened = embeddings.map((group, q) => {
      const vector = group[0];
      if (!vector) {
        throw this.failure(`Voyage returned no embedding for queries[${q}]`, {
          attempt: usage.requests,
          retryable: false,
        });
      }
      return vector;
    });

    return { embeddings: flattened, usage, info: this.info };
  }

  /**
   * Nothing is pooled — `fetch` uses the global agent — so this is a no-op and
   * therefore trivially idempotent.
   */
  async close(): Promise<void> {
    return;
  }

  private async embedGroups(
    groups: readonly (readonly string[])[],
    inputType: EmbeddingInputType,
    options: EmbedOptions,
  ): Promise<{ embeddings: number[][][]; usage: EmbeddingUsage }> {
    const batches = batchDocuments(groups, this.info.maxBatchSize);

    const embeddings: number[][][] = [];
    let totalTokens = 0;
    let requests = 0;

    // Sequential on purpose. Batches must land in input order, and firing them
    // in parallel would multiply our share of a shared account rate limit for
    // no latency win that matters during ingestion.
    for (const batch of batches) {
      const result = this.info.contextual
        ? await this.callContextual(batch, inputType, options)
        : await this.callFlat(batch, inputType, options);
      embeddings.push(...result.embeddings);
      totalTokens += result.tokens;
      requests += result.requests;
    }

    return { embeddings, usage: { totalTokens, requests } };
  }

  private async callContextual(
    batch: readonly (readonly string[])[],
    inputType: EmbeddingInputType,
    options: EmbedOptions,
  ): Promise<CallResult> {
    const body = {
      inputs: batch.map((group) => [...group]),
      model: this.info.model,
      input_type: inputType,
      // Always pinned: the MongoDB Vector Search index declares a fixed `numDimensions`,
      // so letting the model pick would be a silent index mismatch.
      output_dimension: this.info.dimensions,
      output_dtype: 'float',
    };

    const { payload, attempts, durationMs } = await this.post(CONTEXTUAL_PATH, body, options);
    const embeddings = this.readContextual(payload, batch, attempts);
    const tokens = readTotalTokens(payload);

    this.logRequest(CONTEXTUAL_PATH, inputType, batch, attempts, tokens, durationMs);
    return { embeddings, tokens, requests: attempts };
  }

  /**
   * Non-contextual branch. Deliberately thin: it flattens, calls the ordinary
   * endpoint, and re-splits on the original group boundaries. Everything else —
   * batching, retries, validation — is shared, so swapping `voyage-context-3`
   * for `voyage-3.5` is a config change and nothing more.
   */
  private async callFlat(
    batch: readonly (readonly string[])[],
    inputType: EmbeddingInputType,
    options: EmbedOptions,
  ): Promise<CallResult> {
    const flat = batch.flat();
    const body = {
      input: flat,
      model: this.info.model,
      input_type: inputType,
      output_dimension: this.info.dimensions,
      output_dtype: 'float',
    };

    const { payload, attempts, durationMs } = await this.post(FLAT_PATH, body, options);
    const vectors = this.readVectorList(asRecord(payload)?.['data'], flat.length, 'data', attempts);

    const embeddings: number[][][] = [];
    let cursor = 0;
    for (const group of batch) {
      embeddings.push(vectors.slice(cursor, cursor + group.length));
      cursor += group.length;
    }

    const tokens = readTotalTokens(payload);
    this.logRequest(FLAT_PATH, inputType, batch, attempts, tokens, durationMs);
    return { embeddings, tokens, requests: attempts };
  }

  private logRequest(
    endpoint: string,
    inputType: EmbeddingInputType,
    batch: readonly (readonly string[])[],
    attempts: number,
    tokens: number,
    durationMs: number,
  ): void {
    this.logger.debug(
      {
        event: 'embedding.request',
        provider: this.info.provider,
        model: this.info.model,
        endpoint,
        inputType,
        documents: batch.length,
        chunks: batch.reduce((total, group) => total + group.length, 0),
        attempts,
        totalTokens: tokens,
        durationMs,
      },
      'voyage embedding request completed',
    );
  }

  /** POST with per-attempt timeout, caller cancellation and bounded retries. */
  private async post(
    path: string,
    body: Record<string, unknown>,
    options: EmbedOptions,
  ): Promise<{ payload: unknown; attempts: number; durationMs: number }> {
    const url = `${this.baseUrl}${path}`;
    const serialised = JSON.stringify(body);
    const maxAttempts = this.maxRetries + 1;
    const started = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.throwIfCallerAborted(options.signal, attempt);

      const outcome = await this.attempt(url, serialised, options.signal, attempt, maxAttempts);
      if (outcome.ok) {
        return { payload: outcome.payload, attempts: attempt, durationMs: Date.now() - started };
      }

      // `retryable` is set by `attempt`: 429 and 5xx and transport faults yes,
      // every other 4xx no — retrying a 400 just burns the same error again.
      if (!outcome.error.retryable || attempt === maxAttempts) throw outcome.error;

      await this.sleep(outcome.retryAfterMs ?? backoffDelay(attempt), options.signal, attempt);
    }

    // Unreachable: maxAttempts >= 1, so the loop always returns or throws.
    throw this.failure('Voyage request exhausted every attempt', {
      attempt: maxAttempts,
      maxAttempts,
      retryable: true,
    });
  }

  private async attempt(
    url: string,
    body: string,
    callerSignal: AbortSignal | undefined,
    attempt: number,
    maxAttempts: number,
  ): Promise<AttemptOutcome> {
    // `AbortSignal.timeout` uses an unref'd timer, so an abandoned attempt can
    // never hold the process open; `any` gives us one signal to hand to fetch.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;

    let response: Response;
    try {
      // Read off `this` first: some fetch implementations reject a bound receiver.
      const send = this.fetchImpl;
      response = await send(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal,
      });
    } catch (cause) {
      if (callerSignal?.aborted) throw this.aborted(attempt, callerSignal.reason);
      const timedOut = timeout.aborted;
      return {
        ok: false,
        retryAfterMs: undefined,
        error: this.failure(
          timedOut
            ? `Voyage request timed out after ${this.timeoutMs}ms`
            : `Voyage request failed: ${describeError(cause)}`,
          { attempt, maxAttempts, retryable: true, cause, extra: { timedOut } },
        ),
      };
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (cause) {
      if (callerSignal?.aborted) throw this.aborted(attempt, callerSignal.reason);
      return {
        ok: false,
        retryAfterMs: undefined,
        error: this.failure(`Voyage response body could not be read: ${describeError(cause)}`, {
          attempt,
          maxAttempts,
          status: response.status,
          retryable: true,
          cause,
        }),
      };
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const detail = this.redact(summariseErrorBody(raw));
      return {
        ok: false,
        retryAfterMs: retryable
          ? parseRetryAfter(response.headers.get('retry-after'), Date.now())
          : undefined,
        error: this.failure(
          `Voyage returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          { attempt, maxAttempts, status: response.status, retryable },
        ),
      };
    }

    try {
      return { ok: true, payload: JSON.parse(raw) };
    } catch (cause) {
      // A 2xx whose body is not JSON is a broken contract, not a blip, so this
      // is not retried — burning three more requests would not fix it.
      return {
        ok: false,
        retryAfterMs: undefined,
        error: this.failure('Voyage returned a 2xx response that is not valid JSON', {
          attempt,
          maxAttempts,
          status: response.status,
          retryable: false,
          cause,
        }),
      };
    }
  }

  /** Sleep that wakes early — and rejects — if the caller cancels mid-backoff. */
  private sleep(ms: number, signal: AbortSignal | undefined, attempt: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(this.aborted(attempt, signal.reason));
        return;
      }

      const onAbort = (): void => {
        clearTimeout(timer);
        reject(this.aborted(attempt, signal?.reason));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private readContextual(
    payload: unknown,
    batch: readonly (readonly string[])[],
    attempts: number,
  ): number[][][] {
    const outer = asRecord(payload)?.['data'];
    if (!Array.isArray(outer)) {
      throw this.failure('Voyage response has no `data` array', {
        attempt: attempts,
        retryable: false,
      });
    }
    if (outer.length !== batch.length) {
      throw this.failure(
        `Voyage returned ${outer.length} document groups, expected ${batch.length}`,
        { attempt: attempts, retryable: false },
      );
    }

    const slots = new Array<number[][] | undefined>(batch.length).fill(undefined);
    for (const item of outer) {
      const entry = asRecord(item);
      if (!entry) {
        throw this.failure('Voyage response `data` contains a non-object entry', {
          attempt: attempts,
          retryable: false,
        });
      }

      const index = this.readSlotIndex(entry, batch.length, 'data', attempts);
      if (slots[index] !== undefined) {
        throw this.failure(`Voyage response repeated document index ${index}`, {
          attempt: attempts,
          retryable: false,
        });
      }

      const group = batch[index];
      if (!group) {
        throw this.failure(`Voyage response references unknown document index ${index}`, {
          attempt: attempts,
          retryable: false,
        });
      }

      slots[index] = this.readVectorList(
        entry['data'],
        group.length,
        `data[${index}].data`,
        attempts,
      );
    }

    return slots.map((vectors, index) => {
      if (!vectors) {
        throw this.failure(`Voyage response is missing document index ${index}`, {
          attempt: attempts,
          retryable: false,
        });
      }
      return vectors;
    });
  }

  /** Rebuild an ordered vector list from entries that carry their own `index`. */
  private readVectorList(
    raw: unknown,
    expected: number,
    where: string,
    attempts: number,
  ): number[][] {
    if (!Array.isArray(raw)) {
      throw this.failure(`Voyage response \`${where}\` is not an array`, {
        attempt: attempts,
        retryable: false,
      });
    }
    if (raw.length !== expected) {
      throw this.failure(
        `Voyage response \`${where}\` has ${raw.length} embeddings, expected ${expected}`,
        { attempt: attempts, retryable: false },
      );
    }

    const slots = new Array<number[] | undefined>(expected).fill(undefined);
    for (const item of raw) {
      const entry = asRecord(item);
      if (!entry) {
        throw this.failure(`Voyage response \`${where}\` contains a non-object entry`, {
          attempt: attempts,
          retryable: false,
        });
      }

      const index = this.readSlotIndex(entry, expected, where, attempts);
      if (slots[index] !== undefined) {
        throw this.failure(`Voyage response \`${where}\` repeated index ${index}`, {
          attempt: attempts,
          retryable: false,
        });
      }

      slots[index] = this.readVector(entry['embedding'], `${where}[${index}]`, attempts);
    }

    return slots.map((vector, index) => {
      if (!vector) {
        throw this.failure(`Voyage response \`${where}\` is missing index ${index}`, {
          attempt: attempts,
          retryable: false,
        });
      }
      return vector;
    });
  }

  private readSlotIndex(
    entry: Record<string, unknown>,
    expected: number,
    where: string,
    attempts: number,
  ): number {
    const index = entry['index'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expected) {
      throw this.failure(
        `Voyage response \`${where}\` has an out-of-range index ${describeError(index)}`,
        { attempt: attempts, retryable: false },
      );
    }
    return index;
  }

  private readVector(raw: unknown, where: string, attempts: number): number[] {
    if (!Array.isArray(raw)) {
      throw this.failure(`Voyage response \`${where}\` has no embedding array`, {
        attempt: attempts,
        retryable: false,
      });
    }
    if (raw.length !== this.info.dimensions) {
      throw this.failure(
        `Voyage returned a ${raw.length}-dimension vector at \`${where}\`, expected ${this.info.dimensions}`,
        { attempt: attempts, retryable: false, extra: { dimensions: this.info.dimensions } },
      );
    }

    const vector = new Array<number>(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      const value: unknown = raw[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw this.failure(`Voyage returned a non-finite value at \`${where}[${i}]\``, {
          attempt: attempts,
          retryable: false,
        });
      }
      vector[i] = value;
    }
    return vector;
  }

  /**
   * Scrub the key out of anything we echo back.
   *
   * A 401 body from Voyage is harmless, but an authenticating proxy in front of
   * it can and does quote the offending `Authorization` header verbatim. Since
   * this text lands in logs and in the MCP client payload, it gets redacted at
   * the boundary rather than trusted.
   */
  private redact(text: string | undefined): string | undefined {
    return text?.split(this.apiKey).join('[redacted]');
  }

  private throwIfCallerAborted(signal: AbortSignal | undefined, attempt: number): void {
    if (signal?.aborted) throw this.aborted(attempt, signal.reason);
  }

  private aborted(attempt: number, reason: unknown): EmbeddingError {
    return new EmbeddingError('Voyage request aborted by the caller', {
      retryable: false,
      cause: reason,
      details: { provider: this.info.provider, model: this.info.model, attempt, aborted: true },
    });
  }

  /**
   * Every failure leaves this module as an {@link EmbeddingError}. `details`
   * carries status, attempt count and model and *never* the API key or the
   * request body — those would end up in logs and in MCP client payloads.
   */
  private failure(
    message: string,
    opts: {
      attempt: number;
      retryable: boolean;
      maxAttempts?: number;
      status?: number;
      cause?: unknown;
      extra?: Record<string, unknown>;
    },
  ): EmbeddingError {
    return new EmbeddingError(message, {
      retryable: opts.retryable,
      cause: opts.cause,
      details: {
        provider: this.info.provider,
        model: this.info.model,
        attempt: opts.attempt,
        ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
        ...(opts.status === undefined ? {} : { status: opts.status }),
        ...opts.extra,
      },
    });
  }
}
