/**
 * Typed application errors.
 *
 * The `kind` discriminant exists so the log pipeline can tell an *ingestion*
 * problem (embedding / chunking / storage) apart from a *validation* problem
 * (bad input from an AI client) — a hard requirement from the spec, because the
 * two have completely different owners and remediation.
 */

export type ErrorKind =
  | 'config'
  | 'validation'
  | 'auth'
  | 'not_found'
  | 'chunking'
  | 'embedding'
  | 'storage'
  | 'search'
  | 'index'
  | 'internal';

export interface AppErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

/** Base class for every error this application raises deliberately. */
export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    opts: AppErrorOptions & { kind: ErrorKind; code: string; httpStatus: number },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.kind = opts.kind;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details ?? {};
    Error.captureStackTrace?.(this, new.target);
  }

  /** Safe to hand back to an MCP/HTTP client — never includes the cause chain. */
  toClientPayload(): {
    code: string;
    kind: ErrorKind;
    message: string;
    details?: Record<string, unknown>;
  } {
    const payload: {
      code: string;
      kind: ErrorKind;
      message: string;
      details?: Record<string, unknown>;
    } = {
      code: this.code,
      kind: this.kind,
      message: this.message,
    };
    if (Object.keys(this.details).length > 0) payload.details = this.details;
    return payload;
  }
}

/** Startup configuration is invalid. Always fatal — never caught and retried. */
export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { kind: 'config', code: 'E_CONFIG', httpStatus: 500, details });
  }
}

/** Untrusted input failed schema validation. The caller's fault, not ours. */
export class ValidationError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'validation', code: 'E_VALIDATION', httpStatus: 400 });
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized', opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'auth', code: 'E_UNAUTHORIZED', httpStatus: 401 });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'not_found', code: 'E_NOT_FOUND', httpStatus: 404 });
  }
}

/** Content could not be split into chunks (e.g. empty after normalisation). */
export class ChunkingError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'chunking', code: 'E_CHUNKING', httpStatus: 422 });
  }
}

/** The embedding provider failed: network, rate limit, bad response shape. */
export class EmbeddingError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, {
      retryable: true,
      ...opts,
      kind: 'embedding',
      code: 'E_EMBEDDING',
      httpStatus: 502,
    });
  }
}

export class StorageError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'storage', code: 'E_STORAGE', httpStatus: 503 });
  }
}

export class SearchError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'search', code: 'E_SEARCH', httpStatus: 503 });
  }
}

/** An MongoDB Search / Vector Search index is missing, stale or not queryable. */
export class IndexError extends AppError {
  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'index', code: 'E_INDEX', httpStatus: 503 });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal error', opts: AppErrorOptions = {}) {
    super(message, { ...opts, kind: 'internal', code: 'E_INTERNAL', httpStatus: 500 });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalise anything thrown into an AppError without losing the original. */
export function toAppError(value: unknown, fallbackMessage = 'Unexpected error'): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error)
    return new InternalError(value.message || fallbackMessage, { cause: value });
  return new InternalError(fallbackMessage, { cause: value });
}

/** Short, log-safe description of an unknown thrown value. */
export function describeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
