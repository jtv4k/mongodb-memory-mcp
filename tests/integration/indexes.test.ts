/**
 * `ensureIndexes` against a real Atlas Local deployment.
 *
 * The unit suite already pins the decision logic against a hand-rolled fake. What
 * it cannot prove is the part that actually matters in production: that the
 * definitions in `src/db/index-definitions/*.json` are accepted by a real
 * `mongot`, that the indexes reach a queryable state, that re-running the
 * migration is genuinely a no-op rather than an endless flap between "unchanged"
 * and "updated", and that a definition someone edited in the Atlas UI is pulled
 * back into line.
 *
 * The drift case is deliberately exercised on a *text* index. Atlas Local 8.0
 * cannot update a `vectorSearch` index in place at all, which `src/db/indexes.ts`
 * turns into an explicit "drop it yourself" error rather than a silent drop — so
 * drifting the vector index would be testing the refusal, not the update.
 */
import type { Collection, Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COLLECTIONS } from '../../src/db/collections.js';
import { planIndexes, STANDARD_INDEXES } from '../../src/db/indexes.js';
import { createHarness, type Harness } from './helpers/harness.js';

interface SearchIndexRow {
  name: string;
  type?: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: Document;
}

let h: Harness;

/** The index suite drives `ensureIndexes` itself, so it starts from nothing. */
beforeAll(async () => {
  h = await createHarness({ applyIndexes: false });
});

afterAll(async () => {
  await h?.teardown();
});

async function searchIndex<T extends Document>(
  collection: Collection<T>,
  name: string,
): Promise<SearchIndexRow | undefined> {
  const rows = (await collection.listSearchIndexes(name).toArray()) as unknown as SearchIndexRow[];
  return rows.find((row) => row.name === name);
}

function vectorField(definition: Document | undefined): Document | undefined {
  const fields = definition?.fields;
  if (!Array.isArray(fields)) return undefined;
  return fields.find((field: Document) => field.type === 'vector');
}

function filterPaths(definition: Document | undefined): string[] {
  const fields = definition?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((field: Document) => field.type === 'filter')
    .map((field: Document) => String(field.path))
    .sort();
}

describe('ensureIndexes on Atlas Local', () => {
  it('creates every standard index and all three search indexes, and they become queryable', async () => {
    const result = await h.applyIndexes({ waitForQueryable: true });

    expect(result.standard).toEqual(
      expect.arrayContaining(STANDARD_INDEXES.map((spec) => spec.name)),
    );
    expect(result.search).toHaveLength(3);

    for (const outcome of result.search) {
      expect(outcome.action).toBe('created');
      // Queryable is the assertion with teeth: an index that exists but never
      // finishes building would make every later search silently return nothing.
      expect(outcome.queryable).toBe(true);
    }

    expect(result.search.map((outcome) => outcome.name).sort()).toEqual(
      [
        h.config.mongo.documentsTextIndexName,
        h.config.mongo.textIndexName,
        h.config.mongo.vectorIndexName,
      ].sort(),
    );
  });

  it('materialises each standard index with the declared key and uniqueness', async () => {
    for (const collection of [COLLECTIONS.documents, COLLECTIONS.chunks]) {
      const listed = await h.db.collection(collection).listIndexes().toArray();
      const byName = new Map(listed.map((entry) => [String(entry.name), entry]));

      for (const spec of STANDARD_INDEXES.filter((entry) => entry.collection === collection)) {
        const actual = byName.get(spec.name);
        expect(actual, `${collection}.${spec.name} should exist`).toBeDefined();
        expect(actual?.key).toEqual(spec.key);
        expect(Boolean(actual?.unique)).toBe(Boolean(spec.unique));
      }
    }
  });

  it('builds the vector index at exactly the configured dimensions', async () => {
    const info = await searchIndex(h.chunks, h.config.mongo.vectorIndexName);
    expect(info?.type).toBe('vectorSearch');

    const field = vectorField(info?.latestDefinition);
    expect(field?.path).toBe('embedding');
    expect(field?.similarity).toBe('cosine');
    // The coupling that breaks $vectorSearch at runtime if it is ever wrong.
    expect(field?.numDimensions).toBe(h.config.embedding.dimensions);

    // Every path a search may narrow on has to be declared as a filter, or the
    // service's tag/source/model filters would be rejected by the server.
    expect(filterPaths(info?.latestDefinition)).toEqual([
      'contentType',
      'documentId',
      'embeddingDimensions',
      'embeddingModel',
      'sourceId',
      'tags',
    ]);
  });

  it('strips the $comment key before the definition reaches the server', async () => {
    const live = await Promise.all([
      searchIndex(h.chunks, h.config.mongo.vectorIndexName),
      searchIndex(h.chunks, h.config.mongo.textIndexName),
      searchIndex(h.documents, h.config.mongo.documentsTextIndexName),
    ]);

    for (const info of live) {
      expect(info?.latestDefinition).toBeDefined();
      expect(info?.latestDefinition).not.toHaveProperty('$comment');
    }
  });

  it('is idempotent: a second run reports every index unchanged', async () => {
    const result = await h.applyIndexes({ waitForQueryable: true });

    for (const outcome of result.search) {
      expect(
        outcome.action,
        `${outcome.name} drifted on a no-op re-run; the drift comparison is flapping`,
      ).toBe('unchanged');
      expect(outcome.queryable).toBe(true);
    }

    const plan = await planIndexes(h.db, h.config, h.logger);
    expect(plan).toHaveLength(STANDARD_INDEXES.length + 3);
    for (const entry of plan) {
      expect(entry.action, `${entry.collection}.${entry.name}`).toBe('unchanged');
      expect(entry.queryable).toBe(true);
    }
  });

  it('pulls a drifted search-index definition back to the checked-in one', async () => {
    const name = h.config.mongo.documentsTextIndexName;

    // Simulate someone editing the index in the Atlas UI: a definition that still
    // works but no longer indexes the fields we depend on.
    await h.documents.updateSearchIndex(name, {
      mappings: {
        dynamic: false,
        fields: { title: [{ type: 'string', analyzer: 'lucene.standard' }] },
      },
    });

    await h.waitFor('the drifted definition to be live on the server', async () => {
      const info = await searchIndex(h.documents, name);
      const fields = info?.latestDefinition?.mappings?.fields as Document | undefined;
      return info?.queryable === true && fields?.uri === undefined;
    });

    const result = await h.applyIndexes({ waitForQueryable: true });
    const outcome = result.search.find((entry) => entry.name === name);
    expect(outcome?.action).toBe('updated');

    // The other two were untouched, so the run must not have churned them.
    for (const entry of result.search.filter((candidate) => candidate.name !== name)) {
      expect(entry.action).toBe('unchanged');
    }

    await h.waitFor('the checked-in definition to be restored', async () => {
      const info = await searchIndex(h.documents, name);
      const fields = info?.latestDefinition?.mappings?.fields as Document | undefined;
      return (
        info?.queryable === true && fields?.uri !== undefined && fields?.sourceId !== undefined
      );
    });
  });
});
