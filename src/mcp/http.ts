/**
 * Streamable HTTP transport for the MCP endpoint, with stateful sessions.
 *
 * ## One server *and* one transport per session
 *
 * `StreamableHTTPServerTransport` is not multiplexed: it owns the SSE stream and
 * the message correlation for exactly one client. `Protocol.connect` likewise
 * binds a `Server` to a single transport and overwrites its callbacks. So a
 * shared instance would cross-wire two clients' responses. Both objects are
 * therefore created per session and torn down together — which is cheap,
 * because `createMcpServer` is a pure composition root over shared,
 * already-constructed dependencies (`KnowledgeService`, the Mongo pool, the
 * embedding provider). Nothing per-session is expensive; only the bookkeeping.
 *
 * ## Why sessions rather than stateless mode
 *
 * Stateless mode would let each POST stand alone, but it also throws away the
 * initialize handshake, so `getClientVersion()` returns nothing and every stored
 * document loses its client attribution. It also rules out server→client
 * notifications over the GET stream. Sessions cost one map entry.
 *
 * ## Lifetime, and why leaks are structurally prevented
 *
 * A session lives in `sessions` from `onsessioninitialized` until its transport
 * closes — whether that is a DELETE, a dropped connection, or `closeAll()` at
 * shutdown. `transport.onclose` is the single reaping point and it removes the
 * map entry *and* closes the paired `McpServer`; closing only one of the two is
 * exactly how a "closed" session leaks a live object. The `Map.delete` return
 * value doubles as a re-entrancy guard, because `server.close()` closes the
 * transport, which fires `onclose` a second time.
 *
 * ## Body handling
 *
 * `express.json()` runs before this handler, so the body is already parsed and
 * the stream is consumed — it MUST be handed to `handleRequest` as the third
 * argument or the transport will hang waiting for bytes that will never come.
 * The mount point's `express.json({ limit })` must be large enough for a
 * 5,000,000-character document plus its JSON-RPC envelope and escaping (see
 * `MAX_CONTENT_CHARS`); a 5MB limit is *not* enough, since escaping inflates the
 * payload. `src/app.ts` owns that number.
 */
import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandler, Response } from 'express';

import type { AppConfig } from '../config/env.js';
import { describeError } from '../errors.js';
import { getRequestId } from '../http/request-id.js';
import { logAppError, requestLogger, type Logger } from '../logger.js';
import type { KnowledgeService } from '../services/types.js';
import { createMcpServer } from './server.js';

/** JSON-RPC implementation-defined server errors; reserved range -32000..-32099. */
const JSONRPC_SESSION_NOT_FOUND = -32001;
const JSONRPC_TOO_MANY_SESSIONS = -32003;
/** The spec's own "Invalid Request" code. */
const JSONRPC_INVALID_REQUEST = -32600;

/**
 * Session expiry.
 *
 * `transport.onclose` reaps a session when the client DELETEs it or its
 * connection drops — but a client is under no obligation to do either. A POST
 * that completes an `initialize` handshake and is never followed up leaves a
 * live `McpServer` and transport in the map forever, so the map grew without
 * bound and a caller holding the shared token could exhaust memory just by
 * looping `initialize`. (`createdAt` was already being recorded here; nothing
 * ever read it.)
 *
 * Idle rather than absolute age: a long-lived client doing real work every few
 * minutes must not have its session pulled out from under it, whereas one that
 * has said nothing for half an hour has almost certainly gone away. Every
 * request through a session refreshes `lastSeenAt`.
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Hard ceiling on concurrent sessions, as a backstop for the case the idle
 * timeout cannot cover: a client that opens sessions faster than they expire.
 * Once reached, `initialize` is refused rather than a live session being
 * stolen from whoever owns it.
 */
const MAX_LIVE_SESSIONS = 256;

export interface McpHttpDeps {
  service: KnowledgeService;
  config: AppConfig;
  logger: Logger;
}

export interface McpHttpHandler {
  /** Mount at `config.mcp.path` for POST, GET and DELETE. */
  handler: RequestHandler;
  /** Close every live session. Idempotent; call once during shutdown. */
  closeAll(): Promise<void>;
}

interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  /** Refreshed on every request routed to this session; drives idle expiry. */
  lastSeenAt: number;
}

export function createMcpHttpHandler(deps: McpHttpDeps): McpHttpHandler {
  const { config, logger } = deps;
  const sessions = new Map<string, Session>();

  /**
   * DNS-rebinding guards are only wired up when they are configured. An empty
   * `allowedHosts` array is not "no restriction" to the transport — it is a
   * list nothing can match — so an unset variable must mean the option is
   * absent, not present-and-empty.
   */
  function transportOptions(
    onsessioninitialized: (sessionId: string) => void,
    onsessionclosed: (sessionId: string) => void,
  ): StreamableHTTPServerTransportOptions {
    const options: StreamableHTTPServerTransportOptions = {
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized,
      onsessionclosed,
      enableDnsRebindingProtection: config.mcp.dnsRebindingProtection,
    };
    if (config.mcp.allowedHosts.length > 0) options.allowedHosts = [...config.mcp.allowedHosts];
    if (config.mcp.allowedOrigins.length > 0) {
      options.allowedOrigins = [...config.mcp.allowedOrigins];
    }
    return options;
  }

  /**
   * Build an unconnected server/transport pair. It becomes a *session* — an
   * entry in the map — only when the transport reports a session id, which
   * happens inside `handleRequest` once the initialize handshake succeeds.
   */
  function createPair(requestId: string): Pick<Session, 'server' | 'transport'> {
    const server = createMcpServer(deps);

    // `transport` is referenced by the callbacks below, which only ever run
    // after this statement has completed — the transport cannot initialise a
    // session before it exists.
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport(
      transportOptions(
        (sessionId) => {
          const startedAt = Date.now();
          sessions.set(sessionId, {
            id: sessionId,
            server,
            transport,
            createdAt: startedAt,
            lastSeenAt: startedAt,
          });
          logger.info(
            {
              event: 'mcp.session_initialised',
              requestId,
              mcpSessionId: sessionId,
              liveSessions: sessions.size,
            },
            'MCP session initialised',
          );
        },
        (sessionId) => {
          logger.debug(
            { event: 'mcp.session_terminated', requestId, mcpSessionId: sessionId },
            'MCP session terminated by the client',
          );
        },
      ),
    );

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      // A transport that closed before the handshake finished was never in the
      // map, and `delete` returning false means something already reaped it —
      // in both cases there is nothing left to do, and returning here is what
      // stops `server.close()` below from recursing through this callback.
      if (sessionId === undefined || !sessions.delete(sessionId)) return;

      logger.info(
        { event: 'mcp.session_closed', mcpSessionId: sessionId, liveSessions: sessions.size },
        'MCP session closed',
      );

      void server.close().catch((error: unknown) => {
        logAppError(logger, error, 'failed to close the MCP server for a closed session', {
          mcpSessionId: sessionId,
        });
      });
    };

    transport.onerror = (error) => {
      logAppError(logger, error, 'MCP transport error', {
        requestId,
        mcpSessionId: transport.sessionId,
      });
    };

    return { server, transport };
  }

  /**
   * Close every session that has gone quiet past {@link SESSION_IDLE_TIMEOUT_MS}.
   *
   * Closing the *server* rather than deleting the map entry is deliberate: that
   * closes the transport, which fires `transport.onclose`, which is the single
   * reaping point that removes the entry and logs it. Deleting here instead
   * would leave the `McpServer` alive and unreferenced — exactly the leak this
   * function exists to stop.
   */
  function sweepIdleSessions(): void {
    const now = Date.now();

    for (const session of [...sessions.values()]) {
      const idleMs = now - session.lastSeenAt;
      if (idleMs < SESSION_IDLE_TIMEOUT_MS) continue;

      logger.info(
        {
          event: 'mcp.session_expired',
          mcpSessionId: session.id,
          idleMs,
          ageMs: now - session.createdAt,
          liveSessions: sessions.size,
        },
        'closing an MCP session that has been idle past the timeout',
      );

      void session.server.close().catch((error: unknown) => {
        logAppError(logger, error, 'failed to close an expired MCP session', {
          mcpSessionId: session.id,
        });
      });
    }
  }

  const sweeper = setInterval(sweepIdleSessions, SESSION_SWEEP_INTERVAL_MS);
  // A housekeeping timer must never be the reason the process refuses to exit.
  sweeper.unref();

  const handler: RequestHandler = (req, res, next) => {
    const requestId = getRequestId(req);
    const log = requestLogger(logger, requestId, { channel: 'mcp' });
    const sessionId = req.get('mcp-session-id');

    void (async () => {
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);
        if (!session) {
          log.warn(
            { event: 'mcp.session_unknown', mcpSessionId: sessionId, method: req.method },
            'rejected a request for an unknown MCP session',
          );
          respond(
            res,
            404,
            JSONRPC_SESSION_NOT_FOUND,
            'Unknown or expired MCP session. Start a new one by POSTing an initialize request without an mcp-session-id header.',
            requestId,
          );
          return;
        }

        // Any traffic on a session counts as liveness, so an actively used
        // session is never swept out from under a working client.
        session.lastSeenAt = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method !== 'POST') {
        respond(
          res,
          400,
          JSONRPC_INVALID_REQUEST,
          `Bad Request: ${req.method} requires an mcp-session-id header. Only an initialize POST may omit it.`,
          requestId,
        );
        return;
      }

      if (!isInitializeRequest(req.body)) {
        respond(
          res,
          400,
          JSONRPC_INVALID_REQUEST,
          'Bad Request: no mcp-session-id header and the body is not an initialize request. Send initialize first, then reuse the mcp-session-id it returns.',
          requestId,
        );
        return;
      }

      // One last chance to make room before refusing: a burst of abandoned
      // sessions may already be past the idle timeout with the next scheduled
      // sweep still up to a minute away.
      if (sessions.size >= MAX_LIVE_SESSIONS) sweepIdleSessions();

      if (sessions.size >= MAX_LIVE_SESSIONS) {
        log.warn(
          { event: 'mcp.sessions_exhausted', liveSessions: sessions.size },
          'refused an initialize request because the session ceiling is reached',
        );
        respond(
          res,
          503,
          JSONRPC_TOO_MANY_SESSIONS,
          `This server is holding its maximum of ${MAX_LIVE_SESSIONS} concurrent MCP sessions. ` +
            'Close sessions you are finished with by sending DELETE with the mcp-session-id ' +
            'header, then retry.',
          requestId,
        );
        return;
      }

      const { server, transport } = createPair(requestId);
      try {
        await server.connect(transport);
      } catch (error) {
        // `onsessioninitialized` has not run yet, so nothing was added to the
        // map — but the transport still owns resources and must be released.
        await transport.close().catch(() => undefined);
        throw error;
      }

      log.debug({ event: 'mcp.session_initialising' }, 'handling an MCP initialize request');
      await transport.handleRequest(req, res, req.body);
    })().catch((error: unknown) => {
      // Anything reaching here happened before or instead of a transport
      // response, so the shared error handler can still write one.
      log.debug(
        { event: 'mcp.request_failed', detail: describeError(error) },
        'MCP request failed',
      );
      next(error);
    });
  };

  async function closeAll(): Promise<void> {
    // Stop housekeeping first: a sweep firing mid-shutdown would race the
    // teardown below over the same sessions.
    clearInterval(sweeper);

    const open = [...sessions.values()];
    // Cleared up front so the `onclose` callbacks fired by `server.close()`
    // find nothing to reap and stay quiet during shutdown.
    sessions.clear();

    if (open.length > 0) {
      logger.info(
        { event: 'mcp.sessions_closing', liveSessions: open.length },
        'closing every live MCP session',
      );
    }

    const results = await Promise.allSettled(open.map((session) => session.server.close()));
    for (const result of results) {
      if (result.status === 'rejected') {
        logAppError(logger, result.reason, 'failed to close an MCP session during shutdown');
      }
    }
  }

  return { handler, closeAll };
}

/**
 * Write a JSON-RPC error. `id: null` is correct here: the failure is with the
 * envelope or the session, so there is no request id to correlate against.
 */
function respond(
  res: Response,
  status: number,
  code: number,
  message: string,
  requestId: string,
): void {
  if (res.headersSent) return;
  res.status(status).json({
    jsonrpc: '2.0',
    id: null,
    error: { code, message, data: { requestId } },
  });
}
