/**
 * The last two middlewares in the stack: 404 and the error handler.
 *
 * Three rules drive everything here.
 *
 *  1. **Nothing internal escapes.** Every thrown value is normalised to an
 *     `AppError` and serialised with `toClientPayload()`, which deliberately
 *     omits the cause chain. A stack trace is attached only outside production.
 *
 *     Two mechanisms enforce this, because `toAppError` preserves the original
 *     `Error.message` when it wraps an unrecognised throw — so "it became an
 *     `InternalError`" is NOT on its own a guarantee that the message is safe:
 *
 *       - `kind: 'internal'` (the unrecognised bucket) is answered with a fixed
 *         string and no `details`. The real message is in the log line, findable
 *         by request id. This is the only kind we cannot reason about, so it is
 *         the only one that is discarded wholesale.
 *       - Every *other* kind keeps its message — those are written by us and are
 *         meant to be actionable — but is passed through {@link redactSecrets}
 *         first. A `SearchError` quotes `describeError(cause)`, and a driver
 *         error quotes the connection string, which carries the password.
 *
 *     The MCP surface has always redacted (`mcp/tools/shared.ts`). Doing it in
 *     only one of the two transports meant the same `AppError` was safe over MCP
 *     and leaking over REST, so both now call the same helper.
 *
 *  2. **The response format follows the caller.** `/api/*` and the MCP endpoint
 *     always get JSON; a browser navigating the web UI gets the rendered
 *     `error.ejs` page so a mistyped URL is not a wall of JSON. Content
 *     negotiation decides the ambiguous middle.
 *
 *  3. **The log line and the response share a request id**, so the opaque
 *     "Internal error" a user pastes into a ticket is findable.
 *
 * Body-parser failures are translated rather than passed through: a 413 from a
 * 6MB upload should say which limit it hit and what the character cap is, not
 * "request entity too large".
 */
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';

import type { AppConfig } from '../config/env.js';
import { AppError, NotFoundError, isAppError, toAppError } from '../errors.js';
import { MAX_CONTENT_CHARS } from '../domain/schemas.js';
import { logAppError, type Logger } from '../logger.js';
import { redactSecrets } from '../redact.js';
import { getRequestId } from './request-id.js';

/**
 * What an `internal` error says on the wire. Deliberately content-free: the
 * request id is the handle, and the detail lives in the log.
 */
const GENERIC_INTERNAL_MESSAGE =
  'The server hit an unexpected error. Quote the request id below when reporting it.';

export interface ErrorHandlerDeps {
  config: AppConfig;
  logger: Logger;
  /** The `express.json()` limit, quoted verbatim in the 413 message. */
  bodyLimit: string;
}

/** Terminal 404: nothing matched, so hand a typed error to the error handler. */
export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError(`No route matches ${req.method} ${req.path}`));
  };
}

export function createErrorHandler(deps: ErrorHandlerDeps): ErrorRequestHandler {
  const { config, logger, bodyLimit } = deps;
  const includeStack = !config.runtime.isProduction;

  return (rawError, req, res, next) => {
    const error = normalise(rawError, bodyLimit);
    const requestId = getRequestId(req);

    logAppError(logger, error, undefined, {
      requestId,
      method: req.method,
      path: req.path,
      status: error.httpStatus,
    });

    // Once bytes are on the wire the only honest thing left is to let Express
    // destroy the socket; writing a second body would corrupt the response.
    if (res.headersSent) {
      next(error);
      return;
    }

    const payload = {
      ...clientPayload(error, config),
      requestId,
      ...(includeStack && error.stack ? { stack: redactSecrets(error.stack, config) } : {}),
    };

    if (wantsJson(req, config)) {
      res.status(error.httpStatus).json({ error: payload });
      return;
    }

    res.status(error.httpStatus).render(
      'layout',
      {
        view: 'error',
        title: `${error.httpStatus} — ${titleFor(error)}`,
        activeNav: '',
        status: error.httpStatus,
        error: payload,
        requestId,
      },
      (renderError: Error | null, html?: string) => {
        // A broken template must not turn a 404 into an unhandled rejection.
        if (renderError) {
          logAppError(logger, renderError, 'failed to render the error page', { requestId });
          // `payload.message`, never `error.message`: this fallback is still a
          // response body, so it is subject to the same generic-internal and
          // redaction rules as the JSON and HTML paths above.
          res
            .type('text/plain')
            .send(`${error.httpStatus} ${payload.message}\nrequest id: ${requestId}`);
          return;
        }
        res.send(html);
      },
    );
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * The error body, with the two rules from the module docblock applied.
 *
 * `details` is left as-is on the kinds that keep it: every `details` object in
 * this codebase is built from internally-chosen keys and values (index names,
 * collection names, operation names, attempt counts, zod issue paths) rather
 * than from upstream response text, so it is not a leak path the way `message`
 * is. If that ever stops being true, redact here too.
 */
function clientPayload(
  error: AppError,
  config: AppConfig,
): ReturnType<AppError['toClientPayload']> {
  if (error.kind === 'internal') {
    return { code: error.code, kind: error.kind, message: GENERIC_INTERNAL_MESSAGE };
  }

  const payload = error.toClientPayload();
  return { ...payload, message: redactSecrets(payload.message, config) };
}

/** Shape of the `http-errors` objects body-parser and Express throw. */
interface HttpishError {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  expose?: unknown;
  limit?: unknown;
}

function normalise(value: unknown, bodyLimit: string): AppError {
  if (isAppError(value)) return value;

  const httpish = value as HttpishError | null;
  const status = statusOf(httpish);
  const type = typeof httpish?.type === 'string' ? httpish.type : '';

  if (type === 'entity.too.large' || status === 413) {
    return new AppError(
      `Request body is larger than the ${bodyLimit} limit. A single document may hold up to ` +
        `${MAX_CONTENT_CHARS.toLocaleString('en-US')} characters; split larger content into ` +
        'several store_content calls with distinct sourceIds.',
      {
        kind: 'validation',
        code: 'E_PAYLOAD_TOO_LARGE',
        httpStatus: 413,
        cause: value,
        details: { bodyLimit, maxContentChars: MAX_CONTENT_CHARS },
      },
    );
  }

  if (
    type.startsWith('entity.') ||
    type === 'encoding.unsupported' ||
    type === 'charset.unsupported'
  ) {
    return new AppError(`Malformed request body: ${messageOf(value)}`, {
      kind: 'validation',
      code: 'E_BAD_REQUEST_BODY',
      httpStatus: 400,
      cause: value,
    });
  }

  // Express itself throws http-errors for things like a malformed percent
  // escape in the URL. `expose` is the library's own "safe to show" flag.
  if (status !== null && status >= 400 && status < 500) {
    return new AppError(httpish?.expose === true ? messageOf(value) : 'Bad request', {
      kind: status === 404 ? 'not_found' : 'validation',
      code: status === 404 ? 'E_NOT_FOUND' : 'E_BAD_REQUEST',
      httpStatus: status,
      cause: value,
    });
  }

  return toAppError(value);
}

function statusOf(error: HttpishError | null): number | null {
  const raw = error?.status ?? error?.statusCode;
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

function messageOf(value: unknown): string {
  return value instanceof Error && value.message.length > 0 ? value.message : 'request failed';
}

/**
 * JSON for machines, HTML for browsers.
 *
 * `/api` and the MCP path are unconditionally JSON — a curl user who forgot an
 * Accept header still gets a parseable body — and everything else respects the
 * Accept header, defaulting to HTML only when the web UI is actually mounted.
 */
function wantsJson(req: Request, config: AppConfig): boolean {
  if (req.path.startsWith('/api/') || req.path === '/api') return true;
  if (req.path === config.mcp.path || req.path.startsWith(`${config.mcp.path}/`)) return true;
  if (!config.web.enabled) return true;
  return req.accepts(['html', 'json']) === 'json';
}

function titleFor(error: AppError): string {
  switch (error.kind) {
    case 'not_found':
      return 'Not found';
    case 'auth':
      return 'Unauthorized';
    case 'validation':
      return 'Bad request';
    default:
      return 'Something went wrong';
  }
}
