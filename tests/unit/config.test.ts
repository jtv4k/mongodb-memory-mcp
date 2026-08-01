/**
 * Environment validation.
 *
 * Config is the one thing that is allowed to crash the process, so these tests
 * care as much about the *error* as the happy path: a misconfigured deployment
 * must be told about every bad variable in one go, not made to fix them one
 * restart at a time.
 *
 * Every env record here is built inline. Nothing in this file reads process.env,
 * so the suite behaves the same on a laptop with a populated .env and in CI.
 */
import { describe, expect, it } from 'vitest';

import { buildConfig, envSchema, loadConfig } from '../../src/config/env.js';
import { ConfigError } from '../../src/errors.js';

/** The four variables with no default; everything else is optional. */
function minimalEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MONGODB_URI: 'mongodb://localhost:27017/?directConnection=true',
    MONGODB_DB_NAME: 'rag_kb',
    MCP_AUTH_TOKEN: 'a-token-that-is-long-enough',
    VOYAGE_API_KEY: 'pa-test-key',
    ...overrides,
  };
}

function expectConfigError(env: Record<string, string>): ConfigError {
  let thrown: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  return thrown as ConfigError;
}

describe('loadConfig — happy path', () => {
  it('maps a fully specified environment onto every config slice', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      LOG_PRETTY: 'true',
      SHUTDOWN_TIMEOUT_MS: '5000',
      MONGODB_URI: 'mongodb+srv://user:pw@cluster.example.mongodb.net',
      MONGODB_DB_NAME: 'knowledge',
      MONGODB_MAX_POOL_SIZE: '25',
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: '7500',
      MONGODB_VECTOR_INDEX_NAME: 'vec',
      MONGODB_TEXT_INDEX_NAME: 'txt',
      MONGODB_DOCUMENTS_TEXT_INDEX_NAME: 'doc_txt',
      MONGODB_INDEX_READY_TIMEOUT_MS: '120000',
      EMBEDDING_PROVIDER: 'voyage',
      EMBEDDING_MODEL: 'voyage-context-3',
      EMBEDDING_DIMENSIONS: '512',
      EMBEDDING_BATCH_SIZE: '4',
      VOYAGE_API_KEY: 'pa-secret',
      VOYAGE_API_BASE_URL: 'https://voyage.internal/v1',
      VOYAGE_TIMEOUT_MS: '15000',
      VOYAGE_MAX_RETRIES: '5',
      CHUNK_SIZE_TOKENS: '800',
      CHUNK_OVERLAP_TOKENS: '120',
      CHUNK_MIN_TOKENS: '40',
      // NODE_ENV is 'production' here, which applies the stricter token rules:
      // >= 24 chars, >= 10 distinct characters, no placeholder markers.
      MCP_AUTH_TOKEN: '9f3c1a7e5b2d84660aa1c3e7d95b402f8e6a1d3c7b95f024e8a6c1d3b7f95e02',
      MCP_PATH: '/rag/mcp',
      MCP_SERVER_NAME: 'kb',
      MCP_SERVER_VERSION: '2.1.0',
      MCP_DNS_REBINDING_PROTECTION: 'yes',
      MCP_ALLOWED_HOSTS: 'kb.example.com, localhost:3000',
      MCP_ALLOWED_ORIGINS: 'https://kb.example.com',
      SEARCH_DEFAULT_LIMIT: '15',
      SEARCH_MAX_LIMIT: '75',
      SEARCH_CANDIDATE_MULTIPLIER: '20',
      SEARCH_HYBRID_ENABLED: 'off',
      SEARCH_RRF_K: '30',
      SEARCH_VECTOR_WEIGHT: '0.6',
      WEB_UI_ENABLED: 'false',
      TRUST_PROXY: '1',
    });

    expect(config).toEqual({
      runtime: {
        nodeEnv: 'production',
        isProduction: true,
        isTest: false,
        port: 8080,
        host: '127.0.0.1',
        shutdownTimeoutMs: 5000,
        // TRUST_PROXY='1' is a HOP COUNT, not a boolean. See trustProxyFromEnv:
        // reading it as `true` would trust the whole X-Forwarded-For chain.
        trustProxy: 1,
      },
      logging: { level: 'debug', pretty: true },
      mongo: {
        uri: 'mongodb+srv://user:pw@cluster.example.mongodb.net',
        dbName: 'knowledge',
        maxPoolSize: 25,
        serverSelectionTimeoutMs: 7500,
        vectorIndexName: 'vec',
        textIndexName: 'txt',
        documentsTextIndexName: 'doc_txt',
        indexReadyTimeoutMs: 120000,
      },
      embedding: {
        provider: 'voyage',
        model: 'voyage-context-3',
        dimensions: 512,
        batchSize: 4,
        contextual: true,
        voyage: {
          apiKey: 'pa-secret',
          baseUrl: 'https://voyage.internal/v1',
          timeoutMs: 15000,
          maxRetries: 5,
        },
      },
      chunking: { chunkSizeTokens: 800, chunkOverlapTokens: 120, minChunkTokens: 40 },
      mcp: {
        authToken: '9f3c1a7e5b2d84660aa1c3e7d95b402f8e6a1d3c7b95f024e8a6c1d3b7f95e02',
        path: '/rag/mcp',
        serverName: 'kb',
        serverVersion: '2.1.0',
        dnsRebindingProtection: true,
        allowedHosts: ['kb.example.com', 'localhost:3000'],
        allowedOrigins: ['https://kb.example.com'],
      },
      search: {
        defaultLimit: 15,
        maxLimit: 75,
        candidateMultiplier: 20,
        hybridEnabled: false,
        rrfK: 30,
        vectorWeight: 0.6,
      },
      web: { enabled: false },
    });
  });

  it('applies the documented defaults when only the required variables are set', () => {
    const config = loadConfig(minimalEnv());

    expect(config.runtime).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      port: 3000,
      host: '0.0.0.0',
      shutdownTimeoutMs: 10_000,
      trustProxy: false,
    });
    expect(config.logging).toEqual({ level: 'info', pretty: false });
    expect(config.mongo).toMatchObject({
      maxPoolSize: 10,
      serverSelectionTimeoutMs: 10_000,
      vectorIndexName: 'chunks_vector_index',
      textIndexName: 'chunks_text_index',
      documentsTextIndexName: 'documents_text_index',
      indexReadyTimeoutMs: 300_000,
    });
    expect(config.embedding).toMatchObject({
      provider: 'voyage',
      model: 'voyage-context-3',
      dimensions: 1024,
      batchSize: 8,
      contextual: true,
    });
    expect(config.embedding.voyage).toMatchObject({
      baseUrl: 'https://api.voyageai.com/v1',
      timeoutMs: 30_000,
      maxRetries: 3,
    });
    expect(config.chunking).toEqual({
      chunkSizeTokens: 512,
      chunkOverlapTokens: 64,
      minChunkTokens: 32,
    });
    expect(config.mcp).toMatchObject({
      path: '/mcp',
      serverName: 'mongodb-memory-mcp',
      serverVersion: '0.1.0',
      dnsRebindingProtection: false,
      allowedHosts: [],
      allowedOrigins: [],
    });
    expect(config.search).toEqual({
      defaultLimit: 10,
      maxLimit: 50,
      candidateMultiplier: 10,
      hybridEnabled: true,
      rrfK: 60,
      vectorWeight: 0.7,
    });
    expect(config.web).toEqual({ enabled: true });
  });

  it('strips a trailing slash from VOYAGE_API_BASE_URL so URL joining is unambiguous', () => {
    const config = loadConfig(
      minimalEnv({ VOYAGE_API_BASE_URL: 'https://api.voyageai.com/v1///' }),
    );
    expect(config.embedding.voyage.baseUrl).toBe('https://api.voyageai.com/v1');
  });

  it('marks only the contextual models as contextual', () => {
    expect(
      loadConfig(minimalEnv({ EMBEDDING_MODEL: 'voyage-context-3' })).embedding.contextual,
    ).toBe(true);
    expect(loadConfig(minimalEnv({ EMBEDDING_MODEL: 'voyage-3.5' })).embedding.contextual).toBe(
      false,
    );
  });

  it('does not require a Voyage key when the fake provider is selected', () => {
    const env = minimalEnv();
    delete env['VOYAGE_API_KEY'];

    const config = loadConfig({ ...env, EMBEDDING_PROVIDER: 'fake' });

    expect(config.embedding.provider).toBe('fake');
    expect(config.embedding.voyage.apiKey).toBeUndefined();
  });

  it('buildConfig is a pure mapping of an already-parsed env', () => {
    const parsed = envSchema.parse(minimalEnv({ PORT: '4321' }));
    expect(buildConfig(parsed).runtime.port).toBe(4321);
    expect(buildConfig(parsed)).toEqual(loadConfig(minimalEnv({ PORT: '4321' })));
  });
});

describe('boolean coercion', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    [' On ', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('reads LOG_PRETTY=%s as %s', (raw, expected) => {
    expect(loadConfig(minimalEnv({ LOG_PRETTY: raw })).logging.pretty).toBe(expected);
  });

  it('falls back to the default for an empty string', () => {
    expect(loadConfig(minimalEnv({ SEARCH_HYBRID_ENABLED: '' })).search.hybridEnabled).toBe(true);
    expect(loadConfig(minimalEnv({ LOG_PRETTY: '' })).logging.pretty).toBe(false);
  });

  it('rejects anything that is not recognisably boolean', () => {
    const error = expectConfigError(minimalEnv({ WEB_UI_ENABLED: 'sometimes' }));
    expect(error.message).toContain('WEB_UI_ENABLED');
  });
});

describe('loadConfig — rejections', () => {
  it('rejects a missing MONGODB_URI', () => {
    const env = minimalEnv();
    delete env['MONGODB_URI'];
    expect(expectConfigError(env).message).toContain('MONGODB_URI');
  });

  it('rejects a URI that is not a MongoDB connection string', () => {
    const error = expectConfigError(minimalEnv({ MONGODB_URI: 'http://localhost:27017/kb' }));
    expect(error.message).toContain('MONGODB_URI');
    expect(error.message).toContain('mongodb://');
  });

  it('rejects a database name containing characters MongoDB disallows', () => {
    expect(expectConfigError(minimalEnv({ MONGODB_DB_NAME: 'rag kb/prod' })).message).toContain(
      'MONGODB_DB_NAME',
    );
  });

  it('rejects an MCP auth token that is too short to be a secret', () => {
    const error = expectConfigError(minimalEnv({ MCP_AUTH_TOKEN: 'short' }));
    expect(error.message).toContain('MCP_AUTH_TOKEN');
    expect(error.message).toContain('at least 16 characters');
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    const error = expectConfigError(
      minimalEnv({ CHUNK_SIZE_TOKENS: '256', CHUNK_OVERLAP_TOKENS: '256' }),
    );
    expect(error.message).toContain('CHUNK_OVERLAP_TOKENS');
    expect(error.message).toContain('CHUNK_SIZE_TOKENS (256)');
  });

  it('rejects a default search limit above the maximum', () => {
    const error = expectConfigError(
      minimalEnv({ SEARCH_DEFAULT_LIMIT: '60', SEARCH_MAX_LIMIT: '50' }),
    );
    expect(error.message).toContain('SEARCH_DEFAULT_LIMIT');
  });

  it('rejects EMBEDDING_PROVIDER=voyage without an API key', () => {
    const env = minimalEnv();
    delete env['VOYAGE_API_KEY'];
    const error = expectConfigError({ ...env, EMBEDDING_PROVIDER: 'voyage' });
    expect(error.message).toContain('VOYAGE_API_KEY');
    expect(error.message).toContain('EMBEDDING_PROVIDER=voyage');
  });

  it('rejects a dimension the configured Voyage model cannot produce', () => {
    const error = expectConfigError(
      minimalEnv({ EMBEDDING_MODEL: 'voyage-context-3', EMBEDDING_DIMENSIONS: '768' }),
    );
    expect(error.message).toContain('EMBEDDING_DIMENSIONS');
    expect(error.message).toContain('2048 | 1024 | 512 | 256');
  });

  it('accepts a Matryoshka dimension the model does support', () => {
    const config = loadConfig(
      minimalEnv({ EMBEDDING_MODEL: 'voyage-context-3', EMBEDDING_DIMENSIONS: '512' }),
    );
    expect(config.embedding.dimensions).toBe(512);
  });

  it('names every invalid variable in a single error', () => {
    const error = expectConfigError({
      MONGODB_URI: 'redis://localhost:6379',
      MONGODB_DB_NAME: 'bad name',
      MCP_AUTH_TOKEN: 'tiny',
      PORT: '99999',
      LOG_LEVEL: 'chatty',
      VOYAGE_API_KEY: 'pa-test-key',
    });

    for (const variable of [
      'MONGODB_URI',
      'MONGODB_DB_NAME',
      'MCP_AUTH_TOKEN',
      'PORT',
      'LOG_LEVEL',
    ]) {
      expect(error.message).toContain(variable);
    }
    expect(error.details['issueCount']).toBe(5);
  });

  it('reports several cross-field problems together', () => {
    const error = expectConfigError(
      minimalEnv({
        CHUNK_SIZE_TOKENS: '100',
        CHUNK_OVERLAP_TOKENS: '100',
        CHUNK_MIN_TOKENS: '200',
        SEARCH_DEFAULT_LIMIT: '90',
        SEARCH_MAX_LIMIT: '20',
      }),
    );

    expect(error.message).toContain('CHUNK_OVERLAP_TOKENS');
    expect(error.message).toContain('CHUNK_MIN_TOKENS');
    expect(error.message).toContain('SEARCH_DEFAULT_LIMIT');
  });

  it('is a ConfigError, so the logger treats it as fatal and points at .env.example', () => {
    const error = expectConfigError(minimalEnv({ PORT: 'http' }));
    expect(error.kind).toBe('config');
    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('.env.example');
  });
});

// ---------------------------------------------------------------------------
// TRUST_PROXY
// ---------------------------------------------------------------------------

/** A plausible `openssl rand -hex 32` value, for the production-only rules. */
const STRONG_TOKEN = '9f3c1a7e5b2d84660aa1c3e7d95b402f8e6a1d3c7b95f024e8a6c1d3b7f95e02';

describe('TRUST_PROXY', () => {
  const trustProxy = (value?: string): boolean | number | string =>
    loadConfig(minimalEnv(value === undefined ? {} : { TRUST_PROXY: value })).runtime.trustProxy;

  it('defaults to trusting no proxy', () => {
    expect(trustProxy()).toBe(false);
  });

  it.each(['false', 'no', 'off', '0'])('reads %s as no trust', (value) => {
    expect(trustProxy(value)).toBe(false);
  });

  it.each(['true', 'yes', 'on'])('reads %s as full trust outside production', (value) => {
    expect(trustProxy(value)).toBe(true);
  });

  /**
   * The important one. Express reads `true` as "trust the entire
   * X-Forwarded-For chain", which makes `req.ip` whatever the client says —
   * and `req.ip` is both the audit field and the throttle key in mcp/auth.ts.
   * A bare `1` almost always means "one proxy in front of me".
   */
  it('reads a bare number as a hop count, not as a boolean', () => {
    expect(trustProxy('1')).toBe(1);
    expect(trustProxy('2')).toBe(2);
  });

  it('passes an address list through untouched for Express to parse', () => {
    expect(trustProxy('loopback,10.0.0.0/8')).toBe('loopback,10.0.0.0/8');
  });

  it('rejects a bare true in production', () => {
    const error = expectConfigError(
      minimalEnv({ NODE_ENV: 'production', TRUST_PROXY: 'true', MCP_AUTH_TOKEN: STRONG_TOKEN }),
    );

    expect(error.message).toContain('TRUST_PROXY');
    expect(error.message).toContain('X-Forwarded-For');
  });

  it('accepts a hop count in production', () => {
    const config = loadConfig(
      minimalEnv({ NODE_ENV: 'production', TRUST_PROXY: '1', MCP_AUTH_TOKEN: STRONG_TOKEN }),
    );

    expect(config.runtime.trustProxy).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MCP_AUTH_TOKEN strength
// ---------------------------------------------------------------------------

describe('MCP_AUTH_TOKEN strength in production', () => {
  const production = (token: string): Record<string, string> =>
    minimalEnv({ NODE_ENV: 'production', MCP_AUTH_TOKEN: token });

  it('accepts a random hex secret', () => {
    expect(loadConfig(production(STRONG_TOKEN)).mcp.authToken).toBe(STRONG_TOKEN);
  });

  it('rejects a token under 24 characters', () => {
    const error = expectConfigError(production('0123456789abcdefghij'));
    expect(error.message).toContain('at least 24 characters');
  });

  it('rejects a long token built from a repeated pattern', () => {
    const error = expectConfigError(production('abababababababababababababababab'));
    expect(error.message).toContain('distinct characters');
  });

  it('rejects an obvious placeholder even when it is long and varied', () => {
    const error = expectConfigError(production('dev-local-token-not-a-secret-really'));
    expect(error.message).toContain('placeholder');
  });

  /**
   * The stricter rules are production-only on purpose: the dev compose stack
   * ships an obviously-fake token so `up` works on a clean checkout, and CI
   * uses a fixed dummy. Only the 16-character floor applies everywhere.
   */
  it('applies only the 16-character floor outside production', () => {
    expect(loadConfig(minimalEnv({ MCP_AUTH_TOKEN: 'aaaaaaaaaaaaaaaa' })).mcp.authToken).toBe(
      'aaaaaaaaaaaaaaaa',
    );
  });
});
