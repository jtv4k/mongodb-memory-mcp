/**
 * VoyageEmbeddingProvider unit tests.
 *
 * Every test injects a `vi.fn()` in place of `fetch`, so this file never touches
 * the network. The assertions that matter most are the boring-looking ones: the
 * exact request body (a wrong field name fails silently as "no results") and the
 * reordering of out-of-order response indices (which would otherwise attach the
 * wrong vector to the wrong chunk with no visible symptom).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { EmbeddingConfig } from '../../src/config/env.js';
import { ConfigError, EmbeddingError, ValidationError } from '../../src/errors.js';
import { createLogger } from '../../src/logger.js';
import { VoyageEmbeddingProvider } from '../../src/embeddings/voyage.js';

const API_KEY = 'voyage-secret-key-do-not-log';
const BASE_URL = 'https://api.voyageai.test/v1';
const DIMENSIONS = 4;

const logger = createLogger({ level: 'silent', pretty: false });

type ConfigOverrides = Partial<Omit<EmbeddingConfig, 'voyage'>> & {
  voyage?: Partial<EmbeddingConfig['voyage']>;
};

function makeConfig(overrides: ConfigOverrides = {}): EmbeddingConfig {
  const { voyage, ...rest } = overrides;
  return {
    provider: 'voyage',
    model: 'voyage-context-3',
    dimensions: DIMENSIONS,
    batchSize: 2,
    contextual: true,
    ...rest,
    voyage: {
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      timeoutMs: 5_000,
      maxRetries: 2,
      ...voyage,
    },
  };
}

/**
 * Minimal stand-in for `Response`. A real `Response` reads its body through a
 * stream, which does not settle predictably under fake timers; this settles on
 * the microtask queue so the retry tests are deterministic.
 */
function makeResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const stub = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    text: async (): Promise<string> => text,
  };
  // Only the four members above are ever touched by the provider.
  return stub as unknown as Response;
}

const vec = (seed: number, dimensions = DIMENSIONS): number[] =>
  Array.from({ length: dimensions }, (_, i) => seed + i / 100);

/** `groups[d][c]` is the vector to return for chunk `c` of document `d`. */
function contextualBody(groups: number[][][], totalTokens = 42): unknown {
  return {
    object: 'list',
    model: 'voyage-context-3',
    usage: { total_tokens: totalTokens },
    data: groups.map((vectors, index) => ({
      object: 'list',
      index,
      data: vectors.map((embedding, i) => ({ object: 'embedding', index: i, embedding })),
    })),
  };
}

function flatBody(vectors: number[][], totalTokens = 7): unknown {
  return {
    object: 'list',
    model: 'voyage-3.5',
    usage: { total_tokens: totalTokens },
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
  };
}

let fetchMock: Mock<typeof fetch>;

function callAt(index: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`expected a fetch call at index ${index}`);
  const [input, init] = call;
  if (!init) throw new Error('fetch was called without an init object');
  return { url: String(input), init };
}

function bodyAt(index: number): Record<string, unknown> {
  return JSON.parse(String(callAt(index).init.body)) as Record<string, unknown>;
}

function makeProvider(overrides: ConfigOverrides = {}): VoyageEmbeddingProvider {
  return new VoyageEmbeddingProvider(makeConfig(overrides), logger, fetchMock);
}

/** Flush pending microtasks without letting any timer fire. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Drive a retry loop to completion under fake timers. */
async function drainRetries(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(120_000);
  }
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('construction', () => {
  it('throws ConfigError when the API key is missing', () => {
    expect(() => makeProvider({ voyage: { apiKey: undefined } })).toThrow(ConfigError);
    expect(() => makeProvider({ voyage: { apiKey: '   ' } })).toThrow(/VOYAGE_API_KEY is required/);
  });

  it('reports provider info straight from config', () => {
    const provider = makeProvider({ model: 'voyage-3.5', contextual: false, batchSize: 5 });
    expect(provider.info).toEqual({
      provider: 'voyage',
      model: 'voyage-3.5',
      dimensions: DIMENSIONS,
      contextual: false,
      maxBatchSize: 5,
    });
  });

  it('close() is idempotent', async () => {
    const provider = makeProvider();
    await expect(provider.close()).resolves.toBeUndefined();
    await expect(provider.close()).resolves.toBeUndefined();
  });
});

describe('contextual document embedding', () => {
  it('sends the documented payload and returns vectors in input order', async () => {
    fetchMock.mockResolvedValue(makeResponse(contextualBody([[vec(1), vec(2)], [vec(3)]], 99)));

    const provider = makeProvider();
    const result = await provider.embedDocumentChunks([['alpha one', 'alpha two'], ['beta one']]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callAt(0).url).toBe(`${BASE_URL}/contextualizedembeddings`);
    expect(callAt(0).init.method).toBe('POST');
    expect(callAt(0).init.headers).toEqual({
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(bodyAt(0)).toEqual({
      inputs: [['alpha one', 'alpha two'], ['beta one']],
      model: 'voyage-context-3',
      input_type: 'document',
      output_dimension: DIMENSIONS,
      output_dtype: 'float',
    });

    expect(result.embeddings).toEqual([[vec(1), vec(2)], [vec(3)]]);
    expect(result.usage).toEqual({ totalTokens: 99, requests: 1 });
    expect(result.info).toBe(provider.info);
  });

  it('reorders out-of-order response indices at both nesting levels', async () => {
    // Documents come back 1 then 0, and document 0's chunks come back 1 then 0.
    fetchMock.mockResolvedValue(
      makeResponse({
        object: 'list',
        model: 'voyage-context-3',
        usage: { total_tokens: 10 },
        data: [
          { object: 'list', index: 1, data: [{ index: 0, embedding: vec(9) }] },
          {
            object: 'list',
            index: 0,
            data: [
              { index: 1, embedding: vec(2) },
              { index: 0, embedding: vec(1) },
            ],
          },
        ],
      }),
    );

    const result = await makeProvider().embedDocumentChunks([['a', 'b'], ['c']]);
    expect(result.embeddings).toEqual([[vec(1), vec(2)], [vec(9)]]);
  });

  it('batches to config.batchSize documents and preserves global ordering', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(contextualBody([[vec(1)], [vec(2)]], 5)))
      .mockResolvedValueOnce(makeResponse(contextualBody([[vec(3), vec(4)]], 6)));

    const provider = makeProvider({ batchSize: 2 });
    const result = await provider.embedDocumentChunks([['d0'], ['d1'], ['d2a', 'd2b']]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyAt(0)['inputs']).toEqual([['d0'], ['d1']]);
    expect(bodyAt(1)['inputs']).toEqual([['d2a', 'd2b']]);

    expect(result.embeddings).toEqual([[vec(1)], [vec(2)], [vec(3), vec(4)]]);
    expect(result.usage).toEqual({ totalTokens: 11, requests: 2 });
  });

  it('makes no HTTP call for an empty document list', async () => {
    const result = await makeProvider().embedDocumentChunks([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      embeddings: [],
      usage: { totalTokens: 0, requests: 0 },
      info: expect.objectContaining({ provider: 'voyage' }),
    });
  });

  it('rejects an empty chunk list or a blank chunk before calling out', async () => {
    const provider = makeProvider();
    await expect(provider.embedDocumentChunks([['ok'], []])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(provider.embedDocumentChunks([['ok', '   \n ']])).rejects.toThrow(
      /documents\[0\]\[1\] is empty/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('query embedding', () => {
  it('sends each query as its own single-chunk group and flattens the result', async () => {
    fetchMock.mockResolvedValue(makeResponse(contextualBody([[vec(1)], [vec(2)]], 4)));

    const result = await makeProvider().embedQueries(['first query', 'second query']);

    expect(bodyAt(0)).toEqual({
      inputs: [['first query'], ['second query']],
      model: 'voyage-context-3',
      input_type: 'query',
      output_dimension: DIMENSIONS,
      output_dtype: 'float',
    });
    expect(result.embeddings).toEqual([vec(1), vec(2)]);
  });

  it('rejects blank queries and never calls out for an empty list', async () => {
    const provider = makeProvider();
    await expect(provider.embedQueries([' '])).rejects.toBeInstanceOf(ValidationError);
    await expect(provider.embedQueries([])).resolves.toMatchObject({ embeddings: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('non-contextual models', () => {
  it('uses /embeddings with a flat input and re-splits by document', async () => {
    fetchMock.mockResolvedValue(makeResponse(flatBody([vec(1), vec(2), vec(3)], 12)));

    const provider = makeProvider({ contextual: false, model: 'voyage-3.5' });
    const result = await provider.embedDocumentChunks([['a', 'b'], ['c']]);

    expect(callAt(0).url).toBe(`${BASE_URL}/embeddings`);
    expect(bodyAt(0)).toEqual({
      input: ['a', 'b', 'c'],
      model: 'voyage-3.5',
      input_type: 'document',
      output_dimension: DIMENSIONS,
      output_dtype: 'float',
    });
    expect(result.embeddings).toEqual([[vec(1), vec(2)], [vec(3)]]);
    expect(result.usage).toEqual({ totalTokens: 12, requests: 1 });
  });

  it('reorders a flat response by its index field', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        object: 'list',
        model: 'voyage-3.5',
        usage: { total_tokens: 3 },
        data: [
          { index: 2, embedding: vec(3) },
          { index: 0, embedding: vec(1) },
          { index: 1, embedding: vec(2) },
        ],
      }),
    );

    const provider = makeProvider({ contextual: false, model: 'voyage-3.5', batchSize: 3 });
    const result = await provider.embedDocumentChunks([['a'], ['b'], ['c']]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.embeddings).toEqual([[vec(1)], [vec(2)], [vec(3)]]);
  });
});

describe('response validation', () => {
  it('rejects a vector whose length does not match the configured dimensions', async () => {
    fetchMock.mockResolvedValue(makeResponse(contextualBody([[[0.1, 0.2, 0.3]]])));

    await expect(makeProvider().embedDocumentChunks([['a']])).rejects.toThrow(
      /3-dimension vector .* expected 4/,
    );
  });

  it('rejects a non-finite component', async () => {
    fetchMock.mockResolvedValue(
      makeResponse('{"data":[{"index":0,"data":[{"index":0,"embedding":[1,2,null,4]}]}]}'),
    );

    await expect(makeProvider().embedDocumentChunks([['a']])).rejects.toThrow(/non-finite/);
  });

  it('rejects a body that is not JSON, without retrying it', async () => {
    fetchMock.mockResolvedValue(makeResponse('<html>gateway</html>'));

    await expect(makeProvider().embedDocumentChunks([['a']])).rejects.toThrow(/not valid JSON/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a response with no data array', async () => {
    fetchMock.mockResolvedValue(makeResponse({ object: 'list', usage: { total_tokens: 1 } }));

    await expect(makeProvider().embedDocumentChunks([['a']])).rejects.toThrow(/no `data` array/);
  });

  it('rejects a duplicated index rather than guessing', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        data: [
          {
            index: 0,
            data: [
              { index: 0, embedding: vec(1) },
              { index: 0, embedding: vec(2) },
            ],
          },
        ],
      }),
    );

    await expect(makeProvider().embedDocumentChunks([['a', 'b']])).rejects.toThrow(
      /repeated index 0/,
    );
  });

  it('rejects a group count that does not mirror the request', async () => {
    fetchMock.mockResolvedValue(makeResponse(contextualBody([[vec(1)]])));

    await expect(makeProvider().embedDocumentChunks([['a'], ['b']])).rejects.toThrow(
      /returned 1 document groups, expected 2/,
    );
  });

  it('always throws EmbeddingError, never a raw TypeError', async () => {
    fetchMock.mockResolvedValue(makeResponse({ data: 'nonsense' }));
    await expect(makeProvider().embedDocumentChunks([['a']])).rejects.toBeInstanceOf(
      EmbeddingError,
    );
  });
});

describe('retries', () => {
  it('retries a 429 and succeeds on the next attempt', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(makeResponse({ detail: 'rate limited' }, { status: 429 }))
      .mockResolvedValueOnce(makeResponse(contextualBody([[vec(1)]], 3)));

    const promise = makeProvider().embedQueries(['hello']);
    await drainRetries();

    await expect(promise).resolves.toMatchObject({
      embeddings: [vec(1)],
      usage: { totalTokens: 3, requests: 2 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits the Retry-After interval instead of the default backoff', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ detail: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } }),
      )
      .mockResolvedValueOnce(makeResponse(contextualBody([[vec(1)]])));

    const promise = makeProvider().embedQueries(['hello']);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Default backoff for attempt 1 is under 250ms, so a second call here would
    // mean Retry-After was ignored.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toMatchObject({ embeddings: [vec(1)] });
  });

  it('accepts an HTTP-date Retry-After', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    fetchMock
      .mockResolvedValueOnce(
        makeResponse('too many', {
          status: 429,
          headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:03 GMT' },
        }),
      )
      .mockResolvedValueOnce(makeResponse(contextualBody([[vec(1)]])));

    const promise = makeProvider().embedQueries(['hello']);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toMatchObject({ embeddings: [vec(1)] });
  });

  it('retries transport failures too', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(makeResponse(contextualBody([[vec(1)]])));

    const promise = makeProvider().embedQueries(['hello']);
    await drainRetries();

    await expect(promise).resolves.toMatchObject({ embeddings: [vec(1)] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries on 5xx and reports the attempt count', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse({ detail: 'upstream boom' }, { status: 503 }));

    const promise = makeProvider({ voyage: { maxRetries: 2 } }).embedQueries(['hello']);
    const caught = promise.catch((error: unknown) => error);
    await drainRetries();

    const error = await caught;
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((error as EmbeddingError).message).toContain('HTTP 503');
    expect((error as EmbeddingError).message).toContain('upstream boom');
    expect((error as EmbeddingError).details).toMatchObject({
      provider: 'voyage',
      model: 'voyage-context-3',
      status: 503,
      attempt: 3,
      maxAttempts: 3,
    });
  });

  it('does not retry a 400', async () => {
    fetchMock.mockResolvedValue(makeResponse({ detail: 'model not found' }, { status: 400 }));

    const error = await makeProvider()
      .embedQueries(['hello'])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as EmbeddingError).retryable).toBe(false);
    expect((error as EmbeddingError).details).toMatchObject({ status: 400, attempt: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops an oversized upstream error body instead of echoing it', async () => {
    fetchMock.mockResolvedValue(makeResponse('x'.repeat(5_000), { status: 400 }));

    const error = (await makeProvider()
      .embedQueries(['hello'])
      .catch((caught: unknown) => caught)) as EmbeddingError;

    expect(error.message).toBe('Voyage returned HTTP 400');
  });
});

describe('cancellation', () => {
  it('propagates the caller signal to fetch and aborts without retrying', async () => {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const controller = new AbortController();
    const promise = makeProvider().embedQueries(['hello'], { signal: controller.signal });
    await flushMicrotasks();
    controller.abort(new Error('client disconnected'));

    const error = (await promise.catch((caught: unknown) => caught)) as EmbeddingError;
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error.retryable).toBe(false);
    expect(error.details).toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      makeProvider().embedQueries(['hello'], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(EmbeddingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a pending backoff instead of sleeping it out', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      makeResponse('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    );

    const controller = new AbortController();
    const promise = makeProvider().embedQueries(['hello'], { signal: controller.signal });
    const caught = promise.catch((error: unknown) => error);

    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort(new Error('shutting down'));

    const error = (await caught) as EmbeddingError;
    expect(error).toBeInstanceOf(EmbeddingError);
    expect(error.details).toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('secret hygiene', () => {
  it('sends the key as a bearer token but never leaks it into an error', async () => {
    fetchMock.mockResolvedValue(makeResponse({ detail: `bad key ${API_KEY}` }, { status: 401 }));

    const error = (await makeProvider()
      .embedQueries(['hello'])
      .catch((caught: unknown) => caught)) as EmbeddingError;

    const headers = callAt(0).init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${API_KEY}`);

    // The upstream echoed the key back at us; our own error surface must not.
    expect(error.message).toContain('[redacted]');
    expect(JSON.stringify(error.details)).not.toContain(API_KEY);
    expect(JSON.stringify(error.toClientPayload())).not.toContain(API_KEY);
    expect(String(error.stack)).not.toContain(API_KEY);
  });

  it('never puts the request body in the error details', async () => {
    fetchMock.mockResolvedValue(makeResponse({ detail: 'nope' }, { status: 422 }));

    const error = (await makeProvider()
      .embedDocumentChunks([['a very distinctive chunk of text']])
      .catch((caught: unknown) => caught)) as EmbeddingError;

    expect(JSON.stringify(error.details)).not.toContain('distinctive');
  });
});
