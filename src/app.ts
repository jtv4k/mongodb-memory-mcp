/**
 * Express application assembly.
 *
 * This module is a composition root and nothing else: it owns the *order* of the
 * middleware stack and none of the behaviour. Every handler it mounts lives in
 * `src/http/*` or `src/mcp/*`, so the thing you have to reason about here is
 * exactly the thing that is easy to get wrong — what runs before what.
 *
 * ## The order, and why each step sits where it does
 *
 *  1. `trust proxy` — before anything reads `req.ip`. Off unless configured,
 *     because trusting `X-Forwarded-For` from an unproxied socket lets a client
 *     forge its own source address into the auth-rejection log.
 *  2. request id — before pino-http, so the access log, every `logAppError`
 *     call and the `x-request-id` response header all carry the same string.
 *  3. pino-http — one shared logger instance, not a second one.
 *  4. `X-Content-Type-Options: nosniff` — cheap, global, and applies to the JSON
 *     surfaces too, not just the pages. The rest of the page hardening (CSP) is
 *     mounted in `http/web.ts`, where it can be scoped to HTML responses.
 *  5. MCP, behind auth, for every method on `config.mcp.path`.
 *  6. health — open, no auth. An orchestrator probe has no credentials.
 *  7. `/api` — authenticated *inside* the router, GETs included.
 *  8. web pages and static assets.
 *  9. 404, then the error handler. Both must be last, in that order.
 *
 * ## Why `express.json()` is not global
 *
 * It used to be mounted here, above the MCP handler, which put it above every
 * auth check in the process. Body-parser buffers and `JSON.parse`s the whole
 * payload before the next middleware runs, so an *unauthenticated* client could
 * make the server allocate and parse up to `JSON_BODY_LIMIT` on any path — the
 * 401 was only written afterwards. That is a pre-auth memory and CPU
 * amplification primitive, and it applied to paths that take no body at all.
 *
 * The parser is therefore mounted per-route and always *after* the route's auth
 * middleware, so an unauthenticated request is rejected while its body is still
 * unread on the socket. Only two places read `req.body` — the MCP handler and
 * the `/api` router — and each mounts its own parser with the same limit.
 *
 * ## Why auth is constructed once
 *
 * `createMcpAuthMiddleware` owns the failed-attempt throttle, so building it
 * twice would give an attacker two independent budgets and let them double
 * their guess rate by alternating between `/mcp` and `/api`. One instance is
 * shared by both surfaces.
 *
 * ## Where the templates and assets come from
 *
 * `import.meta.dirname` is `<project>/src` when running from source under tsx
 * and `<project>/dist` when running the compiled build, so `views/` and
 * `public/` resolve correctly in both without a `NODE_ENV` branch.
 * `scripts/copy-assets.mjs` is what puts a copy of each under `dist/` after
 * `tsc` — if a template 500s in the production image, that script is the first
 * thing to check.
 *
 * ## What `shutdown()` owns
 *
 * ONLY the things this module created — which today means the MCP transport's
 * open sessions. It deliberately does NOT close the MongoDB connection or the
 * embedding provider: those are passed in, they outlive any single app
 * instance (tests build several against one connection), and `src/index.ts`
 * closes them in the right order after the HTTP server has stopped accepting.
 */
import { resolve } from 'node:path';

import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';

import type { AppConfig } from './config/env.js';
import type { MongoConnection } from './db/client.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import { createApiRouter } from './http/api.js';
import { createErrorHandler, notFoundHandler } from './http/errors.js';
import { createHealthRouter } from './http/health.js';
import { getRequestId, requestIdMiddleware } from './http/request-id.js';
import { createWebRouter } from './http/web.js';
import type { Logger } from './logger.js';
import { createMcpAuthMiddleware } from './mcp/auth.js';
import { createMcpHttpHandler } from './mcp/http.js';
import type { KnowledgeService } from './services/types.js';

/**
 * Ceiling on a request body.
 *
 * `MAX_CONTENT_CHARS` (5,000,000) caps the `content` field of one document at
 * the schema level. The JSON envelope around it is always bigger: multi-byte
 * UTF-8, plus JSON string escaping (a single `"` or newline becomes two bytes,
 * a control character becomes six), plus title/tags/metadata. 12mb clears a
 * full-size document with room to spare while still refusing an upload that
 * could never validate. The two limits are related on purpose — raising
 * `MAX_CONTENT_CHARS` without raising this one turns a clear 400 from zod into
 * a confusing 413 from body-parser.
 */
const JSON_BODY_LIMIT = '12mb';

/** How long a browser may reuse `/css/app.css`. It is not content-hashed. */
const STATIC_MAX_AGE_PROD = '1h';

export interface CreateAppDeps {
  config: AppConfig;
  logger: Logger;
  connection: MongoConnection;
  embeddings: EmbeddingProvider;
  service: KnowledgeService;
}

export interface AppBundle {
  app: Express;
  /** Closes only what the app itself opened. See the module docblock. */
  shutdown: () => Promise<void>;
}

export function createApp(deps: CreateAppDeps): AppBundle {
  const { config, logger, connection, embeddings, service } = deps;
  const app = express();

  // --- 1. framework-level settings ----------------------------------------
  app.disable('x-powered-by');
  app.set('trust proxy', config.runtime.trustProxy);
  // "simple" is `querystring.parse`: repeated keys become arrays, and `a[b]=c`
  // stays the literal key "a[b]" instead of materialising a nested object. The
  // API's coercion helpers expect strings and arrays, and a nested object is
  // one more shape that untrusted input could use to surprise a zod schema.
  app.set('query parser', 'simple');
  app.set('view engine', 'ejs');
  app.set('views', resolve(import.meta.dirname, 'views'));
  // Shared by every render, including the error page rendered for a request
  // that never reached the web router.
  app.locals.appName = config.mcp.serverName;
  app.locals.appVersion = config.mcp.serverVersion;
  app.locals.webEnabled = config.web.enabled;

  // --- 2. request identity -------------------------------------------------
  app.use(requestIdMiddleware());

  // --- 3. access logging ---------------------------------------------------
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => getRequestId(req),
      // Liveness is polled every few seconds forever and says nothing when it
      // succeeds. Readiness is demoted rather than dropped (see customLogLevel)
      // because a 503 there is genuinely interesting.
      autoLogging: { ignore: (req) => req.url?.startsWith('/healthz') === true },
      customLogLevel: (req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        if (req.url?.startsWith('/readyz') === true) return 'debug';
        return 'info';
      },
      // Raw request in, hand-picked fields out: no headers (the token lives in
      // one), and above all no body — ingested documents are megabytes of
      // third-party text and have no business in an access log.
      wrapSerializers: false,
      serializers: {
        req: (request: { method?: string; url?: string; socket?: { remoteAddress?: string } }) => ({
          method: request.method,
          url: request.url,
          remoteAddress: request.socket?.remoteAddress,
        }),
      },
    }),
  );

  // --- 4. global response hardening ---------------------------------------
  app.use((_req, res, next) => {
    // Applies to JSON too: a browser must never sniff an API response into
    // something executable.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Shared by `/mcp` and `/api` so the two surfaces cannot be played off
  // against each other for extra token guesses. See the module docblock.
  const requireAuth = createMcpAuthMiddleware(config.mcp, logger);

  // --- 5. MCP (Streamable HTTP) -------------------------------------------
  // `all`, not `post`: the transport uses GET for the SSE stream and DELETE to
  // end a session. Auth is mounted per-route rather than globally so the health
  // probes below stay reachable — and the body parser sits *after* auth, so an
  // unauthenticated POST is refused before its body is read.
  const mcp = createMcpHttpHandler({ service, config, logger });
  app.all(config.mcp.path, requireAuth, express.json({ limit: JSON_BODY_LIMIT }), mcp.handler);

  // --- 6. health probes (deliberately unauthenticated) --------------------
  // Docker's HEALTHCHECK and a Kubernetes kubelet cannot present a bearer
  // token, and the payloads carry no secrets — see `http/health.ts`.
  app.use(createHealthRouter({ config, logger, connection, embeddings }));

  // --- 7. REST API (authenticated inside the router, reads included) ------
  app.use(
    '/api',
    createApiRouter({ config, logger, service, requireAuth, bodyLimit: JSON_BODY_LIMIT }),
  );

  // --- 8. web UI + static assets ------------------------------------------
  if (config.web.enabled) {
    // The pages call `KnowledgeService` in-process; they never fetch `/api`,
    // which would require shipping the API token to the browser.
    app.use(createWebRouter({ config, logger, service }));
  }

  // Open like the health routes, and for the same reason: a stylesheet request
  // carries no credentials. The directory holds build output only — never
  // ingested content — so there is nothing here to authorise.
  app.use(
    express.static(resolve(import.meta.dirname, 'public'), {
      index: false,
      dotfiles: 'ignore',
      maxAge: config.runtime.isProduction ? STATIC_MAX_AGE_PROD : 0,
    }),
  );

  // --- 9. terminal handlers -----------------------------------------------
  app.use(notFoundHandler());
  app.use(createErrorHandler({ config, logger, bodyLimit: JSON_BODY_LIMIT }));

  return {
    app,
    shutdown: async () => {
      await mcp.closeAll();
    },
  };
}
