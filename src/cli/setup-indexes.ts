/**
 * `npm run db:indexes` — apply every index definition to the target database.
 *
 * This is the migration entrypoint: index definitions are code,
 * and this script is how they reach a server. It is the same command for Atlas
 * Local, CI and cloud Atlas — only MONGODB_URI differs — so nobody ever has to
 * click an index together in the Atlas UI and hope it matches.
 *
 * Exit codes are the contract for CI: 0 means every index exists and (unless
 * --no-wait) is queryable; 1 means something needs a human.
 */
import { parseArgs } from 'node:util';

import { loadConfig } from '../config/env.js';
import { connectMongo } from '../db/client.js';
import {
  CHECKED_IN_VECTOR_DIMENSIONS,
  ensureIndexes,
  planIndexes,
  type IndexPlanEntry,
  type IndexSetupResult,
} from '../db/indexes.js';
import { describeError } from '../errors.js';
import { createLogger, logAppError, type Logger } from '../logger.js';

interface CliOptions {
  dryRun: boolean;
  wait: boolean;
  timeoutMs: number | null;
  help: boolean;
}

const USAGE = `
Usage: npm run db:indexes -- [options]

Applies the standard, MongoDB Search and Vector Search index definitions in
src/db/index-definitions/ to the database named by MONGODB_DB_NAME.

Options:
  --dry-run          Report what would change. Reads the server, writes nothing.
  --wait             Wait for search indexes to become queryable (default).
  --no-wait          Return as soon as the definitions are submitted.
  --timeout <ms>     Override MONGODB_INDEX_READY_TIMEOUT_MS for this run.
  -h, --help         Show this message.
`.trim();

/** Kept module-scoped so the top-level failure handler can log through it. */
let logger: Logger | null = null;

/** A bad flag deserves the usage text; a failed migration deserves the stack. */
function isUsageError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS');
}

function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean', default: false },
      wait: { type: 'boolean', default: true },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  let timeoutMs: number | null = null;
  if (values.timeout !== undefined) {
    const parsed = Number(values.timeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new TypeError(
        `--timeout must be a positive integer number of milliseconds, got "${values.timeout}"`,
      );
    }
    timeoutMs = parsed;
  }

  return {
    dryRun: values['dry-run'] === true,
    wait: values.wait !== false,
    timeoutMs,
    help: values.help === true,
  };
}

function printTable(rows: string[][]): void {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    );
  }
}

function printEntries(title: string, entries: IndexPlanEntry[]): void {
  console.log(`\n${title}`);
  printTable([
    ['KIND', 'COLLECTION', 'NAME', 'ACTION', 'QUERYABLE'],
    ...entries.map((entry) => [
      entry.kind,
      entry.collection,
      entry.name,
      entry.action,
      entry.queryable ? 'yes' : 'no',
    ]),
  ]);

  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const entry of entries) counts[entry.action] += 1;
  console.log(
    `\n${entries.length} indexes: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged.`,
  );
}

/** Merge the read-only plan (which knows the standard-index actions) with the applied result. */
function mergeApplied(plan: IndexPlanEntry[], result: IndexSetupResult): IndexPlanEntry[] {
  const standard = plan
    .filter((entry) => entry.kind === 'standard')
    .map((entry) => ({ ...entry, queryable: result.standard.includes(entry.name) }));

  const search = result.search.map((outcome) => ({
    name: outcome.name,
    collection: outcome.collection,
    kind: outcome.type,
    action: outcome.action,
    queryable: outcome.queryable,
  }));

  return [...standard, ...search];
}

async function main(argv: string[]): Promise<number> {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const config = loadConfig();
  logger = createLogger(config.logging);
  const timeoutMs = options.timeoutMs ?? config.mongo.indexReadyTimeoutMs;

  console.log(`database:   ${config.mongo.dbName}`);
  console.log(`embedding:  ${config.embedding.model} @ ${config.embedding.dimensions} dimensions`);
  console.log(
    `indexes:    ${config.mongo.vectorIndexName}, ${config.mongo.textIndexName}, ${config.mongo.documentsTextIndexName}`,
  );
  console.log(`mode:       ${options.dryRun ? 'dry run (no writes)' : 'apply'}`);
  if (config.embedding.dimensions !== CHECKED_IN_VECTOR_DIMENSIONS) {
    // ensureIndexes logs this too, but a dry run must say it out loud as well:
    // changing the vector dimension is the one change that needs a re-embed.
    console.log(
      `warning:    numDimensions ${CHECKED_IN_VECTOR_DIMENSIONS} in chunks.vector.json is overridden by EMBEDDING_DIMENSIONS=${config.embedding.dimensions}`,
    );
  }
  if (!options.dryRun) {
    console.log(`readiness:  ${options.wait ? `wait up to ${timeoutMs}ms` : 'do not wait'}`);
  }

  const connection = await connectMongo(config.mongo, logger);

  try {
    const plan = await planIndexes(connection.db, config, logger);

    if (options.dryRun) {
      printEntries('Planned changes (nothing was written):', plan);
      return 0;
    }

    const result = await ensureIndexes(connection.db, config, logger, {
      waitForQueryable: options.wait,
      timeoutMs,
    });

    const applied = mergeApplied(plan, result);
    printEntries('Applied:', applied);

    const notQueryable = result.search.filter((outcome) => !outcome.queryable);
    if (options.wait && notQueryable.length > 0) {
      console.error(
        `\n${notQueryable.length} search index(es) were still building after ${timeoutMs}ms: ${notQueryable
          .map((outcome) => outcome.name)
          .join(', ')}. They will finish on their own; re-run this command to confirm.`,
      );
      return 1;
    }

    return 0;
  } finally {
    await connection.close();
  }
}

/** stdout is an async pipe when this runs in CI; drain it before hard-exiting. */
async function flushStdio(): Promise<void> {
  for (const stream of [process.stdout, process.stderr]) {
    await new Promise<void>((resolve) => {
      stream.write('', () => {
        resolve();
      });
    });
  }
}

const exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  logAppError(
    logger ?? createLogger({ level: 'info', pretty: false }),
    error,
    'index setup failed',
  );
  console.error(`\nindex setup FAILED: ${describeError(error)}`);
  if (isUsageError(error)) console.error(`\n${USAGE}`);
  return 1;
});

// Explicit exit: the MongoDB driver's monitoring sockets and pino's transport
// worker both keep the event loop alive, and a migration step that hangs in CI
// is worse than one that fails.
await flushStdio();
process.exit(exitCode);
