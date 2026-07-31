/**
 * Vitest `setupFiles` entry for the integration project (see vitest.config.ts).
 *
 * Its only job is to turn the two ways this suite usually breaks — missing
 * environment, or an Atlas Local container that is not running — into a single
 * actionable message *before* any test starts. Without it, an unreachable
 * MongoDB shows up as six files each timing out after three minutes inside a
 * `beforeAll`, which tells you nothing about what to fix.
 *
 * The probe result is memoised on `globalThis` because the integration project
 * runs every file in one forked process (`singleFork`), so this module is
 * evaluated once per file and there is no reason to dial the server each time.
 */
import { MongoClient } from 'mongodb';

import { integrationMongoUri } from './helpers/database.js';

/** Long enough to survive a busy container, short enough to fail fast. */
const PROBE_TIMEOUT_MS = 10_000;

/** Minimum length `envSchema` enforces on MCP_AUTH_TOKEN. */
const MIN_TOKEN_CHARS = 16;

const START_ATLAS_LOCAL = [
  '  docker start ragkb-atlas-dev 2>/dev/null || \\',
  '    docker run -d --name ragkb-atlas-dev -p 27017:27017 mongodb/mongodb-atlas-local:8.0',
  '  until [ "$(docker inspect -f {{.State.Health.Status}} ragkb-atlas-dev)" = healthy ]; \\',
  '    do sleep 5; done',
].join('\n');

const HOW_TO_RUN = [
  'Run it the way CI does — a container on the host network, with every cache',
  'pinned inside the project:',
  '  docker run --rm --network host -u $(id -u):$(id -g) -v "$PWD":/app -w /app \\',
  '    -e HOME=/app/.container-home -e TMPDIR=/app/.container-home/tmp \\',
  '    -e MONGODB_URI=mongodb://127.0.0.1:27017/?directConnection=true \\',
  '    -e EMBEDDING_PROVIDER=fake -e MCP_AUTH_TOKEN=0123456789abcdef0123456789abcdef \\',
  '    node:24-slim npx vitest run --project integration',
].join('\n');

/** Strip any credentials before a URI reaches an error message or a log. */
function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/u, '//[redacted]@');
}

function requireEnv(): void {
  const missing: string[] = [];

  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri.trim().length === 0) {
    missing.push('MONGODB_URI — e.g. mongodb://127.0.0.1:27017/?directConnection=true');
  }

  const token = process.env.MCP_AUTH_TOKEN;
  if (token === undefined || token.length < MIN_TOKEN_CHARS) {
    missing.push(`MCP_AUTH_TOKEN — at least ${MIN_TOKEN_CHARS} characters`);
  }

  if (missing.length === 0) return;

  throw new Error(
    [
      'The integration suite is missing required environment:',
      ...missing.map((entry) => `  - ${entry}`),
      '',
      HOW_TO_RUN,
    ].join('\n'),
  );
}

/**
 * Confirm the server answers and is a replica set.
 *
 * The replica-set check is not incidental: Atlas Local runs one, a plain
 * `mongo:8` container does not, and that difference is exactly what makes
 * `mongot` (Atlas Search) and the transactional chunk swap work here. Catching
 * it now beats discovering it later as a baffling `$vectorSearch` failure.
 */
async function probeAtlasLocal(): Promise<void> {
  const uri = integrationMongoUri();
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: PROBE_TIMEOUT_MS,
    connectTimeoutMS: PROBE_TIMEOUT_MS,
    appName: 'ragkb-integration-preflight',
  });

  let notAReplicaSet = false;

  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    notAReplicaSet = typeof hello.setName !== 'string';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Cannot reach MongoDB at ${redactUri(uri)}: ${reason}`,
        '',
        'Start Atlas Local and wait for it to become healthy (first boot is 20-40s):',
        START_ATLAS_LOCAL,
        '',
        'If it is already running, remember that the default docker bridge network cannot',
        'reach the host — run vitest with `docker run --network host`.',
      ].join('\n'),
    );
  } finally {
    await client.close().catch(() => undefined);
  }

  if (notAReplicaSet) {
    throw new Error(
      [
        `MongoDB at ${redactUri(uri)} answered, but it is not a replica set.`,
        'This suite requires the mongodb/mongodb-atlas-local image: Atlas Search,',
        '$vectorSearch and the transactional chunk swap all depend on it, and a plain',
        '"mongo" image provides none of them.',
        START_ATLAS_LOCAL,
      ].join('\n'),
    );
  }
}

interface PreflightGlobal {
  __ragkbIntegrationPreflight__?: Promise<void>;
}

const scope = globalThis as typeof globalThis & PreflightGlobal;

requireEnv();
scope.__ragkbIntegrationPreflight__ ??= probeAtlasLocal();
await scope.__ragkbIntegrationPreflight__;
