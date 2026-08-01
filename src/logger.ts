/**
 * Structured logging (pino).
 *
 * Two rules this module enforces:
 *  1. Embedding/chunking failures are logged *distinctly* from validation
 *     failures — see {@link logAppError}, which maps `AppError.kind` to a
 *     stable `event` name and an appropriate level.
 *  2. Nothing secret or enormous reaches the log: auth headers and API keys are
 *     redacted, and raw embedding vectors are never serialised.
 */
import { pino, stdSerializers, stdTimeFunctions, type Logger, type LoggerOptions } from 'pino';

import type { LoggingConfig } from './config/env.js';
import { toAppError, type ErrorKind } from './errors.js';

export type { Logger };

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'apiKey',
  'authToken',
  'VOYAGE_API_KEY',
  'MCP_AUTH_TOKEN',
  '*.embedding',
  'embedding',
  'embeddings',
];

/** Level to use per error kind. Ingestion faults are errors; caller faults are warnings. */
const LEVEL_BY_KIND: Record<ErrorKind, 'warn' | 'error' | 'fatal'> = {
  config: 'fatal',
  validation: 'warn',
  auth: 'warn',
  not_found: 'warn',
  chunking: 'error',
  embedding: 'error',
  storage: 'error',
  search: 'error',
  index: 'error',
  internal: 'error',
};

/** Stable, greppable event names — dashboards and alerts key off these. */
const EVENT_BY_KIND: Record<ErrorKind, string> = {
  config: 'config.invalid',
  validation: 'input.validation_failed',
  auth: 'auth.rejected',
  not_found: 'resource.not_found',
  chunking: 'ingest.chunking_failed',
  embedding: 'ingest.embedding_failed',
  storage: 'storage.failed',
  search: 'search.failed',
  index: 'index.unavailable',
  internal: 'internal.error',
};

export function createLogger(cfg: LoggingConfig): Logger {
  const options: LoggerOptions = {
    level: cfg.level,
    base: { service: 'mongodb-memory-mcp' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: stdSerializers.err,
    },
    timestamp: stdTimeFunctions.isoTime,
  };

  if (cfg.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
    });
  }

  return pino(options);
}

/**
 * Log a thrown value with the level and `event` name that match its kind.
 *
 * Always prefer this over `logger.error({ err })` so that an embedding outage
 * and a malformed tool call never land in the same bucket.
 */
export function logAppError(
  logger: Logger,
  error: unknown,
  message?: string,
  context: Record<string, unknown> = {},
): void {
  const appError = toAppError(error);
  const level = LEVEL_BY_KIND[appError.kind];

  logger[level](
    {
      err: appError,
      event: EVENT_BY_KIND[appError.kind],
      errorKind: appError.kind,
      errorCode: appError.code,
      retryable: appError.retryable,
      ...appError.details,
      ...context,
    },
    message ?? appError.message,
  );
}

/** Child logger tagged with a request id, used by the HTTP and MCP layers. */
export function requestLogger(
  logger: Logger,
  requestId: string,
  extra: Record<string, unknown> = {},
): Logger {
  return logger.child({ requestId, ...extra });
}
