/**
 * MongoDB connection lifecycle.
 *
 * The same code path serves cloud Atlas and Atlas Local (the
 * `mongodb/mongodb-atlas-local` image) — only `MONGODB_URI` differs. Atlas Local
 * runs a single-node replica set with Vector Search and Atlas Search enabled, so
 * index definitions and `$vectorSearch` pipelines behave identically in dev, CI
 * and production.
 */
import { MongoClient, type Db } from 'mongodb';

import type { MongoConfig } from '../config/env.js';
import { StorageError } from '../errors.js';
import { logAppError, type Logger } from '../logger.js';

export interface MongoConnection {
  client: MongoClient;
  db: Db;
  close: () => Promise<void>;
}

export function createMongoClient(cfg: MongoConfig): MongoClient {
  return new MongoClient(cfg.uri, {
    maxPoolSize: cfg.maxPoolSize,
    serverSelectionTimeoutMS: cfg.serverSelectionTimeoutMs,
    // Retryable writes are the default, but be explicit: ingestion must survive
    // a replica-set election mid-write rather than surfacing a spurious failure.
    retryWrites: true,
    retryReads: true,
    appName: 'mongodb-rag-kb-mcp',
  });
}

/** Connect and verify the server actually answers before returning. */
export async function connectMongo(cfg: MongoConfig, logger: Logger): Promise<MongoConnection> {
  const client = createMongoClient(cfg);

  try {
    await client.connect();
    const db = client.db(cfg.dbName);
    await db.command({ ping: 1 });

    logger.info(
      { event: 'mongo.connected', database: cfg.dbName, maxPoolSize: cfg.maxPoolSize },
      'connected to MongoDB',
    );

    return {
      client,
      db,
      close: async () => {
        await client.close();
        logger.info({ event: 'mongo.closed' }, 'closed MongoDB connection');
      },
    };
  } catch (cause) {
    await client.close().catch(() => undefined);
    const error = new StorageError(`Could not connect to MongoDB database "${cfg.dbName}"`, {
      cause,
      details: { database: cfg.dbName },
    });
    logAppError(logger, error, 'MongoDB connection failed');
    throw error;
  }
}

/** Cheap liveness probe used by the readiness endpoint. */
export async function pingMongo(db: Db): Promise<boolean> {
  try {
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
