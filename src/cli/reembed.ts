/**
 * `npm run db:reembed` — re-embed chunks whose vectors came from a different
 * model or a different width than the one currently configured.
 *
 * This is the operational half of the re-embedding strategy the spec requires.
 * Every chunk records `embeddingProvider` / `embeddingModel` /
 * `embeddingDimensions`, so changing `EMBEDDING_MODEL` never orphans data — it
 * just makes the existing vectors *stale*, and this command walks them forward.
 *
 * A run is independent and resumable: the stale set is recomputed from
 * provenance each time rather than tracked in a cursor, so a crashed or
 * deliberately capped run is safely re-runnable. That is what makes
 * `--max-documents` a sensible way to backfill a large corpus in bites.
 *
 * Search stays correct while a backfill is in flight because queries are
 * constrained to the configured model — half-migrated chunks are invisible
 * rather than wrong. See `.claude/skills/embedding-model-migration/SKILL.md`.
 *
 * Exit codes are the contract for automation: 0 means nothing is stale any more
 * (or, under --dry-run, that the plan was reported); 1 means a human is needed.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { loadConfig } from '../config/env.js';
import { connectMongo } from '../db/client.js';
import { parseInput, reembedSchema } from '../domain/schemas.js';
import type { EmbeddingCoverage, ReembedResult } from '../domain/types.js';
import { createEmbeddingProvider } from '../embeddings/factory.js';
import { describeError } from '../errors.js';
import { createKnowledgeService } from '../services/index.js';
import type { RequestContext } from '../services/types.js';
import { createLogger, logAppError, type Logger } from '../logger.js';

const USAGE = `
Usage: npm run db:reembed -- [options]

Re-embeds every chunk whose embeddingModel or embeddingDimensions differs from
the currently configured model, grouped by parent document so the contextual
model sees whole documents in chunk order.

Options:
  --dry-run                  Report how much is stale and what would be touched.
                             Reads only; writes nothing.
  --max-documents <n>        Cap the documents processed in this run. Re-run until
                             "stale chunks" reaches 0. Useful for large corpora.
  --source-ids <a,b,c>       Restrict the run to these sourceIds (up to 1000).
  --target-model <name>      Defaults to EMBEDDING_MODEL. Must match it — the
                             provider in this process is what produces vectors.
  --target-dimensions <n>    Defaults to EMBEDDING_DIMENSIONS.
  -h, --help                 Show this message.

The vector index numDimensions must already equal the target width. If the width
changed, recreate the index BEFORE running this — see the
vector-index-management skill.
`.trim();

/** Module-scoped so the top-level failure handler can log through it. */
let logger: Logger | null = null;

/** A bad flag deserves the usage text; a failed backfill deserves the stack. */
function isUsageError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS');
}

function positiveInteger(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed;
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

/**
 * Coverage is the number an operator actually steers by: more than one row means
 * the corpus is mid-migration, and the backfill is done when only the target
 * model remains.
 */
function printCoverage(title: string, coverage: EmbeddingCoverage[]): void {
  console.log(`\n${title}`);
  if (coverage.length === 0) {
    console.log('  (no chunks stored)');
    return;
  }
  printTable([
    ['PROVIDER', 'MODEL', 'DIMS', 'CHUNKS', 'DOCUMENTS'],
    ...coverage.map((row) => [
      row.provider,
      row.model,
      String(row.dimensions),
      String(row.chunkCount),
      String(row.documentCount),
    ]),
  ]);
}

function printResult(result: ReembedResult): void {
  console.log(`\n${result.dryRun ? 'Planned (nothing was written):' : 'Backfill complete:'}`);
  printTable([
    ['stale chunks found', String(result.staleChunks)],
    ['documents processed', String(result.documentsProcessed)],
    ['chunks re-embedded', String(result.chunksReembedded)],
    ['chunks failed', String(result.chunksFailed)],
    ['tokens embedded', String(result.totalTokensEmbedded)],
    ['target', `${result.targetModel} @ ${result.targetDimensions} dimensions`],
    ['took', `${result.tookMs}ms`],
  ]);
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'max-documents': { type: 'string' },
      'source-ids': { type: 'string' },
      'target-model': { type: 'string' },
      'target-dimensions': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }

  const config = loadConfig();
  logger = createLogger(config.logging);

  // Validate through the same schema the MCP/REST surfaces use, so the CLI can
  // never construct an input the service would reject.
  const input = parseInput(
    reembedSchema,
    {
      dryRun: values['dry-run'] === true,
      ...(values['max-documents'] !== undefined && {
        maxDocuments: positiveInteger(values['max-documents'], '--max-documents'),
      }),
      ...(values['source-ids'] !== undefined && {
        sourceIds: values['source-ids']
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      }),
      ...(values['target-model'] !== undefined && { targetModel: values['target-model'] }),
      ...(values['target-dimensions'] !== undefined && {
        targetDimensions: positiveInteger(values['target-dimensions'], '--target-dimensions'),
      }),
    },
    'db:reembed options',
  );

  console.log(`database:   ${config.mongo.dbName}`);
  console.log(`provider:   ${config.embedding.provider}`);
  console.log(
    `target:     ${input.targetModel ?? config.embedding.model} @ ${
      input.targetDimensions ?? config.embedding.dimensions
    } dimensions`,
  );
  console.log(`mode:       ${input.dryRun ? 'dry run (no writes)' : 'apply'}`);
  if (input.maxDocuments !== undefined) console.log(`limit:      ${input.maxDocuments} documents`);
  if (input.sourceIds !== undefined) console.log(`sources:    ${input.sourceIds.join(', ')}`);

  const connection = await connectMongo(config.mongo, logger);
  const embeddings = createEmbeddingProvider(config.embedding, logger);
  const service = createKnowledgeService({
    db: connection.db,
    embeddings,
    config,
    logger,
  });

  const ctx: RequestContext = {
    channel: 'cli',
    requestId: randomUUID(),
    logger: logger.child({ requestId: 'db:reembed' }),
  };

  try {
    printCoverage('Coverage before:', await service.embeddingCoverage(ctx));

    const result = await service.reembed(input, ctx);
    printResult(result);

    if (!input.dryRun) {
      printCoverage('Coverage after:', await service.embeddingCoverage(ctx));
    }

    if (result.chunksFailed > 0) {
      // The service deliberately continues past a failing document so one bad
      // record cannot abort a long backfill — but the run is not clean, and an
      // automated caller must be able to tell.
      console.error(
        `\n${result.chunksFailed} chunk(s) failed to re-embed. They remain on their old vectors; re-run to retry just those.`,
      );
      return 1;
    }

    if (!input.dryRun && result.staleChunks > result.chunksReembedded) {
      console.log(
        `\n${result.staleChunks - result.chunksReembedded} stale chunk(s) were not reached in this run (--max-documents). Re-run to continue.`,
      );
    }

    return 0;
  } finally {
    await embeddings.close();
    await connection.close();
  }
}

/** stdout is an async pipe under CI; drain it before hard-exiting. */
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
  logAppError(logger ?? createLogger({ level: 'info', pretty: false }), error, 'reembed failed');
  console.error(`\nreembed FAILED: ${describeError(error)}`);
  if (isUsageError(error)) console.error(`\n${USAGE}`);
  return 1;
});

// Explicit exit: the Mongo driver's monitoring sockets and pino's transport
// worker both keep the event loop alive, and a backfill that hangs in CI is
// worse than one that fails.
await flushStdio();
process.exit(exitCode);
