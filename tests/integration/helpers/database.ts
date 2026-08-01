/**
 * Test-database isolation for the integration suite.
 *
 * Every integration file runs against a database of its own, named
 * `ragkb_test_<random>` and *conflict-checked* against `listDatabases` before it
 * is used. Two things make that necessary rather than paranoid:
 *
 *  - CI and a developer's laptop can point at the same Atlas Local container, and
 *    two suites sharing a database would race on `dropDatabase` and on the search
 *    indexes, producing failures that look like product bugs.
 *  - A previous run that was killed mid-flight leaves its database behind. The
 *    `listDatabases` check is what stops a new run from adopting that debris.
 *
 * Honest caveat, because it matters for how much the check is worth: MongoDB does
 * not materialise a database until something is written to it, so this cannot
 * reserve a name against a *simultaneous* runner that has picked the same name
 * microseconds earlier. That case is handled by entropy — 40 bits of suffix — and
 * the listing handles the case entropy cannot: leftovers from earlier runs.
 */
import { randomBytes } from 'node:crypto';

import { MongoClient } from 'mongodb';

/** Shared by every test database so a stray one is obvious and easy to sweep. */
export const TEST_DB_PREFIX = 'ragkb_test_';

/** 5 bytes → 10 hex characters, well inside MongoDB's 63-character name limit. */
const SUFFIX_BYTES = 5;

/** Bounded, so an environment that somehow cannot yield a free name fails loudly. */
const MAX_NAME_ATTEMPTS = 12;

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * The connection string every integration test uses.
 *
 * Deliberately has no default: silently falling back to `localhost` would let a
 * misconfigured CI job "pass" against nothing at all.
 */
export function integrationMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri.trim().length === 0) {
    throw new Error(
      'MONGODB_URI is not set. The integration suite needs a running Atlas Local:\n' +
        '  docker start ragkb-atlas-dev || docker run -d --name ragkb-atlas-dev \\\n' +
        '    -p 27017:27017 mongodb/mongodb-atlas-local:8.0\n' +
        "then re-run with MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true'.",
    );
  }
  return uri;
}

/** A short-lived client used for name reservation and teardown sweeps. */
export async function connectAdminClient(uri = integrationMongoUri()): Promise<MongoClient> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    appName: 'ragkb-integration-tests',
  });
  await client.connect();
  return client;
}

async function listDatabaseNames(client: MongoClient): Promise<Set<string>> {
  const result = await client.db('admin').admin().listDatabases({ nameOnly: true });
  return new Set(result.databases.map((entry) => entry.name));
}

/**
 * Pick a database name that is provably not in use right now.
 *
 * The listing is re-read on every attempt rather than cached: the whole point is
 * to observe the current state of the server, and the call is cheap.
 */
export async function reserveDatabaseName(client: MongoClient): Promise<string> {
  const rejected: string[] = [];

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = `${TEST_DB_PREFIX}${randomBytes(SUFFIX_BYTES).toString('hex')}`;
    const taken = await listDatabaseNames(client);
    if (!taken.has(candidate)) return candidate;
    rejected.push(candidate);
  }

  throw new Error(
    `Could not reserve a free test database name after ${MAX_NAME_ATTEMPTS} attempts ` +
      `(tried ${rejected.join(', ')}). Something is creating "${TEST_DB_PREFIX}*" databases ` +
      'faster than this can pick one, or a previous run left hundreds behind.',
  );
}

/**
 * Drop a test database without ever masking the failure that is being reported.
 *
 * Teardown runs while a test may already be failing. If the drop itself throws,
 * rethrowing would replace the real assertion error with a cleanup error and
 * send whoever reads the output in the wrong direction. So the failure is
 * reported on stderr — naming the database so it can be swept by hand — and
 * swallowed.
 */
export async function dropDatabaseQuietly(client: MongoClient, name: string): Promise<boolean> {
  try {
    await client.db(name).dropDatabase();
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[integration] could not drop test database "${name}": ${reason}\n` +
        `  Sweep it manually:  mongosh --eval 'db.getSiblingDB("${name}").dropDatabase()'`,
    );
    return false;
  }
}
