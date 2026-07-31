/**
 * Process entrypoint. Fail fast on the way up, close cleanly on the way down.
 *
 * The startup order is not arbitrary — each step is a prerequisite of the next,
 * and each one is a place the process is allowed to die *before* it has told
 * anyone it is healthy:
 *
 *   config → logger → MongoDB → embedding provider → service → app → listen
 *
 * Configuration is validated first and, if it is wrong, reported as plain text
 * on stderr rather than a JSON log line. There is no logger yet at that point,
 * and the audience for "MCP_AUTH_TOKEN: must be at least 16 characters" is a
 * human staring at `docker logs`.
 *
 * ## Startup is allowed to succeed without a vector index
 *
 * A brand-new deployment has an empty database and no Atlas Search indexes; the
 * indexes are created by `npm run db:indexes`, which usually runs *after* the
 * container is up. Crashing on a missing index would make that impossible and
 * would put the container in a restart loop that no amount of retrying can fix.
 * So the check is a loud WARNING and nothing more.
 *
 * ## Ownership on shutdown
 *
 * This module opened the Mongo connection and the embedding provider, so this
 * module closes them. `AppBundle.shutdown()` closes only what the app itself
 * owns (live MCP sessions). The order matters: stop accepting connections, end
 * the MCP sessions holding streams open, wait for in-flight responses, then
 * tear down the resources those responses were using.
 */
import type { Server } from 'node:http';
import process from 'node:process';

import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { connectMongo, type MongoConnection } from './db/client.js';
import { COLLECTIONS } from './db/collections.js';
import { searchIndexIsQueryable } from './db/indexes.js';
import { createEmbeddingProvider } from './embeddings/factory.js';
import { describeError, isAppError } from './errors.js';
import { createLogger, logAppError, type Logger } from './logger.js';
import { createKnowledgeService } from './services/index.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger(config.logging);

  installProcessGuards(logger);

  logger.info(
    { event: 'startup.config', config: describeConfig(config) },
    `starting ${config.mcp.serverName} v${config.mcp.serverVersion} in ${config.runtime.nodeEnv} mode`,
  );

  const connection = await connectMongo(config.mongo, logger);
  const embeddings = createEmbeddingProvider(config.embedding, logger);
  const service = createKnowledgeService({ db: connection.db, embeddings, config, logger });
  const { app, shutdown } = createApp({ config, logger, connection, embeddings, service });

  const server = await listen(app.listen.bind(app), config, logger);

  installSignalHandlers({ config, logger, server, connection, embeddings, shutdown });

  // After `listen`, deliberately: the probe is a round trip to mongot and there
  // is no reason to delay accepting traffic (or a health check) behind it.
  await warnUnlessVectorIndexReady(connection, config, logger);
}

// ---------------------------------------------------------------------------
// Startup steps
// ---------------------------------------------------------------------------

/**
 * Validate the environment or die.
 *
 * `loadConfig` reports every problem at once, so one run of a misconfigured
 * container tells the operator about all of them instead of one per restart.
 */
function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    const message = isAppError(error) ? error.message : describeError(error);
    console.error(`\nFATAL: the server cannot start.\n\n${message}\n`);
    process.exit(1);
  }
}

/**
 * A redacted view of the resolved configuration.
 *
 * Logged once at startup because "which database am I actually pointed at?" is
 * the first question of most incidents. Secrets are reported as present/absent
 * and never by value — that includes the Mongo URI, which carries a password in
 * every non-trivial deployment.
 */
function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    runtime: {
      nodeEnv: config.runtime.nodeEnv,
      host: config.runtime.host,
      port: config.runtime.port,
      trustProxy: config.runtime.trustProxy,
      shutdownTimeoutMs: config.runtime.shutdownTimeoutMs,
      node: process.version,
    },
    logging: config.logging,
    mongo: {
      uri: 'set (redacted)',
      database: config.mongo.dbName,
      maxPoolSize: config.mongo.maxPoolSize,
      serverSelectionTimeoutMs: config.mongo.serverSelectionTimeoutMs,
      vectorIndexName: config.mongo.vectorIndexName,
      textIndexName: config.mongo.textIndexName,
      documentsTextIndexName: config.mongo.documentsTextIndexName,
    },
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      batchSize: config.embedding.batchSize,
      contextual: config.embedding.contextual,
      voyageBaseUrl: config.embedding.voyage.baseUrl,
      voyageApiKey: config.embedding.voyage.apiKey ? 'set' : 'not set',
    },
    chunking: config.chunking,
    mcp: {
      path: config.mcp.path,
      serverName: config.mcp.serverName,
      serverVersion: config.mcp.serverVersion,
      authToken: 'set',
      dnsRebindingProtection: config.mcp.dnsRebindingProtection,
      allowedHosts: config.mcp.allowedHosts,
      allowedOrigins: config.mcp.allowedOrigins,
    },
    search: config.search,
    web: config.web,
  };
}

type ListenFn = (port: number, host: string, callback: () => void) => Server;

/** Resolve once the socket is bound; reject on EADDRINUSE and friends. */
function listen(listenFn: ListenFn, config: AppConfig, logger: Logger): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = listenFn(config.runtime.port, config.runtime.host, () => {
      server.removeListener('error', reject);
      logger.info(
        {
          event: 'http.listening',
          host: config.runtime.host,
          port: config.runtime.port,
          mcpPath: config.mcp.path,
          webUi: config.web.enabled,
        },
        `listening on http://${config.runtime.host}:${config.runtime.port} (MCP at ${config.mcp.path})`,
      );
      resolve(server);
    });

    server.once('error', reject);
  });
}

/** Loud, non-fatal warning when `$vectorSearch` has nothing to search. */
async function warnUnlessVectorIndexReady(
  connection: MongoConnection,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const index = config.mongo.vectorIndexName;

  // `searchIndexIsQueryable` already swallows its own errors, but a probe must
  // not be able to take the process down under any circumstances.
  const queryable = await searchIndexIsQueryable(connection.db, COLLECTIONS.chunks, index).catch(
    () => false,
  );

  if (queryable) {
    logger.info(
      { event: 'index.ready', index, collection: COLLECTIONS.chunks },
      `vector index "${index}" is queryable`,
    );
    return;
  }

  logger.warn(
    { event: 'index.not_queryable', index, collection: COLLECTIONS.chunks },
    `WARNING: the vector index "${index}" on "${COLLECTIONS.chunks}" is missing or still building. ` +
      'Semantic search will return no results until it is queryable. ' +
      'Run "npm run db:indexes" to create it (an existing build just needs time). ' +
      'The server is running and /readyz will report not_ready until then.',
  );
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

interface ShutdownDeps {
  config: AppConfig;
  logger: Logger;
  server: Server;
  connection: MongoConnection;
  embeddings: { close: () => Promise<void> };
  /** `AppBundle.shutdown` — closes the MCP sessions the app owns. */
  shutdown: () => Promise<void>;
}

function installSignalHandlers(deps: ShutdownDeps): void {
  const { config, logger, server, connection, embeddings, shutdown } = deps;
  const timeoutMs = config.runtime.shutdownTimeoutMs;
  let shuttingDown = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second Ctrl-C means "I am not waiting". Honour it.
      logger.warn({ event: 'shutdown.forced', signal }, 'second signal — exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ event: 'shutdown.started', signal, timeoutMs }, `${signal} — shutting down`);

    const forceExit = setTimeout(() => {
      logger.fatal(
        { event: 'shutdown.timeout', timeoutMs },
        `graceful shutdown exceeded ${timeoutMs}ms — forcing exit`,
      );
      process.exit(1);
    }, timeoutMs);
    // The timer must never be the reason the process stays alive.
    forceExit.unref();

    void (async () => {
      try {
        // Stop accepting new connections immediately, but do not await the close
        // yet: an MCP client holding an SSE stream open would keep the server
        // from ever closing, so the sessions have to be ended first.
        const closed = closeServer(server);
        await shutdown();
        await closed;

        // Only now are there no requests left that could need these.
        await embeddings.close();
        await connection.close();

        clearTimeout(forceExit);
        logger.info({ event: 'shutdown.complete', signal }, 'shutdown complete');
        process.exit(0);
      } catch (error) {
        clearTimeout(forceExit);
        logAppError(logger, error, 'shutdown failed', { signal });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // `close()` alone waits for keep-alive sockets to go idle on their own; a
    // browser tab with an open connection would otherwise hold the process
    // until the force-exit timer fires.
    server.closeIdleConnections();
  });
}

/**
 * After either of these the process is in an unknown state — a half-finished
 * write, a lock never released — so it exits and lets the orchestrator start a
 * clean one. Logging first is best-effort: with a pino transport the write may
 * not flush before `exit`.
 */
function installProcessGuards(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logAppError(logger, reason, 'unhandled promise rejection — exiting', {
      event: 'process.unhandled_rejection',
    });
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logAppError(logger, error, 'uncaught exception — exiting', {
      event: 'process.uncaught_exception',
    });
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  // Anything that escapes `main` happened before the signal handlers existed.
  // The failing module has already logged the detail (see `connectMongo`); this
  // guarantees a terminal-readable line even if the logger was never built.
  console.error(`\nFATAL: startup failed.\n\n${describeError(error)}\n`);
  process.exit(1);
});
