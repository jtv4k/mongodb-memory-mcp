/**
 * The HTTP surface, end to end, with no database and no network.
 *
 * A real Express app is built by `createApp` and bound to port 0, then driven
 * with the global `fetch`. Everything below the transport is a hand-rolled
 * double: the `KnowledgeService` is a bag of `vi.fn()`s, the embedding provider
 * returns fixed vectors, and the "MongoDB connection" implements exactly the two
 * driver calls the readiness probe makes (`db.command` and
 * `collection.listSearchIndexes`). No supertest — the point is to exercise the
 * same socket path a client uses, including status codes, headers and the
 * rendered HTML.
 *
 * The app runs with NODE_ENV=production so the assertion that a 502 carries no
 * stack trace is testing the real production behaviour rather than a dev
 * shortcut.
 *
 * What is pinned here, and why each one is a rule someone could quietly break:
 *   - `/healthz` answers without credentials (Docker's HEALTHCHECK has none).
 *   - `/readyz` 503s when MongoDB is unreachable, but `/healthz` still 200s.
 *   - `/api/*` is authenticated for READS too, not just writes.
 *   - Invalid input never reaches the service.
 *   - Query strings are coerced to the types the zod schemas actually declare.
 *   - Errors keep their internals: no stack, no cause, in the body.
 *   - Ingested content is escaped on the rendered page.
 */
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppBundle } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import type { MongoConnection } from '../../src/db/client.js';
import type { EmbeddingProvider, EmbeddingProviderInfo } from '../../src/embeddings/provider.js';
import { EmbeddingError, SearchError } from '../../src/errors.js';
import { createLogger } from '../../src/logger.js';
import type { KnowledgeService } from '../../src/services/types.js';

// `testConfig` builds a NODE_ENV=production config, so this has to satisfy the
// production token rules in config/env.ts — hence a real-looking hex secret
// rather than a readable label.
const AUTH_TOKEN = '4d8f2b6a0c9e1537bd42a8f6c0e93b175a2d8f4c6b09e3a17d5f2b8c4a6e0d93';
const AUTH_HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const JSON_HEADERS = { ...AUTH_HEADERS, 'content-type': 'application/json' };

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

type FakeService = { [K in keyof KnowledgeService]: ReturnType<typeof vi.fn> };

/** Every method of the service contract, so a new method cannot be forgotten. */
function createFakeService(): FakeService {
  return {
    storeContent: vi.fn(),
    searchKnowledge: vi.fn(),
    listSources: vi.fn(),
    deleteContent: vi.fn(),
    listDocuments: vi.fn(),
    getDocument: vi.fn(),
    reembed: vi.fn(),
    embeddingCoverage: vi.fn(),
  };
}

const EMBEDDING_INFO: EmbeddingProviderInfo = {
  provider: 'fake',
  model: 'voyage-context-3',
  dimensions: 4,
  contextual: true,
  maxBatchSize: 8,
};

/**
 * Never actually called — the service is faked — but it is reported verbatim by
 * the health endpoints, so it returns real, correctly-shaped values rather than
 * throwing.
 */
const fakeEmbeddings: EmbeddingProvider = {
  info: EMBEDDING_INFO,
  embedDocumentChunks: async (documents) => ({
    embeddings: documents.map((chunks) => chunks.map(() => [0, 0, 0, 1])),
    usage: { totalTokens: 0, requests: 1 },
    info: EMBEDDING_INFO,
  }),
  embedQueries: async (queries) => ({
    embeddings: queries.map(() => [0, 0, 0, 1]),
    usage: { totalTokens: 0, requests: 1 },
    info: EMBEDDING_INFO,
  }),
  close: async () => undefined,
};

interface FakeMongoOptions {
  /** `db.command({ ping: 1 })` succeeds. */
  pingOk: boolean;
  /** `listSearchIndexes` reports the vector index as READY and queryable. */
  indexQueryable: boolean;
}

/**
 * The smallest object that satisfies the readiness probe.
 *
 * Cast rather than implemented: `Db` has hundreds of members and stubbing them
 * would say nothing about this code. The two methods below are the entire
 * surface `pingMongo` and `searchIndexIsQueryable` touch.
 */
function createFakeConnection(options: FakeMongoOptions): MongoConnection {
  const db = {
    command: async () => {
      if (!options.pingOk) throw new Error('no primary available');
      return { ok: 1 };
    },
    collection: () => ({
      listSearchIndexes: () => ({
        toArray: async () =>
          options.indexQueryable
            ? [
                {
                  name: 'chunks_vector_index',
                  type: 'vectorSearch',
                  status: 'READY',
                  queryable: true,
                },
              ]
            : [],
      }),
    }),
  };

  return { client: {}, db, close: async () => undefined } as unknown as MongoConnection;
}

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017/?directConnection=true',
    MONGODB_DB_NAME: 'rag_kb_http_test',
    MCP_AUTH_TOKEN: AUTH_TOKEN,
    EMBEDDING_PROVIDER: 'fake',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  baseUrl: string;
  server: Server;
  bundle: AppBundle;
  service: FakeService;
}

const harnesses: Harness[] = [];

async function startApp(
  options: { mongo?: Partial<FakeMongoOptions>; env?: Record<string, string> } = {},
): Promise<Harness> {
  const config = testConfig(options.env);
  const logger = createLogger(config.logging);
  const service = createFakeService();
  const connection = createFakeConnection({
    pingOk: options.mongo?.pingOk ?? true,
    indexQueryable: options.mongo?.indexQueryable ?? true,
  });

  const bundle = createApp({
    config,
    logger,
    connection,
    embeddings: fakeEmbeddings,
    service: service as unknown as KnowledgeService,
  });

  const server = bundle.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    bundle,
    service,
  };
  harnesses.push(harness);
  return harness;
}

/** Shared healthy instance; the unhealthy ones are created per test. */
const app = await startApp();

beforeEach(() => {
  for (const method of Object.values(app.service)) method.mockReset();
});

afterAll(async () => {
  for (const harness of harnesses) {
    await harness.bundle.shutdown();
    const closed = new Promise<void>((resolve, reject) => {
      harness.server.close((error) => (error ? reject(error) : resolve()));
    });
    // `fetch` keeps sockets alive, so `close()` alone would wait for their
    // timeout and hang the run.
    harness.server.closeAllConnections();
    await closed;
  }
});

/** First argument the fake service method was called with. */
function firstArgument(method: ReturnType<typeof vi.fn>): unknown {
  const call = method.mock.calls[0];
  if (!call) throw new Error('expected the service method to have been called');
  return call[0];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('health endpoints', () => {
  it('answers /healthz with 200 and no credentials', async () => {
    const response = await fetch(`${app.baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      embedding: { provider: 'fake', model: 'voyage-context-3', dimensions: 4 },
    });
  });

  it('answers /readyz with 200 when MongoDB and the vector index are both fine', async () => {
    const response = await fetch(`${app.baseUrl}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ready',
      checks: { mongo: { ok: true }, vectorIndex: { ok: true } },
    });
  });

  it('answers /readyz with 503 when the MongoDB ping fails, while /healthz stays 200', async () => {
    const broken = await startApp({ mongo: { pingOk: false, indexQueryable: false } });

    const ready = await fetch(`${broken.baseUrl}/readyz`);
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body).toMatchObject({
      status: 'not_ready',
      checks: { mongo: { ok: false }, vectorIndex: { ok: false } },
    });
    // The URI carries the password; the database name is the useful part.
    expect(JSON.stringify(body)).not.toContain('mongodb://');

    // Liveness must not follow readiness down, or Docker restarts the container
    // into the exact same broken world.
    const live = await fetch(`${broken.baseUrl}/healthz`);
    expect(live.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Request identity
// ---------------------------------------------------------------------------

describe('request ids', () => {
  it('echoes a well-formed inbound x-request-id', async () => {
    const response = await fetch(`${app.baseUrl}/healthz`, {
      headers: { 'x-request-id': 'trace-abc-123' },
    });

    expect(response.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('generates one when the client sends nothing', async () => {
    const response = await fetch(`${app.baseUrl}/healthz`);
    const id = response.headers.get('x-request-id');

    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('API authentication', () => {
  it('rejects an unauthenticated READ with 401', async () => {
    const response = await fetch(`${app.baseUrl}/api/search?q=anything`);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(app.service.searchKnowledge).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated write with 401', async () => {
    const response = await fetch(`${app.baseUrl}/api/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(response.status).toBe(401);
    expect(app.service.storeContent).not.toHaveBeenCalled();
  });

  it('rejects a wrong token with 401 and invalid_token', async () => {
    const response = await fetch(`${app.baseUrl}/api/sources`, {
      headers: { authorization: 'Bearer not-the-configured-token' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
  });
});

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

describe('POST /api/content', () => {
  it('validates, calls the service, and answers 201 for a new document', async () => {
    app.service.storeContent.mockResolvedValue({
      documentId: '65f0000000000000000000aa',
      sourceId: 'notes/hello',
      title: 'Hello',
      version: 1,
      chunkCount: 2,
      outcome: 'created',
      chunkingStrategy: 'markdown-structural',
      embedding: { provider: 'fake', model: 'voyage-context-3', dimensions: 4 },
      totalTokensEmbedded: 12,
      tookMs: 7,
    });

    const response = await fetch(`${app.baseUrl}/api/content`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: '# Hello\n\nsome content', tags: ['Notes', 'notes'] }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ outcome: 'created', chunkCount: 2 });
    expect(app.service.storeContent).toHaveBeenCalledTimes(1);
    expect(firstArgument(app.service.storeContent)).toMatchObject({
      content: '# Hello\n\nsome content',
      contentType: 'markdown',
      // Normalised by the schema: lowercased and deduplicated.
      tags: ['notes'],
    });
  });

  it('rejects an invalid body with 400 and never reaches the service', async () => {
    const response = await fetch(`${app.baseUrl}/api/content`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ content: '   ' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'E_VALIDATION' } });
    expect(app.service.storeContent).not.toHaveBeenCalled();
  });
});

describe('GET /api/search', () => {
  it('coerces query-string values into the types the schema declares', async () => {
    app.service.searchKnowledge.mockResolvedValue(searchResult());

    const response = await fetch(
      `${app.baseUrl}/api/search?q=vector%20index&limit=3&mode=vector&includeText=false&tags=alpha,beta`,
      { headers: AUTH_HEADERS },
    );

    expect(response.status).toBe(200);
    expect(firstArgument(app.service.searchKnowledge)).toEqual({
      query: 'vector index',
      limit: 3,
      mode: 'vector',
      includeText: false,
      filters: { tags: ['alpha', 'beta'] },
    });
  });

  it('rejects a non-numeric limit with 400 rather than guessing', async () => {
    const response = await fetch(`${app.baseUrl}/api/search?q=x&limit=lots`, {
      headers: AUTH_HEADERS,
    });

    expect(response.status).toBe(400);
    expect(app.service.searchKnowledge).not.toHaveBeenCalled();
  });

  it('maps an EmbeddingError to 502 and leaks no stack trace', async () => {
    app.service.searchKnowledge.mockRejectedValue(
      new EmbeddingError('voyage request timed out after 30000ms'),
    );

    const response = await fetch(`${app.baseUrl}/api/search?q=x`, { headers: AUTH_HEADERS });
    const body = (await response.json()) as { error: { code: string; stack?: string } };

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ error: { code: 'E_EMBEDDING', kind: 'embedding' } });
    expect(body.error.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});

describe('GET /api/documents/:id', () => {
  it('answers 404 when the service finds nothing', async () => {
    app.service.getDocument.mockResolvedValue(null);

    const response = await fetch(`${app.baseUrl}/api/documents/65f0000000000000000000aa`, {
      headers: AUTH_HEADERS,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'E_NOT_FOUND' } });
  });
});

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

describe('static assets', () => {
  it('never demands credentials for the stylesheet', async () => {
    const response = await fetch(`${app.baseUrl}/css/app.css`);

    // 200 once `npm run build:css` has run, 404 on a fresh clone (the file is
    // gitignored build output) — but never 401. A browser fetching a stylesheet
    // has no token, and the directory holds no ingested content to protect.
    expect([200, 404]).toContain(response.status);
  });
});

// ---------------------------------------------------------------------------
// Not-found handling
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('answers JSON under /api', async () => {
    const response = await fetch(`${app.baseUrl}/api/nope`, { headers: AUTH_HEADERS });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: { kind: 'not_found' } });
  });

  it('answers HTML everywhere else', async () => {
    const response = await fetch(`${app.baseUrl}/no-such-page`, {
      headers: { accept: 'text/html' },
    });
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('404');
  });
});

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------

describe('web UI', () => {
  it('redirects / to the search page', async () => {
    const response = await fetch(`${app.baseUrl}/`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/search');
  });

  it('renders the empty state without calling the service', async () => {
    const response = await fetch(`${app.baseUrl}/search`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Ask a question');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(app.service.searchKnowledge).not.toHaveBeenCalled();
  });

  it('escapes hostile ingested content instead of rendering it', async () => {
    app.service.searchKnowledge.mockResolvedValue(
      searchResult({
        query: 'alert',
        hits: [
          hit({
            title: '<img src=x onerror=alert(1)>',
            text: 'Before the alert <script>alert(1)</script> and after.',
            tags: ['<b>bold</b>'],
          }),
        ],
      }),
    );

    const response = await fetch(`${app.baseUrl}/search?q=alert`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    // The whole point: not one tag from the corpus survives as markup.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;script&gt;');

    // ...while the highlighter's own <mark> tags still come through.
    expect(html).toContain('<mark>alert</mark>');
  });

  it('surfaces a fallback from hybrid to vector-only', async () => {
    app.service.searchKnowledge.mockResolvedValue(
      searchResult({ query: 'chunking', mode: 'hybrid', effectiveMode: 'vector', hits: [hit()] }),
    );

    const html = await (await fetch(`${app.baseUrl}/search?q=chunking&mode=hybrid`)).text();

    expect(html).toContain('npm run db:indexes');
  });

  it('renders the search page with an error state when the service fails', async () => {
    app.service.searchKnowledge.mockRejectedValue(new EmbeddingError('provider unreachable'));

    const response = await fetch(`${app.baseUrl}/search?q=anything`);
    const html = await response.text();

    // The failure's status, but still a usable page rather than a dead end.
    expect(response.status).toBe(502);
    expect(html).toContain('Search failed');
    expect(html).toContain('E_EMBEDDING');
    expect(html).toContain('name="q"');
  });

  it('lists documents with working pagination links', async () => {
    app.service.listDocuments.mockResolvedValue({
      documents: [documentRow()],
      total: 45,
      limit: 20,
      offset: 20,
    });

    const html = await (await fetch(`${app.baseUrl}/documents?offset=20&tag=notes`)).text();

    expect(html).toContain('Release notes');
    expect(html).toContain('/documents?tag=notes&amp;offset=0');
    expect(html).toContain('/documents?tag=notes&amp;offset=40');
    expect(firstArgument(app.service.listDocuments)).toMatchObject({ offset: 20, tag: 'notes' });
  });

  it('renders a document with its chunks and embedding provenance', async () => {
    app.service.getDocument.mockResolvedValue(documentDetail());

    const html = await (await fetch(`${app.baseUrl}/documents/notes%2Frelease`)).text();

    expect(html).toContain('Release notes');
    expect(html).toContain('voyage-context-3');
    expect(html).toContain('chunk zero body');
    expect(app.service.getDocument).toHaveBeenCalledWith('notes/release', expect.anything());
  });

  it('renders the error page when a document does not exist', async () => {
    app.service.getDocument.mockResolvedValue(null);

    const response = await fetch(`${app.baseUrl}/documents/missing`, {
      headers: { accept: 'text/html' },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Not found');
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hit(overrides: Record<string, unknown> = {}) {
  return {
    chunkId: '65f0000000000000000000c1',
    documentId: '65f0000000000000000000aa',
    sourceId: 'notes/release',
    title: 'Release notes',
    uri: 'https://example.test/notes',
    contentType: 'markdown',
    chunkIndex: 0,
    headingPath: ['Release notes', 'Breaking changes'],
    tags: ['notes'],
    text: 'The chunker respects fenced code blocks and markdown headings.',
    score: 0.0312,
    vectorScore: 0.81,
    textScore: null,
    vectorRank: 1,
    textRank: null,
    highlights: [],
    ...overrides,
  };
}

function searchResult(overrides: Record<string, unknown> = {}) {
  return {
    query: 'chunking',
    mode: 'vector',
    effectiveMode: 'vector',
    totalHits: 1,
    hits: [hit()],
    tookMs: 12,
    embedding: { model: 'voyage-context-3', dimensions: 4 },
    ...overrides,
  };
}

function documentRow() {
  return {
    id: '65f0000000000000000000aa',
    sourceId: 'notes/release',
    title: 'Release notes',
    uri: 'https://example.test/notes',
    contentType: 'markdown',
    contentHash: 'a'.repeat(64),
    contentLength: 2048,
    tags: ['notes'],
    metadata: {},
    excerpt: 'The chunker respects fenced code blocks.',
    version: 3,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-02-03T04:05:06.000Z'),
    ingest: {
      at: new Date('2026-02-03T04:05:06.000Z'),
      channel: 'mcp',
      agent: 'claude-code',
      sessionId: 'sess-1',
      clientName: 'claude',
      clientVersion: '1.0.0',
    },
    chunking: {
      strategy: 'markdown-structural',
      chunkSizeTokens: 512,
      chunkOverlapTokens: 64,
      chunkCount: 2,
    },
    embedding: {
      provider: 'fake',
      model: 'voyage-context-3',
      dimensions: 4,
      contextual: true,
    },
  };
}

function documentDetail() {
  const { excerpt: _excerpt, ...document } = documentRow();

  return {
    document,
    chunks: [
      {
        id: '65f0000000000000000000c1',
        documentId: document.id,
        sourceId: document.sourceId,
        chunkIndex: 0,
        text: 'chunk zero body',
        charStart: 0,
        charEnd: 15,
        tokenCount: 4,
        headingPath: ['Release notes'],
        title: document.title,
        uri: document.uri,
        contentType: 'markdown',
        tags: document.tags,
        documentVersion: 3,
        documentContentHash: document.contentHash,
        embeddingProvider: 'fake',
        embeddingModel: 'voyage-context-3',
        embeddingDimensions: 4,
        embeddedAt: new Date('2026-02-03T04:05:06.000Z'),
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
        updatedAt: new Date('2026-02-03T04:05:06.000Z'),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Body parsing happens after authentication
// ---------------------------------------------------------------------------

/**
 * Its own app instance, deliberately.
 *
 * The auth middleware now throttles repeated failures per source IP, and the
 * counter lives inside one middleware instance. Sharing the module-level `app`
 * would make these tests spend the same budget as the 401 tests above — and
 * make either group's result depend on how many unauthenticated requests some
 * unrelated test happened to make first.
 */
const preAuthApp = await startApp();

describe('pre-auth body handling', () => {
  /**
   * `express.json()` used to be mounted globally, above every auth check, so an
   * unauthenticated client could make the process buffer and parse a body up to
   * the 12mb limit before the 401 was written.
   *
   * Malformed JSON is the cheap probe for the ordering: whichever middleware
   * runs first decides the status. 400 would mean body-parser still runs first.
   */
  it('refuses an unauthenticated POST to /api without parsing its body', async () => {
    const response = await fetch(`${preAuthApp.baseUrl}/api/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    });

    expect(response.status).toBe(401);
  });

  it('refuses an unauthenticated POST to /mcp without parsing its body', async () => {
    const response = await fetch(`${preAuthApp.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    });

    expect(response.status).toBe(401);
  });

  it('still reports malformed JSON to an authenticated caller', async () => {
    const response = await fetch(`${preAuthApp.baseUrl}/api/content`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{ this is not valid json',
    });

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Error payloads do not leak
// ---------------------------------------------------------------------------

describe('error payload hygiene', () => {
  it('replaces an unexpected error message with a generic one', async () => {
    app.service.listSources.mockRejectedValue(
      new Error('connection to mongodb://admin:hunter2@db.internal:27017 refused'),
    );

    const response = await fetch(`${app.baseUrl}/api/sources`, { headers: AUTH_HEADERS });
    const raw = await response.text();

    expect(response.status).toBe(500);
    // Neither the credential, nor the host, nor the original wording.
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('db.internal');
    expect(raw).not.toContain('refused');
    expect((JSON.parse(raw) as { error: { requestId: unknown } }).error.requestId).toEqual(
      expect.any(String),
    );
  });

  it('keeps a classified error message but scrubs credentials out of it', async () => {
    app.service.searchKnowledge.mockRejectedValue(
      new SearchError(
        'Vector search failed: no primary reachable at mongodb://admin:hunter2@db.internal:27017',
      ),
    );

    const response = await fetch(`${app.baseUrl}/api/search?q=x`, { headers: AUTH_HEADERS });
    const raw = await response.text();

    expect(response.status).toBe(503);
    // A `search` error is ours and is actionable, so the wording survives...
    expect(raw).toContain('Vector search failed');
    // ...but the connection string inside it does not.
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('db.internal');
  });

  it('does not include a stack trace in production', async () => {
    app.service.listSources.mockRejectedValue(new Error('boom'));

    const response = await fetch(`${app.baseUrl}/api/sources`, { headers: AUTH_HEADERS });
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(body.error['stack']).toBeUndefined();
  });
});
