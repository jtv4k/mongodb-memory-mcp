/**
 * Index management: every index this app needs, applied as code.
 *
 * The spec forbids creating indexes by hand in the Atlas UI. The canonical Atlas
 * Search / Vector Search definitions live in `./index-definitions/*.json` and this
 * module is the only thing that applies them, so Atlas Local, CI and cloud Atlas
 * all converge on the same shape from the same source of truth.
 *
 * Three properties matter more than anything else here:
 *  - IDEMPOTENT: `npm run db:indexes` is a migration that is safe on every deploy.
 *  - DRIFT-AWARE: an index whose server-side definition no longer matches the JSON
 *    gets updated rather than silently tolerated — but "matches" has to tolerate
 *    the defaults the server adds back, or every run would flap between
 *    "unchanged" and "updated" forever.
 *  - NEVER DESTRUCTIVE: the changes a deployment cannot apply in place — chiefly
 *    numDimensions/similarity on a vector index, and on Atlas Local 8.0 *any*
 *    vector index update — stop the run with instructions instead of dropping a
 *    production index and stranding every vector already stored.
 */
import type { Db, Document, IndexDescription } from 'mongodb';

import type { AppConfig } from '../config/env.js';
import { describeError, IndexError, StorageError } from '../errors.js';
import type { Logger } from '../logger.js';
import { COLLECTIONS } from './collections.js';

import chunksTextJson from './index-definitions/chunks.text.json' with { type: 'json' };
import chunksVectorJson from './index-definitions/chunks.vector.json' with { type: 'json' };
import documentsTextJson from './index-definitions/documents.text.json' with { type: 'json' };

/** How often {@link waitForSearchIndex} re-checks a building index. */
const POLL_INTERVAL_MS = 2_000;

/** Server error codes we treat as "the namespace simply is not there yet". */
const NAMESPACE_NOT_FOUND = 26;
const NAMESPACE_EXISTS = 48;

/**
 * Codes a deployment without mongot answers with. Atlas Local and cloud Atlas
 * both support search indexes; a plain `mongo:8` container does not, and the raw
 * driver error ("Unrecognized pipeline stage name") sends people down the wrong
 * rabbit hole entirely.
 */
const SEARCH_UNSUPPORTED_CODES = new Set([59, 115, 40324]);

// ---------------------------------------------------------------------------
// Definitions loaded from the canonical JSON
// ---------------------------------------------------------------------------

export type VectorFieldDefinition = {
  type: 'vector';
  path: string;
  numDimensions: number;
  similarity: string;
  quantization?: string;
};

export type VectorFilterDefinition = { type: 'filter'; path: string };

export type VectorIndexDefinition = {
  fields: Array<VectorFieldDefinition | VectorFilterDefinition>;
};

/**
 * The JSON files carry a `$comment` key for whoever opens them next. Atlas
 * rejects unknown top-level keys in an index definition, so it must be stripped
 * before the definition ever reaches the server — recursively, so a future
 * comment nested inside a field mapping cannot break a deploy either.
 */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripComments(entry));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$comment') continue;
      out[key] = stripComments(entry);
    }
    return out;
  }
  return value;
}

function asDefinition(raw: unknown, file: string): Document {
  const cleaned = stripComments(raw);
  if (!isPlainObject(cleaned)) {
    throw new IndexError(`Index definition ${file} must be a JSON object`, { details: { file } });
  }
  return cleaned;
}

/** The vector index exactly as checked in, minus `$comment`. `numDimensions` is a placeholder. */
export const CHUNKS_VECTOR_BASE_DEFINITION = asDefinition(
  chunksVectorJson,
  'chunks.vector.json',
) as VectorIndexDefinition;

/** Full-text index for `chunks` — the keyword half of hybrid search. */
export const CHUNKS_TEXT_DEFINITION = asDefinition(chunksTextJson, 'chunks.text.json');

/** Full-text index for `documents` — the browse/list view and `list_sources`. */
export const DOCUMENTS_TEXT_DEFINITION = asDefinition(documentsTextJson, 'documents.text.json');

function vectorFieldOf(definition: unknown): VectorFieldDefinition | null {
  if (!isPlainObject(definition) || !Array.isArray(definition.fields)) return null;
  for (const field of definition.fields) {
    if (isPlainObject(field) && field.type === 'vector') return field as VectorFieldDefinition;
  }
  return null;
}

/** `numDimensions` as committed to git — used only to detect a config override. */
export const CHECKED_IN_VECTOR_DIMENSIONS: number = (() => {
  const field = vectorFieldOf(CHUNKS_VECTOR_BASE_DEFINITION);
  if (!field) {
    throw new IndexError('chunks.vector.json declares no field of type "vector"');
  }
  return field.numDimensions;
})();

/**
 * The vector definition with `numDimensions` taken from configuration.
 *
 * The JSON holds the shipped default (voyage-context-3 @ 1024) but the index must
 * always match `EMBEDDING_DIMENSIONS`, otherwise the first `$vectorSearch` fails
 * with a dimension mismatch that looks like a data problem instead of a config one.
 */
export function buildVectorIndexDefinition(config: AppConfig): VectorIndexDefinition {
  const definition = structuredClone(CHUNKS_VECTOR_BASE_DEFINITION);
  const field = vectorFieldOf(definition);
  if (!field) {
    throw new IndexError('chunks.vector.json declares no field of type "vector"');
  }
  field.numDimensions = config.embedding.dimensions;
  return definition;
}

export interface DesiredSearchIndex {
  name: string;
  collection: string;
  type: 'search' | 'vectorSearch';
  definition: Document;
}

/** Every search index this app owns, resolved against the current config. */
export function desiredSearchIndexes(config: AppConfig): DesiredSearchIndex[] {
  return [
    {
      name: config.mongo.vectorIndexName,
      collection: COLLECTIONS.chunks,
      type: 'vectorSearch',
      definition: buildVectorIndexDefinition(config),
    },
    {
      name: config.mongo.textIndexName,
      collection: COLLECTIONS.chunks,
      type: 'search',
      definition: structuredClone(CHUNKS_TEXT_DEFINITION),
    },
    {
      name: config.mongo.documentsTextIndexName,
      collection: COLLECTIONS.documents,
      type: 'search',
      definition: structuredClone(DOCUMENTS_TEXT_DEFINITION),
    },
  ];
}

// ---------------------------------------------------------------------------
// Standard (b-tree) indexes
// ---------------------------------------------------------------------------

export interface StandardIndexSpec {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  /** The query this index exists to serve. If nothing runs it, delete it. */
  why: string;
}

/**
 * Names are explicit (never Mongo's generated `sourceId_1`) so drift is legible
 * in `listIndexes` output and so this file is the only place they are spelled.
 */
export const STANDARD_INDEXES: readonly StandardIndexSpec[] = [
  {
    collection: COLLECTIONS.documents,
    name: 'documents_sourceId_unique',
    key: { sourceId: 1 },
    unique: true,
    why: 'store_content upserts by sourceId; uniqueness is the guarantee that re-ingest versions a document instead of duplicating it',
  },
  {
    collection: COLLECTIONS.documents,
    name: 'documents_contentHash',
    key: { contentHash: 1 },
    why: 'idempotent re-ingest: "have we already stored exactly this content?" before chunking and embedding',
  },
  {
    collection: COLLECTIONS.documents,
    name: 'documents_tags',
    key: { tags: 1 },
    why: 'multikey index for tag filters in list_sources and the browse view',
  },
  {
    collection: COLLECTIONS.documents,
    name: 'documents_updatedAt_desc',
    key: { updatedAt: -1 },
    why: 'default browse ordering (newest first) and the list_documents pagination sort',
  },
  {
    collection: COLLECTIONS.documents,
    name: 'documents_contentType_updatedAt',
    key: { contentType: 1, updatedAt: -1 },
    why: 'browse filtered by content type while still sorting by recency, without an in-memory sort',
  },
  {
    collection: COLLECTIONS.chunks,
    name: 'chunks_documentId_chunkIndex_unique',
    key: { documentId: 1, chunkIndex: 1 },
    unique: true,
    why: "fetch a document's chunks in order, and refuse to store two chunks at the same position after a partial re-ingest",
  },
  {
    collection: COLLECTIONS.chunks,
    name: 'chunks_sourceId',
    key: { sourceId: 1 },
    why: 'delete_content by sourceId and per-source chunk counts in list_sources',
  },
  {
    collection: COLLECTIONS.chunks,
    name: 'chunks_embeddingModel_dimensions',
    key: { embeddingModel: 1, embeddingDimensions: 1 },
    why: 'drives the re-embed scan: find every chunk whose vector was not produced by the currently configured model/dimensions',
  },
  {
    collection: COLLECTIONS.chunks,
    name: 'chunks_tags',
    key: { tags: 1 },
    why: 'tag-filtered chunk queries that do not go through $vectorSearch (exports, admin views)',
  },
  {
    collection: COLLECTIONS.chunks,
    name: 'chunks_documentContentHash',
    key: { documentContentHash: 1 },
    why: 'detect chunks left behind by an older revision of their parent document',
  },
];

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface SearchIndexOutcome {
  name: string;
  collection: string;
  type: 'search' | 'vectorSearch';
  action: 'created' | 'updated' | 'unchanged';
  queryable: boolean;
}

export interface IndexSetupResult {
  /** Every standard index that is guaranteed to exist once this resolves. */
  standard: string[];
  search: SearchIndexOutcome[];
}

export interface IndexPlanEntry {
  name: string;
  collection: string;
  kind: 'standard' | 'search' | 'vectorSearch';
  /** What {@link ensureIndexes} would do to this index right now. */
  action: 'created' | 'updated' | 'unchanged';
  /** Whether the index is currently usable by queries. */
  queryable: boolean;
}

/** What the server currently reports for a search index. */
interface SearchIndexInfo {
  name: string;
  type?: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: Document;
  statusDetail?: unknown;
  message?: unknown;
}

// ---------------------------------------------------------------------------
// ensureIndexes
// ---------------------------------------------------------------------------

/**
 * Create or update every index this app depends on. Safe to run repeatedly.
 *
 * `waitForQueryable` is off by default because the app itself should not block
 * startup on a search index build; the `db:indexes` CLI turns it on so a deploy
 * step fails loudly rather than handing over a knowledge base that cannot be
 * searched yet.
 */
export async function ensureIndexes(
  db: Db,
  config: AppConfig,
  logger: Logger,
  opts: { waitForQueryable?: boolean; timeoutMs?: number } = {},
): Promise<IndexSetupResult> {
  const waitForQueryable = opts.waitForQueryable ?? false;
  const timeoutMs = opts.timeoutMs ?? config.mongo.indexReadyTimeoutMs;

  warnOnDimensionOverride(config, logger);

  // A search index cannot be created on a namespace that does not exist yet, and
  // on a fresh database neither collection does.
  for (const name of [COLLECTIONS.documents, COLLECTIONS.chunks]) {
    await ensureCollection(db, name, logger);
  }

  const standard = await ensureStandardIndexes(db, logger);

  const search: SearchIndexOutcome[] = [];
  for (const desired of desiredSearchIndexes(config)) {
    search.push(await ensureSearchIndex(db, desired, logger, { waitForQueryable, timeoutMs }));
  }

  logger.info(
    {
      event: 'index.setup_complete',
      standardCount: standard.length,
      created: search.filter((entry) => entry.action === 'created').length,
      updated: search.filter((entry) => entry.action === 'updated').length,
      unchanged: search.filter((entry) => entry.action === 'unchanged').length,
    },
    'index setup complete',
  );

  return { standard, search };
}

/**
 * Read-only counterpart to {@link ensureIndexes}: report what would change.
 *
 * Backs `db:indexes --dry-run`. It issues nothing but `listIndexes` and
 * `listSearchIndexes`, so it is safe to point at production.
 */
export async function planIndexes(
  db: Db,
  config: AppConfig,
  logger: Logger,
): Promise<IndexPlanEntry[]> {
  const entries: IndexPlanEntry[] = [];

  for (const collection of [COLLECTIONS.documents, COLLECTIONS.chunks]) {
    const existing = await existingStandardIndexes(db, collection);
    for (const spec of STANDARD_INDEXES.filter((entry) => entry.collection === collection)) {
      const current = existing.get(spec.name);
      // Compare both directions here: an extra field in the existing key is drift
      // too, and unlike a search index this one cannot be fixed by an update.
      const keyDrift =
        current !== undefined &&
        (firstDifference(spec.key, current.key, '$.key') !== null ||
          firstDifference(current.key, spec.key, '$.key') !== null);
      if (keyDrift) {
        logger.warn(
          { event: 'index.key_conflict', index: spec.name, collection },
          'existing index has a different key than the definition in src/db/indexes.ts; it must be dropped before it can be recreated',
        );
      }
      entries.push({
        name: spec.name,
        collection,
        kind: 'standard',
        action: current ? 'unchanged' : 'created',
        queryable: current !== undefined,
      });
    }
  }

  for (const desired of desiredSearchIndexes(config)) {
    const existing = await getSearchIndex(db, desired.collection, desired.name);
    entries.push({
      name: desired.name,
      collection: desired.collection,
      kind: desired.type,
      action: planSearchAction(desired, existing),
      queryable: existing !== null && isQueryable(existing),
    });
  }

  return entries;
}

function warnOnDimensionOverride(config: AppConfig, logger: Logger): void {
  if (config.embedding.dimensions === CHECKED_IN_VECTOR_DIMENSIONS) return;
  logger.warn(
    {
      event: 'index.dimension_override',
      checkedIn: CHECKED_IN_VECTOR_DIMENSIONS,
      configured: config.embedding.dimensions,
      model: config.embedding.model,
    },
    `vector index numDimensions overridden from ${CHECKED_IN_VECTOR_DIMENSIONS} (chunks.vector.json) to ${config.embedding.dimensions} (EMBEDDING_DIMENSIONS)`,
  );
}

async function ensureCollection(db: Db, name: string, logger: Logger): Promise<void> {
  try {
    await db.createCollection(name);
    logger.info(
      { event: 'index.collection_created', collection: name },
      `created collection "${name}"`,
    );
  } catch (cause) {
    if (errorCode(cause) === NAMESPACE_EXISTS) return;
    throw new StorageError(`Could not create collection "${name}"`, {
      cause,
      details: { collection: name },
    });
  }
}

async function ensureStandardIndexes(db: Db, logger: Logger): Promise<string[]> {
  const names: string[] = [];

  for (const collection of [COLLECTIONS.documents, COLLECTIONS.chunks]) {
    const specs = STANDARD_INDEXES.filter((spec) => spec.collection === collection);
    if (specs.length === 0) continue;

    const descriptions: IndexDescription[] = specs.map((spec) =>
      spec.unique
        ? { name: spec.name, key: spec.key, unique: true }
        : { name: spec.name, key: spec.key },
    );

    try {
      // createIndexes is idempotent for an identical spec — re-running it is a no-op.
      await db.collection(collection).createIndexes(descriptions);
    } catch (cause) {
      throw new StorageError(
        `Could not create standard indexes on "${collection}". If an index of the same name exists with a different key or options, drop it and re-run: ${describeError(cause)}`,
        { cause, details: { collection, indexes: specs.map((spec) => spec.name) } },
      );
    }

    for (const spec of specs) names.push(spec.name);
    logger.debug(
      { event: 'index.standard_ensured', collection, indexes: specs.map((spec) => spec.name) },
      `ensured ${specs.length} standard indexes on "${collection}"`,
    );
  }

  return names;
}

async function existingStandardIndexes(
  db: Db,
  collection: string,
): Promise<Map<string, { key: Document }>> {
  const found = new Map<string, { key: Document }>();
  try {
    const listed = await db.collection(collection).listIndexes().toArray();
    for (const entry of listed) {
      const name = typeof entry.name === 'string' ? entry.name : null;
      if (name === null) continue;
      found.set(name, { key: isPlainObject(entry.key) ? entry.key : {} });
    }
  } catch (cause) {
    // The collection does not exist yet: nothing is indexed, which is the answer.
    if (errorCode(cause) === NAMESPACE_NOT_FOUND) return found;
    throw new StorageError(`Could not list indexes on "${collection}"`, {
      cause,
      details: { collection },
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Search index create / update / drift
// ---------------------------------------------------------------------------

async function ensureSearchIndex(
  db: Db,
  desired: DesiredSearchIndex,
  logger: Logger,
  opts: { waitForQueryable: boolean; timeoutMs: number },
): Promise<SearchIndexOutcome> {
  const existing = await getSearchIndex(db, desired.collection, desired.name);
  const action = planSearchAction(desired, existing);

  if (action === 'created') {
    try {
      await db.collection(desired.collection).createSearchIndex({
        name: desired.name,
        type: desired.type,
        definition: desired.definition,
      });
    } catch (cause) {
      throw new IndexError(
        `Could not create ${desired.type} index "${desired.name}" on "${desired.collection}": ${describeError(cause)}`,
        {
          cause,
          details: { index: desired.name, collection: desired.collection, type: desired.type },
        },
      );
    }
    logger.info(
      {
        event: 'index.created',
        index: desired.name,
        collection: desired.collection,
        type: desired.type,
      },
      `created ${desired.type} index "${desired.name}"`,
    );
  } else if (action === 'updated') {
    // Refuse before we ask: an in-place dimension/similarity change is rejected by
    // most deployments, and the remediation is destructive enough to be a decision
    // an operator makes, never one a migration script makes for them.
    assertVectorShapeUnchanged(desired, existing);
    try {
      await db.collection(desired.collection).updateSearchIndex(desired.name, desired.definition);
    } catch (cause) {
      throw updateRejectedError(desired, existing, cause);
    }
    logger.info(
      {
        event: 'index.updated',
        index: desired.name,
        collection: desired.collection,
        type: desired.type,
        difference: firstDifference(
          normaliseDefinition(desired),
          normaliseExisting(desired, existing),
          '$',
        ),
      },
      `updated ${desired.type} index "${desired.name}" to match its definition`,
    );
  } else {
    logger.debug(
      { event: 'index.unchanged', index: desired.name, collection: desired.collection },
      `${desired.type} index "${desired.name}" already matches its definition`,
    );
  }

  const queryable = opts.waitForQueryable
    ? await waitForSearchIndex(db, desired.collection, desired.name, opts.timeoutMs, logger)
    : action === 'unchanged' && existing !== null && isQueryable(existing);

  return {
    name: desired.name,
    collection: desired.collection,
    type: desired.type,
    action,
    queryable,
  };
}

function planSearchAction(
  desired: DesiredSearchIndex,
  existing: SearchIndexInfo | null,
): 'created' | 'updated' | 'unchanged' {
  if (existing === null) return 'created';
  if (existing.type !== undefined && existing.type !== desired.type) {
    throw new IndexError(
      `Index "${desired.name}" on "${desired.collection}" already exists as type "${existing.type}" but this app needs type "${desired.type}". Drop it deliberately and re-run "npm run db:indexes".`,
      {
        details: {
          index: desired.name,
          collection: desired.collection,
          existingType: existing.type,
        },
      },
    );
  }
  const difference = firstDifference(
    normaliseDefinition(desired),
    normaliseExisting(desired, existing),
    '$',
  );
  return difference === null ? 'unchanged' : 'updated';
}

/**
 * Drift detection that does not flap.
 *
 * Atlas echoes a search index definition back with its own defaults filled in
 * (`storedSource`, `analyzer`, per-field `norms`/`indexOptions`, `quantization`
 * on vector fields...). A naive deep-equal would therefore report drift on every
 * single run and update the index forever. So the comparison is one-directional:
 * every key WE declare must be present and equal on the server, and anything the
 * server added on top is ignored. Arrays are compared positionally and must have
 * the same length, because a filter path we dropped or added is real drift.
 *
 * Returns the path of the first difference (useful in a log line) or null.
 */
function firstDifference(desired: unknown, actual: unknown, path: string): string | null {
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return path;
    if (desired.length !== actual.length) return `${path}.length`;
    for (let i = 0; i < desired.length; i += 1) {
      const difference = firstDifference(desired[i], actual[i], `${path}[${i}]`);
      if (difference !== null) return difference;
    }
    return null;
  }

  if (isPlainObject(desired)) {
    if (!isPlainObject(actual)) return path;
    for (const [key, value] of Object.entries(desired)) {
      if (!(key in actual)) return `${path}.${key}`;
      const difference = firstDifference(value, actual[key], `${path}.${key}`);
      if (difference !== null) return difference;
    }
    return null;
  }

  return Object.is(desired, actual) ? null : path;
}

function normaliseDefinition(desired: DesiredSearchIndex): unknown {
  return desired.type === 'search'
    ? normaliseTextDefinition(desired.definition)
    : desired.definition;
}

function normaliseExisting(desired: DesiredSearchIndex, existing: SearchIndexInfo | null): unknown {
  const latest = existing?.latestDefinition ?? {};
  return desired.type === 'search' ? normaliseTextDefinition(latest) : latest;
}

/**
 * Atlas is relaxed about `mappings.fields.<name>` being either one mapping object
 * or an array of them, and does not always echo back the form that was submitted.
 * Normalise both sides to the array form so that difference is never read as drift.
 */
function normaliseTextDefinition(definition: unknown): unknown {
  if (!isPlainObject(definition)) return definition;
  const mappings = definition.mappings;
  if (!isPlainObject(mappings) || !isPlainObject(mappings.fields)) return definition;
  return {
    ...definition,
    mappings: { ...mappings, fields: normaliseFieldMappings(mappings.fields) },
  };
}

function normaliseFieldMappings(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, mapping] of Object.entries(fields)) {
    const entries = Array.isArray(mapping) ? mapping : [mapping];
    out[name] = entries.map((entry) =>
      isPlainObject(entry) && isPlainObject(entry.fields)
        ? { ...entry, fields: normaliseFieldMappings(entry.fields) }
        : entry,
    );
  }
  return out;
}

/** The change Atlas cannot make in place. Stop, explain, let a human decide. */
function assertVectorShapeUnchanged(
  desired: DesiredSearchIndex,
  existing: SearchIndexInfo | null,
): void {
  if (desired.type !== 'vectorSearch' || existing === null) return;

  const wanted = vectorFieldOf(desired.definition);
  const current = vectorFieldOf(existing.latestDefinition);
  if (!wanted || !current) return;
  if (wanted.numDimensions === current.numDimensions && wanted.similarity === current.similarity) {
    return;
  }

  throw new IndexError(dimensionChangeMessage(desired, current, wanted), {
    details: {
      index: desired.name,
      collection: desired.collection,
      existingDimensions: current.numDimensions,
      desiredDimensions: wanted.numDimensions,
      existingSimilarity: current.similarity,
      desiredSimilarity: wanted.similarity,
    },
  });
}

function dimensionChangeMessage(
  desired: DesiredSearchIndex,
  current: VectorFieldDefinition,
  wanted: VectorFieldDefinition,
): string {
  return [
    `Vector index "${desired.name}" on "${desired.collection}" exists with numDimensions=${current.numDimensions} similarity=${current.similarity},`,
    `but the configuration asks for numDimensions=${wanted.numDimensions} similarity=${wanted.similarity}.`,
    'Neither property can be changed by an in-place update on all deployments, and this migration will not drop an index for you.',
    `To proceed deliberately: db.${desired.collection}.dropSearchIndex("${desired.name}"), then re-run "npm run db:indexes".`,
    `Every chunk already stored was embedded at ${current.numDimensions} dimensions, so the whole collection must be re-embedded ("npm run db:reembed") before search returns meaningful results again.`,
  ].join(' ');
}

/**
 * Turn a rejected update into instructions.
 *
 * Verified against Atlas Local 8.0: its mongot validates ANY `updateSearchIndex`
 * payload as a text-index definition, so updating a vectorSearch index in place
 * always fails there with `BadValue: "mappings" is required`, whatever changed.
 * Cloud Atlas does accept some vector updates (adding a filter path) but rejects
 * a numDimensions/similarity change. Either way the remedy is the same and it is
 * the operator's call, so every vector-index update failure gets the full
 * drop-recreate-and-maybe-re-embed explanation rather than the raw driver error.
 */
function updateRejectedError(
  desired: DesiredSearchIndex,
  existing: SearchIndexInfo | null,
  cause: unknown,
): IndexError {
  const message = errorMessage(cause);

  if (desired.type === 'vectorSearch') {
    const current = vectorFieldOf(existing?.latestDefinition);
    const wanted = vectorFieldOf(desired.definition);
    const existingDimensions = current?.numDimensions ?? 'unknown';
    const dimensionsChanged = current && wanted && current.numDimensions !== wanted.numDimensions;

    return new IndexError(
      [
        `The server refused an in-place update of vector index "${desired.name}" on "${desired.collection}": ${message}.`,
        'Not every deployment can update a vectorSearch index in place (Atlas Local 8.0 cannot at all), and this migration will not drop an index for you.',
        `To proceed deliberately: db.${desired.collection}.dropSearchIndex("${desired.name}"), then re-run "npm run db:indexes".`,
        dimensionsChanged
          ? `Every chunk already stored was embedded at ${existingDimensions} dimensions, so the whole collection must also be re-embedded ("npm run db:reembed") before search results are meaningful again.`
          : 'The stored vectors themselves are unaffected, so no re-embedding is needed as long as numDimensions is unchanged.',
      ].join(' '),
      {
        cause,
        details: {
          index: desired.name,
          collection: desired.collection,
          existingDimensions,
          dimensionsChanged: dimensionsChanged === true,
        },
      },
    );
  }

  return new IndexError(
    `Could not update ${desired.type} index "${desired.name}" on "${desired.collection}": ${message}`,
    { cause, details: { index: desired.name, collection: desired.collection, type: desired.type } },
  );
}

async function getSearchIndex(
  db: Db,
  collection: string,
  name: string,
): Promise<SearchIndexInfo | null> {
  try {
    const listed = (await db
      .collection(collection)
      .listSearchIndexes(name)
      .toArray()) as unknown as SearchIndexInfo[];
    return listed.find((entry) => entry.name === name) ?? null;
  } catch (cause) {
    // No collection yet means no index yet; ensureIndexes creates it moments later.
    if (errorCode(cause) === NAMESPACE_NOT_FOUND) return null;
    if (isSearchUnsupported(cause)) {
      throw new IndexError(
        `This MongoDB deployment does not support Atlas Search indexes, so "${name}" cannot be managed. Use the mongodb/mongodb-atlas-local image for local development, or a cloud Atlas cluster. Server said: ${errorMessage(cause)}`,
        { cause, details: { index: name, collection } },
      );
    }
    throw new StorageError(
      `Could not list search indexes on "${collection}": ${errorMessage(cause)}`,
      {
        cause,
        details: { index: name, collection },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Poll until the index is READY and queryable, or the timeout elapses.
 *
 * Returns false on timeout rather than throwing: a slow build is not
 * automatically a failure, and only the caller knows whether it can proceed
 * without the index (the app can; a deploy step generally cannot). A FAILED
 * build *is* a failure and throws, because polling it forever would be a lie.
 */
export async function waitForSearchIndex(
  db: Db,
  collection: string,
  name: string,
  timeoutMs: number,
  logger: Logger,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const info = await getSearchIndex(db, collection, name);

    if (info !== null) {
      const status = String(info.status ?? 'UNKNOWN').toUpperCase();

      if (status === 'FAILED') {
        throw new IndexError(
          `Search index "${name}" on "${collection}" failed to build: ${statusDetail(info)}`,
          { details: { index: name, collection, status } },
        );
      }

      if (isQueryable(info)) {
        logger.debug(
          { event: 'index.ready', index: name, collection },
          `search index "${name}" is queryable`,
        );
        return true;
      }

      logger.debug(
        {
          event: 'index.waiting',
          index: name,
          collection,
          status,
          queryable: info.queryable === true,
        },
        `waiting for search index "${name}" (${status})`,
      );
    } else {
      logger.debug(
        { event: 'index.waiting', index: name, collection, status: 'MISSING' },
        `search index "${name}" is not visible yet`,
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      logger.warn(
        { event: 'index.timeout', index: name, collection, timeoutMs },
        `search index "${name}" was still not queryable after ${timeoutMs}ms`,
      );
      return false;
    }

    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/**
 * One-shot probe: is this search index usable right now?
 *
 * Deliberately swallows every failure into `false` — callers use this to decide
 * whether to fall back from hybrid to pure vector search, and a probe that can
 * throw would turn a degraded search into a failed one.
 */
export async function searchIndexIsQueryable(
  db: Db,
  collection: string,
  name: string,
): Promise<boolean> {
  try {
    const info = await getSearchIndex(db, collection, name);
    return info !== null && isQueryable(info);
  } catch {
    return false;
  }
}

function isQueryable(info: SearchIndexInfo): boolean {
  if (info.queryable !== true) return false;
  const status = info.status === undefined ? 'READY' : String(info.status).toUpperCase();
  return status === 'READY';
}

function statusDetail(info: SearchIndexInfo): string {
  if (typeof info.message === 'string' && info.message.length > 0) return info.message;
  if (info.statusDetail !== undefined) return describeError(info.statusDetail);
  return 'the server reported status FAILED without a message';
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || !('code' in value)) return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return null;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : describeError(value);
}

const SEARCH_UNSUPPORTED_PATTERNS = [
  /unrecognized pipeline stage name: .?\$listsearchindexes/i,
  /search index.{0,40}not supported/i,
  /not supported.{0,40}search index/i,
];

function isSearchUnsupported(value: unknown): boolean {
  const code = errorCode(value);
  if (code !== null && SEARCH_UNSUPPORTED_CODES.has(code)) return true;
  const message = errorMessage(value);
  return SEARCH_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
