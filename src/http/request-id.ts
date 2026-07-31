/**
 * Per-request identity and the `RequestContext` every service call needs.
 *
 * One id follows a request through pino-http's access log, every `logAppError`
 * call, the error response body and the `x-request-id` response header, so a
 * user reporting "search 500'd" hands you a single string that finds every line.
 *
 * ## Why a WeakMap instead of `req.requestId`
 *
 * Augmenting `Express.Request` globally would put a property on every request
 * object in the process — including ones this middleware never touched — and
 * type it as always-present, which is a lie for anything mounted before us.
 * A WeakMap keyed by the request object is honest (`getRequestId` can say "not
 * assigned"), needs no global type surgery, and cannot collide with another
 * library's property. Entries die with the request.
 *
 * ## Why inbound ids are filtered rather than trusted
 *
 * `x-request-id` is attacker-controlled. It is echoed back in a response header
 * and written into structured logs, so an unfiltered value is a header-injection
 * and log-forging primitive. We accept it only if it is short and matches a
 * conservative character class; anything else is replaced with a fresh UUID.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { Request, RequestHandler, Response } from 'express';

import type { Logger } from '../logger.js';
import { requestLogger } from '../logger.js';
import type { RequestContext } from '../services/types.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Printable, unambiguous, and safe in a header value and a log line: no CR/LF,
 * no quotes, no spaces. Long enough for a W3C traceparent, short enough that it
 * cannot be used to pad megabytes into the log.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:@+=-]{8,128}$/u;

const REQUEST_IDS = new WeakMap<IncomingMessage, string>();

/** True when an inbound `x-request-id` may be reused as-is. */
export function isSafeRequestId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value);
}

/**
 * Assign a request id, expose it on the response, and remember it for the rest
 * of the pipeline. Must be mounted before pino-http so `genReqId` can read it.
 */
export function requestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    // `req.get` joins repeated headers with ", ", which the character class
    // rejects — so a duplicated header degrades to a generated id, not a splice.
    const inbound = req.get(REQUEST_ID_HEADER);
    const id = isSafeRequestId(inbound) ? inbound : randomUUID();

    REQUEST_IDS.set(req, id);
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

/**
 * The id assigned to this request, or `'unassigned'` if the middleware did not
 * run (only possible for something mounted above it, which we do not do).
 */
export function getRequestId(req: IncomingMessage): string {
  return REQUEST_IDS.get(req) ?? 'unassigned';
}

/**
 * Build the {@link RequestContext} handed to every `KnowledgeService` call.
 *
 * The abort signal fires only when the socket closes *before* the response was
 * written — a client that navigated away or timed out. Aborting on a normal
 * completed response would be pointless (the work is already done) and would
 * risk cancelling a still-running background continuation, so `writableEnded`
 * is checked. Downstream this cancels the in-flight Voyage HTTP request, which
 * is the expensive part of an abandoned search.
 */
export function createRequestContext(
  req: Request,
  res: Response,
  logger: Logger,
  channel: RequestContext['channel'],
): RequestContext {
  const requestId = getRequestId(req);
  const controller = new AbortController();

  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  return {
    channel,
    requestId,
    logger: requestLogger(logger, requestId, { channel }),
    signal: controller.signal,
  };
}
