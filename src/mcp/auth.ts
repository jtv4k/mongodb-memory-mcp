/**
 * Bearer-token authentication for the MCP endpoint *and* every `/api/*` route.
 *
 * This process is network-reachable and the knowledge base holds every ingested
 * document verbatim, so there is no "reads are harmless" carve-out:
 * `src/http/api.ts` mounts this same middleware on its whole router, GETs
 * included.
 *
 * ## Why the comparison is hashed, not `===`
 *
 * `presented === expected` compares byte by byte and returns at the first
 * difference. That is a genuine timing oracle: an attacker who can measure the
 * response time can recover the token one character at a time, turning a
 * 2^256 search into a linear one. `crypto.timingSafeEqual` fixes the early exit,
 * but it *throws* when the two buffers differ in length — so calling it on raw
 * tokens would both crash on a short guess and leak the expected length through
 * which requests error out. Hashing both sides with SHA-256 first makes the
 * inputs unconditionally 32 bytes, so the comparison is total, constant-time and
 * length-blind. The expected digest is computed once at construction; the
 * plaintext token is never re-read per request.
 *
 * ## Why the failure path is written here rather than thrown to the error handler
 *
 * A 401 has to carry a `WWW-Authenticate` challenge to be a well-formed HTTP
 * response, and the shared error handler in `http/errors.ts` cannot know which
 * scheme to advertise. Writing the response here also guarantees the body is
 * always JSON-RPC-shaped, which is what an MCP client's transport expects to
 * parse even when the rejection happened before the JSON-RPC layer ever ran.
 *
 * ## What is never logged
 *
 * Neither the presented token nor the expected one, in any form — not truncated,
 * not hashed. A hash prefix is still a verifier for an offline guess. The log
 * line carries the request id, the source IP and *which* headers were present,
 * which is everything an operator needs to tell a misconfigured client apart
 * from a scan.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { RequestHandler } from 'express';

import type { McpConfig } from '../config/env.js';
import { AuthError } from '../errors.js';
import { getRequestId } from '../http/request-id.js';
import { logAppError, type Logger } from '../logger.js';

/** JSON-RPC implementation-defined server error; the reserved range is -32000..-32099. */
const JSONRPC_UNAUTHORIZED = -32001;

/** Everything outside this class is stripped from the quoted `WWW-Authenticate` realm. */
const UNSAFE_REALM_CHARS = /[^\w .:@/-]/g;

/** `Bearer <token>`; the scheme is case-insensitive per RFC 7235. */
const BEARER_PATTERN = /^Bearer[ \t]+(.+)$/i;

type FailureReason = 'missing' | 'invalid';

const CHALLENGE_MESSAGE: Record<FailureReason, string> = {
  missing:
    'Authentication required. Send the API token as "Authorization: Bearer <token>" or "x-api-key: <token>".',
  invalid:
    'The API token presented was rejected. Check that MCP_AUTH_TOKEN on the server matches the token your client sends.',
};

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Candidate tokens carried by this request, in no particular priority.
 *
 * Both headers are collected rather than short-circuiting on the first one
 * present, so a client that sends a stale `Authorization` alongside a good
 * `x-api-key` is not rejected for the order it chose. A non-Bearer scheme
 * contributes no candidate and therefore fails closed. `req.get` joins repeated
 * headers with ", ", which simply yields a token that cannot match.
 */
function presentedTokens(authorization: string | undefined, apiKey: string | undefined): string[] {
  const tokens: string[] = [];

  const bearer = authorization?.trim().match(BEARER_PATTERN)?.[1]?.trim();
  if (bearer !== undefined && bearer.length > 0) tokens.push(bearer);

  const key = apiKey?.trim();
  if (key !== undefined && key.length > 0) tokens.push(key);

  return tokens;
}

/**
 * Guard every request below it with the shared secret from `MCP_AUTH_TOKEN`.
 *
 * @param cfg    MCP config slice — supplies the expected token and the realm name.
 * @param logger Parent logger; rejections are logged as {@link AuthError} (warn level).
 */
export function createMcpAuthMiddleware(cfg: McpConfig, logger: Logger): RequestHandler {
  const expectedDigest = sha256(cfg.authToken);
  const realm = cfg.serverName.replace(UNSAFE_REALM_CHARS, '') || 'mcp';

  const matches = (candidate: string): boolean =>
    timingSafeEqual(sha256(candidate), expectedDigest);

  return (req, res, next) => {
    const authorization = req.get('authorization');
    const apiKey = req.get('x-api-key');
    const candidates = presentedTokens(authorization, apiKey);

    // Deliberately no early `break`: every candidate is compared so the amount
    // of work does not depend on which header happened to be the right one.
    let authorized = false;
    for (const candidate of candidates) {
      if (matches(candidate)) authorized = true;
    }

    if (authorized) {
      next();
      return;
    }

    const reason: FailureReason = candidates.length === 0 ? 'missing' : 'invalid';
    const requestId = getRequestId(req);
    const error = new AuthError(CHALLENGE_MESSAGE[reason], {
      details: {
        reason,
        // Which headers were *present*, never their contents.
        presentedAuthorization: authorization !== undefined,
        presentedApiKey: apiKey !== undefined,
      },
    });

    logAppError(logger, error, 'rejected an unauthenticated request', {
      requestId,
      method: req.method,
      path: req.path,
      sourceIp: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      userAgent: req.get('user-agent'),
    });

    res.setHeader(
      'WWW-Authenticate',
      reason === 'missing'
        ? `Bearer realm="${realm}"`
        : `Bearer realm="${realm}", error="invalid_token"`,
    );

    // A JSON-RPC envelope even on the REST routes: an MCP client parses the body
    // unconditionally, and a `curl` user still gets machine-readable `data`.
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSONRPC_UNAUTHORIZED,
        message: error.message,
        data: { code: error.code, kind: error.kind, reason, requestId },
      },
    });
  };
}
