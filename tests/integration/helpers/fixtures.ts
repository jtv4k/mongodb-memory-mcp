/**
 * Content fixtures for the integration suite.
 *
 * The embedding provider under test is a hashed bag-of-words embedder, so two
 * texts are close in vector space exactly when they share vocabulary. Every
 * fixture section below is therefore written with a *deliberately disjoint*
 * technical vocabulary — sharding terms appear only in the sharding section,
 * oplog terms only in the replication section, and so on. That is what makes an
 * assertion like "the replication chunk outranks the sharding chunk for an oplog
 * query" a measurement rather than a coin flip.
 *
 * The sections are also sized so that a `chunkSizeTokens` override of
 * {@link FIXTURE_CHUNK_SIZE_TOKENS} splits them apart instead of packing the
 * whole document into one chunk. Tests never hard-code a chunk count: they call
 * {@link expectedChunking}, which runs the same pure chunker the service runs.
 */
import { chunkContent } from '../../../src/chunking/index.js';
import type { AppConfig } from '../../../src/config/env.js';
import {
  parseInput,
  searchKnowledgeSchema,
  storeContentSchema,
  type SearchKnowledgeInput,
  type StoreContentInput,
} from '../../../src/domain/schemas.js';
import type { ChunkingResult, ContentType } from '../../../src/domain/types.js';

/**
 * Small enough that a four-section guide becomes several chunks, comfortably
 * above the 32-token floor at which the chunker merges a chunk into a neighbour.
 */
export const FIXTURE_CHUNK_SIZE_TOKENS = 80;
export const FIXTURE_CHUNK_OVERLAP_TOKENS = 12;

export interface Fixture {
  sourceId: string;
  title: string;
  uri: string;
  contentType: ContentType;
  tags: string[];
  content: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

const ATLAS_GUIDE_CONTENT = `# MongoDB Atlas Operations Guide

Operational notes for the teams who run this knowledge base in production.

## Sharding and the shard key

Sharding spreads documents horizontally across several shards, and the shard key
decides which shard owns any given document. The balancer moves ranges between
shards in the background so that no single shard accumulates more data than its
neighbours. A poorly chosen shard key produces a jumbo range that the balancer
cannot split, which pins writes to one shard forever. Queries that carry the
shard key are routed straight to the owning shard; queries without it are
broadcast to every shard and scale badly.

## Replica sets and the oplog

A replica set keeps its secondaries synchronised with the primary by continuously
tailing the oplog, an append-only capped collection of every write the primary
applied. When the primary becomes unreachable the remaining members hold an
election and one secondary is promoted. Writes issued with a majority write
concern are acknowledged only once enough members have replicated them, which is
what makes a rollback after a failover rare rather than routine.

## Aggregation pipeline stages

An aggregation pipeline transforms documents by passing them through an ordered
list of stages. A match stage filters early so that later stages see less data, a
group stage folds many documents into one accumulator result, and a project stage
reshapes the fields that survive. Stages that need more than the memory limit
spill to disk only when the caller opts in, so an unbounded grouping is a failure
rather than a silent slowdown.

## Vector search indexes

An MongoDB Vector Search index stores one dense embedding array per record and
compares them with cosine similarity. The declared dimension count must equal the
width of the vectors the model produces, or every similarity query fails. The
approximate nearest neighbour traversal examines a configurable number of
candidates before returning the closest matches, trading a little recall for a
large reduction in latency.
`;

const INCIDENT_RUNBOOK_CONTENT = `# Ingestion Incident Runbook

## Symptom: uploads are rejected

If an operator reports that uploads are being refused, start by reading the
gateway log for the affected tenant. A refusal that mentions a quota is a billing
problem and belongs to the accounts rota, not to the on-call engineer. A refusal
with no explanation at all is usually an expired credential on the upstream
appliance and is fixed by rotating it.

## Escalation ladder

Page the on-call engineer first, then the service owner if the alarm is still
open after twenty minutes, then the duty manager. Record every escalation in the
incident channel so that the post-mortem can reconstruct the timeline. Never
resolve an alarm without writing down what actually happened, even when the fix
was trivial and obvious.
`;

const PIPELINE_SNIPPET_CONTENT = `// Ranked retrieval helper used by the reporting job.
// Runs an aggregation pipeline that groups sales rows by region and quarter.

export function buildRegionalSalesPipeline(quarter) {
  return [
    { $match: { quarter, cancelled: false } },
    { $group: { _id: '$region', revenue: { $sum: '$amount' }, orders: { $sum: 1 } } },
    { $project: { region: '$_id', revenue: 1, orders: 1, _id: 0 } },
    { $sort: { revenue: -1 } },
  ];
}

export function summariseRegions(rows) {
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  return rows.map((row) => ({ ...row, share: total === 0 ? 0 : row.revenue / total }));
}
`;

export const ATLAS_GUIDE: Fixture = {
  sourceId: 'guides/mongodb-atlas-operations',
  title: 'MongoDB Atlas Operations Guide',
  uri: 'https://example.test/guides/mongodb-atlas-operations',
  contentType: 'markdown',
  tags: ['mongodb', 'atlas', 'guide'],
  content: ATLAS_GUIDE_CONTENT,
  metadata: { owner: 'platform-team', reviewed: '2026-02-01' },
};

export const INCIDENT_RUNBOOK: Fixture = {
  sourceId: 'runbooks/ingestion-incidents',
  title: 'Ingestion Incident Runbook',
  uri: 'https://example.test/runbooks/ingestion-incidents',
  contentType: 'markdown',
  tags: ['runbook', 'ops'],
  content: INCIDENT_RUNBOOK_CONTENT,
};

export const PIPELINE_SNIPPET: Fixture = {
  sourceId: 'snippets/regional-sales-pipeline',
  title: 'Regional sales pipeline helper',
  uri: 'https://example.test/snippets/regional-sales-pipeline.js',
  contentType: 'code',
  tags: ['code', 'javascript'],
  content: PIPELINE_SNIPPET_CONTENT,
};

export const ALL_FIXTURES: readonly Fixture[] = [ATLAS_GUIDE, INCIDENT_RUNBOOK, PIPELINE_SNIPPET];

// ---------------------------------------------------------------------------
// Queries whose expected winner is unambiguous given the vocabularies above
// ---------------------------------------------------------------------------

export const QUERIES = {
  /** Hits the "Replica sets and the oplog" section and nothing else. */
  oplog: 'how does a secondary tail the oplog after an election promotes a new primary',
  /** Hits the "Sharding and the shard key" section. */
  sharding: 'which shard owns a document and how does the balancer move ranges between shards',
  /** Hits the "Vector search indexes" section. */
  vectorIndex: 'cosine similarity over a dense embedding array with a declared dimension count',
  /** Hits the runbook, not the guide. */
  escalation: 'who do I page first and when do I escalate to the duty manager',
  /** Hits the code snippet: shares its vocabulary and almost nothing else. */
  regionalSales: 'group sales rows by region and quarter to compute revenue share',
} as const;

// ---------------------------------------------------------------------------
// Input builders — everything goes through the real zod schemas
// ---------------------------------------------------------------------------

export interface StoreOverrides {
  sourceId?: string;
  title?: string;
  uri?: string;
  contentType?: ContentType;
  tags?: string[];
  content?: string;
  metadata?: Record<string, unknown>;
  chunkSizeTokens?: number;
  chunkOverlapTokens?: number;
  agent?: string;
  sessionId?: string;
}

/**
 * Build a `store_content` payload the same way a transport would: through
 * `parseInput`, so defaults, tag normalisation and metadata guards all apply.
 */
export function storeInput(fixture: Fixture, overrides: StoreOverrides = {}): StoreContentInput {
  return parseInput(
    storeContentSchema,
    {
      content: fixture.content,
      title: fixture.title,
      sourceId: fixture.sourceId,
      uri: fixture.uri,
      contentType: fixture.contentType,
      tags: fixture.tags,
      metadata: fixture.metadata ?? {},
      chunkSizeTokens: FIXTURE_CHUNK_SIZE_TOKENS,
      chunkOverlapTokens: FIXTURE_CHUNK_OVERLAP_TOKENS,
      ...overrides,
    },
    'store_content',
  );
}

/** Build a `search_knowledge` payload through the real schema. */
export function searchInput(
  query: string,
  overrides: Partial<Record<string, unknown>> = {},
): SearchKnowledgeInput {
  return parseInput(searchKnowledgeSchema, { query, ...overrides }, 'search_knowledge');
}

/**
 * What the pure chunker produces for a payload.
 *
 * Mirrors `resolveChunkingOptions` in the service so a test can assert the
 * service chunked with the options it was given, without hard-coding a count
 * that would need editing every time a fixture gains a sentence.
 */
export function expectedChunking(input: StoreContentInput, config: AppConfig): ChunkingResult {
  const chunkSizeTokens = input.chunkSizeTokens ?? config.chunking.chunkSizeTokens;
  return chunkContent({
    content: input.content,
    contentType: input.contentType,
    options: {
      chunkSizeTokens,
      chunkOverlapTokens: Math.min(
        input.chunkOverlapTokens ?? config.chunking.chunkOverlapTokens,
        chunkSizeTokens - 1,
      ),
      minChunkTokens: Math.min(config.chunking.minChunkTokens, chunkSizeTokens),
    },
  });
}
