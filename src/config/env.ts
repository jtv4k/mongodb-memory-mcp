/**
 * Environment loading + validation.
 *
 * Everything the app needs comes from the environment and is validated ONCE at
 * startup with zod. A missing or malformed value is a startup crash, never a
 * surprise at first request. Nothing in this module reads a `.env` file itself —
 * that is the runtime's job (`node --env-file`, docker-compose `env_file`, or
 * the test harness) — so this stays a pure function of an env-like record.
 */
import { z } from 'zod';

import { ConfigError } from '../errors.js';

/** Voyage models whose output dimension is selectable (Matryoshka embeddings). */
const KNOWN_MODEL_DIMENSIONS: Record<string, readonly number[]> = {
  'voyage-context-3': [2048, 1024, 512, 256],
  'voyage-3.5': [2048, 1024, 512, 256],
  'voyage-3.5-lite': [2048, 1024, 512, 256],
  'voyage-3-large': [2048, 1024, 512, 256],
  'voyage-code-3': [2048, 1024, 512, 256],
};

/** Voyage models that embed each chunk conditioned on its sibling chunks. */
const CONTEXTUAL_MODELS = new Set(['voyage-context-3']);

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

const boolFromEnv = (defaultValue: boolean) =>
  z.preprocess((raw) => {
    if (raw === undefined || raw === '') return defaultValue;
    if (typeof raw === 'boolean') return raw;
    const normalized = String(raw).trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    return raw; // fall through to z.boolean() so the error names the variable
  }, z.boolean());

const csvFromEnv = (defaultValue: readonly string[] = []) =>
  z.preprocess(
    (raw) => {
      if (raw === undefined || raw === '') return [...defaultValue];
      if (Array.isArray(raw)) return raw;
      return String(raw)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    },
    z.array(z.string().min(1)),
  );

/**
 * `TRUST_PROXY` — how Express should read `X-Forwarded-For`.
 *
 * A bare `true` is the footgun in Express's API: it
 * trusts the *entire* forwarded chain, so `req.ip` becomes whatever the client
 * put in the header. `req.ip` is what the auth-rejection log records and what
 * the failed-attempt throttle in `mcp/auth.ts` is keyed on, so a spoofable
 * value means forged log entries and a trivially evaded rate limit.
 *
 * Accepted forms, in the order they are tried:
 *   - unset / `false` / `no` / `off` / `0`  -> no proxy (the default)
 *   - `true` / `yes` / `on`                 -> trust everything (rejected in production)
 *   - a non-negative integer                -> hop count, e.g. `1` behind one load balancer
 *   - anything else                         -> passed to Express verbatim as a
 *     trusted address list: `loopback`, `10.0.0.0/8`, `uniquelocal`, comma-separated
 *
 * `1` and `0` are read as hop counts rather than as booleans on purpose. Both
 * readings coincide for `0`, and for `1` the hop count is both the far more
 * likely intent and the safer of the two.
 */
const trustProxyFromEnv = z.preprocess(
  (raw) => {
    if (raw === undefined || raw === '') return false;
    if (typeof raw === 'boolean') return raw;

    const normalized = String(raw).trim();
    if (normalized === '') return false;

    const lowered = normalized.toLowerCase();
    if (FALSY.has(lowered)) return false;
    if (lowered === 'true' || lowered === 'yes' || lowered === 'on') return true;
    if (/^\d+$/u.test(normalized)) return Number(normalized);

    return normalized;
  },
  z.union([z.boolean(), z.number().int().min(0).max(31), z.string().min(1)]),
);

/**
 * Production-only floors on `MCP_AUTH_TOKEN`.
 *
 * The base rule is 16 characters, which is enough to keep a laptop honest but
 * permits `passwordpassword`. In production the token is the single credential
 * guarding read *and* write access to the whole knowledge base, so it has to
 * look like it came out of `openssl rand -hex 32`. The distinct-character floor
 * is what separates a real random token from a repeated word.
 */
const MIN_PRODUCTION_TOKEN_CHARS = 24;
const MIN_PRODUCTION_TOKEN_DISTINCT_CHARS = 10;

/** Substrings that mark a value as a placeholder somebody forgot to replace. */
const PLACEHOLDER_TOKEN_MARKERS = [
  'not-a-secret',
  'notasecret',
  'changeme',
  'change-me',
  'replace-me',
  'replaceme',
  'placeholder',
  'example',
  'password',
  'insecure',
  'dev-local',
  'your-token',
  'yourtoken',
  'test-token',
];

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().min(0);

export const envSchema = z
  .object({
    // ---- runtime -----------------------------------------------------------
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: boolFromEnv(false),
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),

    // ---- mongodb -----------------------------------------------------------
    MONGODB_URI: z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
        'must start with mongodb:// or mongodb+srv://',
      ),
    MONGODB_DB_NAME: z
      .string()
      .min(1)
      .max(63)
      // MongoDB forbids these in database names; catch it here rather than at first query.
      .refine((value) => !/[/\\. "$*<>:|?]/.test(value), 'contains characters MongoDB disallows'),
    MONGODB_MAX_POOL_SIZE: positiveInt.max(500).default(10),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: positiveInt.default(10_000),
    MONGODB_VECTOR_INDEX_NAME: z.string().min(1).default('chunks_vector_index'),
    MONGODB_TEXT_INDEX_NAME: z.string().min(1).default('chunks_text_index'),
    MONGODB_DOCUMENTS_TEXT_INDEX_NAME: z.string().min(1).default('documents_text_index'),
    /** How long `db:indexes` waits for MongoDB Search indexes to become queryable. */
    MONGODB_INDEX_READY_TIMEOUT_MS: positiveInt.default(300_000),

    // ---- embeddings --------------------------------------------------------
    EMBEDDING_PROVIDER: z.enum(['voyage', 'fake']).default('voyage'),
    EMBEDDING_MODEL: z.string().min(1).default('voyage-context-3'),
    EMBEDDING_DIMENSIONS: positiveInt.max(4096).default(1024),
    /** Documents per Voyage request (each document carries many chunks). */
    EMBEDDING_BATCH_SIZE: positiveInt.max(128).default(8),
    VOYAGE_API_KEY: z.string().min(1).optional(),
    VOYAGE_API_BASE_URL: z.string().url().default('https://api.voyageai.com/v1'),
    VOYAGE_TIMEOUT_MS: positiveInt.default(30_000),
    VOYAGE_MAX_RETRIES: nonNegativeInt.max(10).default(3),

    // ---- chunking ----------------------------------------------------------
    CHUNK_SIZE_TOKENS: positiveInt.max(8192).default(512),
    CHUNK_OVERLAP_TOKENS: nonNegativeInt.max(4096).default(64),
    /** Chunks smaller than this get merged into a neighbour instead of stored. */
    CHUNK_MIN_TOKENS: positiveInt.max(4096).default(32),

    // ---- mcp ---------------------------------------------------------------
    MCP_AUTH_TOKEN: z.string().min(16, 'must be at least 16 characters'),
    MCP_PATH: z.string().startsWith('/').default('/mcp'),
    MCP_SERVER_NAME: z.string().min(1).default('mongodb-memory-mcp'),
    MCP_SERVER_VERSION: z.string().min(1).default('0.1.0'),
    /** Guards browser-based DNS-rebinding attacks on the local HTTP transport. */
    MCP_DNS_REBINDING_PROTECTION: boolFromEnv(false),
    MCP_ALLOWED_HOSTS: csvFromEnv([]),
    MCP_ALLOWED_ORIGINS: csvFromEnv([]),

    // ---- search ------------------------------------------------------------
    SEARCH_DEFAULT_LIMIT: positiveInt.max(200).default(10),
    SEARCH_MAX_LIMIT: positiveInt.max(500).default(50),
    /** $vectorSearch numCandidates = limit * this, clamped to 10_000. */
    SEARCH_CANDIDATE_MULTIPLIER: positiveInt.max(200).default(10),
    SEARCH_HYBRID_ENABLED: boolFromEnv(true),
    /** Reciprocal-rank-fusion smoothing constant. */
    SEARCH_RRF_K: positiveInt.default(60),
    SEARCH_VECTOR_WEIGHT: z.coerce.number().min(0).max(1).default(0.7),

    // ---- web ---------------------------------------------------------------
    WEB_UI_ENABLED: boolFromEnv(true),
    TRUST_PROXY: trustProxyFromEnv,
  })
  .superRefine((env, ctx) => {
    if (env.EMBEDDING_PROVIDER === 'voyage' && !env.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VOYAGE_API_KEY'],
        message: 'is required when EMBEDDING_PROVIDER=voyage',
      });
    }

    if (env.CHUNK_OVERLAP_TOKENS >= env.CHUNK_SIZE_TOKENS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP_TOKENS'],
        message: `must be less than CHUNK_SIZE_TOKENS (${env.CHUNK_SIZE_TOKENS})`,
      });
    }

    if (env.CHUNK_MIN_TOKENS > env.CHUNK_SIZE_TOKENS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_MIN_TOKENS'],
        message: `must not exceed CHUNK_SIZE_TOKENS (${env.CHUNK_SIZE_TOKENS})`,
      });
    }

    if (env.SEARCH_DEFAULT_LIMIT > env.SEARCH_MAX_LIMIT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SEARCH_DEFAULT_LIMIT'],
        message: `must not exceed SEARCH_MAX_LIMIT (${env.SEARCH_MAX_LIMIT})`,
      });
    }

    if (env.NODE_ENV === 'production') {
      // `trust proxy: true` makes `req.ip` client-controlled. In production that
      // is a forged audit trail and a rate limiter an attacker can step around
      // by varying one header, so the operator has to say how much to trust.
      if (env.TRUST_PROXY === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TRUST_PROXY'],
          message:
            'must not be a bare "true" in production — that trusts the whole X-Forwarded-For ' +
            'chain and lets any client forge its own source IP. Use the number of proxies in ' +
            'front of this process (e.g. TRUST_PROXY=1), or a trusted address list ' +
            '(e.g. TRUST_PROXY=loopback,10.0.0.0/8).',
        });
      }

      const token = env.MCP_AUTH_TOKEN;
      if (token.length < MIN_PRODUCTION_TOKEN_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_AUTH_TOKEN'],
          message:
            `must be at least ${MIN_PRODUCTION_TOKEN_CHARS} characters in production ` +
            '(generate one with: openssl rand -hex 32)',
        });
      } else if (new Set(token).size < MIN_PRODUCTION_TOKEN_DISTINCT_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_AUTH_TOKEN'],
          message:
            `uses fewer than ${MIN_PRODUCTION_TOKEN_DISTINCT_CHARS} distinct characters, so it ` +
            'is a repeated or patterned string rather than a random secret ' +
            '(generate one with: openssl rand -hex 32)',
        });
      }

      const lowered = token.toLowerCase();
      if (PLACEHOLDER_TOKEN_MARKERS.some((marker) => lowered.includes(marker))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MCP_AUTH_TOKEN'],
          message:
            'looks like a placeholder that was never replaced ' +
            '(generate a real one with: openssl rand -hex 32)',
        });
      }
    }

    const allowed = KNOWN_MODEL_DIMENSIONS[env.EMBEDDING_MODEL];
    if (
      env.EMBEDDING_PROVIDER === 'voyage' &&
      allowed &&
      !allowed.includes(env.EMBEDDING_DIMENSIONS)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMBEDDING_DIMENSIONS'],
        message: `${env.EMBEDDING_MODEL} supports ${allowed.join(' | ')}, got ${env.EMBEDDING_DIMENSIONS}`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Nested, hand-written app config. Services depend on these small slices rather
// than on the flat env record, which keeps their signatures honest and makes
// them trivial to construct in tests.
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  isTest: boolean;
  port: number;
  host: string;
  shutdownTimeoutMs: number;
  /**
   * Handed to `app.set('trust proxy', …)` verbatim. Boolean, a hop count, or a
   * trusted address list — see {@link trustProxyFromEnv} for why it is not just
   * a boolean any more.
   */
  trustProxy: boolean | number | string;
}

export interface LoggingConfig {
  level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  pretty: boolean;
}

export interface MongoConfig {
  uri: string;
  dbName: string;
  maxPoolSize: number;
  serverSelectionTimeoutMs: number;
  vectorIndexName: string;
  textIndexName: string;
  documentsTextIndexName: string;
  indexReadyTimeoutMs: number;
}

export interface EmbeddingConfig {
  provider: 'voyage' | 'fake';
  model: string;
  dimensions: number;
  batchSize: number;
  /** True when the model conditions each chunk vector on its sibling chunks. */
  contextual: boolean;
  voyage: {
    apiKey: string | undefined;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
  };
}

export interface ChunkingConfig {
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
  minChunkTokens: number;
}

export interface McpConfig {
  authToken: string;
  path: string;
  serverName: string;
  serverVersion: string;
  dnsRebindingProtection: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export interface SearchConfig {
  defaultLimit: number;
  maxLimit: number;
  candidateMultiplier: number;
  hybridEnabled: boolean;
  rrfK: number;
  vectorWeight: number;
}

export interface WebConfig {
  enabled: boolean;
}

export interface AppConfig {
  runtime: RuntimeConfig;
  logging: LoggingConfig;
  mongo: MongoConfig;
  embedding: EmbeddingConfig;
  chunking: ChunkingConfig;
  mcp: McpConfig;
  search: SearchConfig;
  web: WebConfig;
}

export function buildConfig(env: Env): AppConfig {
  return {
    runtime: {
      nodeEnv: env.NODE_ENV,
      isProduction: env.NODE_ENV === 'production',
      isTest: env.NODE_ENV === 'test',
      port: env.PORT,
      host: env.HOST,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      trustProxy: env.TRUST_PROXY,
    },
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY,
    },
    mongo: {
      uri: env.MONGODB_URI,
      dbName: env.MONGODB_DB_NAME,
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      serverSelectionTimeoutMs: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      vectorIndexName: env.MONGODB_VECTOR_INDEX_NAME,
      textIndexName: env.MONGODB_TEXT_INDEX_NAME,
      documentsTextIndexName: env.MONGODB_DOCUMENTS_TEXT_INDEX_NAME,
      indexReadyTimeoutMs: env.MONGODB_INDEX_READY_TIMEOUT_MS,
    },
    embedding: {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      batchSize: env.EMBEDDING_BATCH_SIZE,
      contextual: CONTEXTUAL_MODELS.has(env.EMBEDDING_MODEL),
      voyage: {
        apiKey: env.VOYAGE_API_KEY,
        baseUrl: env.VOYAGE_API_BASE_URL.replace(/\/+$/, ''),
        timeoutMs: env.VOYAGE_TIMEOUT_MS,
        maxRetries: env.VOYAGE_MAX_RETRIES,
      },
    },
    chunking: {
      chunkSizeTokens: env.CHUNK_SIZE_TOKENS,
      chunkOverlapTokens: env.CHUNK_OVERLAP_TOKENS,
      minChunkTokens: env.CHUNK_MIN_TOKENS,
    },
    mcp: {
      authToken: env.MCP_AUTH_TOKEN,
      path: env.MCP_PATH,
      serverName: env.MCP_SERVER_NAME,
      serverVersion: env.MCP_SERVER_VERSION,
      dnsRebindingProtection: env.MCP_DNS_REBINDING_PROTECTION,
      allowedHosts: env.MCP_ALLOWED_HOSTS,
      allowedOrigins: env.MCP_ALLOWED_ORIGINS,
    },
    search: {
      defaultLimit: env.SEARCH_DEFAULT_LIMIT,
      maxLimit: env.SEARCH_MAX_LIMIT,
      candidateMultiplier: env.SEARCH_CANDIDATE_MULTIPLIER,
      hybridEnabled: env.SEARCH_HYBRID_ENABLED,
      rrfK: env.SEARCH_RRF_K,
      vectorWeight: env.SEARCH_VECTOR_WEIGHT,
    },
    web: {
      enabled: env.WEB_UI_ENABLED,
    },
  };
}

/**
 * Validate an env-like record and build the nested config.
 *
 * Throws {@link ConfigError} listing every problem at once — one crash tells you
 * about all the misconfigured variables, not just the first.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const variable = issue.path.join('.') || '(root)';
      return `  - ${variable}: ${issue.message}`;
    });
    throw new ConfigError(
      `Invalid environment configuration:\n${issues.join('\n')}\n\nSee .env.example for the full list of supported variables.`,
      { issueCount: parsed.error.issues.length },
    );
  }

  return buildConfig(parsed.data);
}
