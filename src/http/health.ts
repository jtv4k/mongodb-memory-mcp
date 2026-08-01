/**
 * Liveness and readiness probes.
 *
 * These two endpoints answer different questions and must never be merged:
 *
 *  - `/healthz` (liveness) — "is this process still a process?" It touches no
 *    dependency and always answers 200 while the event loop turns. The Docker
 *    HEALTHCHECK and any container-restart policy point here, so a MongoDB blip
 *    or a still-building search index must NOT be able to get the container
 *    killed and restarted into the exact same broken world.
 *
 *  - `/readyz` (readiness) — "should a load balancer send me traffic?" It pings
 *    MongoDB and checks that the vector index is queryable, and answers 503 with
 *    the same JSON breakdown when either is false. Failing this only removes the
 *    instance from rotation.
 *
 * Both are mounted unauthenticated (see `src/app.ts`): an orchestrator probe has
 * no credentials, and the payload is deliberately free of anything sensitive —
 * notably the MongoDB URI, which carries the password. The database *name* is
 * included because it is the single most useful thing when an instance is
 * pointed at the wrong environment.
 */
import { Router } from 'express';

import type { AppConfig } from '../config/env.js';
import { pingMongo } from '../db/client.js';
import { COLLECTIONS } from '../db/collections.js';
import { searchIndexIsQueryable } from '../db/indexes.js';
import type { MongoConnection } from '../db/client.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { Logger } from '../logger.js';

/**
 * How long a vector-index probe is reused. Readiness is polled every few
 * seconds by every orchestrator in the stack; `listSearchIndexes` is a real
 * round trip to mongot, and the answer changes at most once per deploy.
 */
const INDEX_PROBE_TTL_MS = 5_000;

export interface HealthDeps {
  config: AppConfig;
  logger: Logger;
  connection: MongoConnection;
  /**
   * Reported verbatim in both payloads. The *provider's* view of the model is
   * used rather than the config's: they can legitimately differ (a provider may
   * normalise a model alias), and an operator debugging a dimension mismatch
   * needs the number the vectors were actually written with.
   */
  embeddings: EmbeddingProvider;
}

interface CheckResult {
  ok: boolean;
  detail: string;
}

export function createHealthRouter(deps: HealthDeps): Router {
  const { config, connection, embeddings } = deps;
  const router = Router();
  const startedAt = Date.now();

  let indexProbe: { at: number; result: CheckResult } | null = null;

  const identity = () => ({
    name: config.mcp.serverName,
    version: config.mcp.serverVersion,
    nodeEnv: config.runtime.nodeEnv,
    uptimeSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    embedding: {
      provider: embeddings.info.provider,
      model: embeddings.info.model,
      dimensions: embeddings.info.dimensions,
    },
  });

  async function checkVectorIndex(): Promise<CheckResult> {
    if (indexProbe && Date.now() - indexProbe.at < INDEX_PROBE_TTL_MS) return indexProbe.result;

    const queryable = await searchIndexIsQueryable(
      connection.db,
      COLLECTIONS.chunks,
      config.mongo.vectorIndexName,
    );
    const result: CheckResult = {
      ok: queryable,
      detail: queryable
        ? `"${config.mongo.vectorIndexName}" is queryable`
        : `"${config.mongo.vectorIndexName}" is missing or still building — run "npm run db:indexes"`,
    };

    indexProbe = { at: Date.now(), result };
    return result;
  }

  // Liveness. No awaits on anything external, on purpose.
  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', ...identity() });
  });

  router.get('/readyz', (_req, res, next) => {
    void (async () => {
      try {
        const [mongoOk, vectorIndex] = await Promise.all([
          pingMongo(connection.db),
          checkVectorIndex(),
        ]);

        const checks = {
          mongo: {
            ok: mongoOk,
            detail: mongoOk ? 'ping succeeded' : 'ping failed',
            database: config.mongo.dbName,
          },
          vectorIndex: {
            ...vectorIndex,
            name: config.mongo.vectorIndexName,
            collection: COLLECTIONS.chunks,
          },
        };

        const ready = mongoOk && vectorIndex.ok;
        res.status(ready ? 200 : 503).json({
          status: ready ? 'ready' : 'not_ready',
          ...identity(),
          checks,
        });
      } catch (error) {
        next(error);
      }
    })();
  });

  return router;
}
