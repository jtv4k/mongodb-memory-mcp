/**
 * Domain-based content organization against a real database.
 *
 * `domain` is filtered two different ways on purpose (see
 * src/services/identity.ts's `domainAncestors` and the module doc in
 * knowledge-service.ts's filter builders): search_knowledge and list_sources
 * match a domain *or any of its descendants* (prefix semantics, via the
 * materialised `domainPath` ancestor array), while delete_content's domain
 * selector matches the exact domain only — deleting "docs/api/v1" must never
 * take "docs/api/v1/sub" with it. Both halves of that asymmetry are asserted
 * here, along with case-sensitivity (domain is documented as case-sensitive,
 * unlike tags) and the domain-less backward-compatible path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StoreContentResult } from '../../src/domain/types.js';
import { searchInput, storeInput, type Fixture } from './helpers/fixtures.js';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
const stored = new Map<string, StoreContentResult>();

const DOCS_API_V1: Fixture = {
  sourceId: 'domain-tests/docs-api-v1',
  title: 'API v1 guide',
  uri: 'https://example.test/domain-tests/docs-api-v1',
  contentType: 'markdown',
  tags: ['domain-fixture'],
  content: `# API v1 guide

Operational notes for the version-one HTTP interface, covering pagination
cursors, rate limiting headers, and the deprecated auth flow that v1 clients
still rely on.
`,
};

const DOCS_API_V1_SUB: Fixture = {
  sourceId: 'domain-tests/docs-api-v1-sub',
  title: 'API v1 authentication addendum',
  uri: 'https://example.test/domain-tests/docs-api-v1-sub',
  contentType: 'markdown',
  tags: ['domain-fixture'],
  content: `# API v1 authentication addendum

Operational notes supplementing the version-one bearer token exchange,
refresh windows, and revocation semantics for the deprecated auth flow.
`,
};

const DOCS_API_V2: Fixture = {
  sourceId: 'domain-tests/docs-api-v2',
  title: 'API v2 guide',
  uri: 'https://example.test/domain-tests/docs-api-v2',
  contentType: 'markdown',
  tags: ['domain-fixture'],
  content: `# API v2 guide

Operational notes for the version-two HTTP interface, covering cursor-based
pagination, the new rate limiting envelope, and the OAuth2 client-credentials
auth flow v2 clients use.
`,
};

const LEGACY_DOC: Fixture = {
  sourceId: 'domain-tests/legacy',
  title: 'Legacy notes',
  uri: 'https://example.test/domain-tests/legacy',
  contentType: 'markdown',
  tags: ['domain-fixture'],
  content: `# Legacy notes

Miscellaneous operational notes that predate the domain-based organisation
scheme entirely and were never assigned to any domain.
`,
};

const CASE_VARIANT_DOC: Fixture = {
  sourceId: 'domain-tests/case-variant',
  title: 'Case variant guide',
  uri: 'https://example.test/domain-tests/case-variant',
  contentType: 'markdown',
  tags: ['domain-fixture'],
  content: `# Case variant guide

Operational notes stored under a domain whose casing deliberately differs
from the lowercase docs/api convention used by the rest of this fixture set.
`,
};

const QUERY = 'operational notes for the http interface auth flow';

async function store(fixture: Fixture, domain?: string): Promise<StoreContentResult> {
  const result = await h.service.storeContent(storeInput(fixture, { domain }), h.context());
  stored.set(result.sourceId, result);
  return result;
}

beforeAll(async () => {
  h = await createHarness();

  await store(DOCS_API_V1, 'docs/api/v1');
  await store(DOCS_API_V1_SUB, 'docs/api/v1/sub');
  await store(DOCS_API_V2, 'docs/api/v2');
  await store(LEGACY_DOC);
  await store(CASE_VARIANT_DOC, 'Docs/API');

  for (const fixture of [DOCS_API_V1, DOCS_API_V1_SUB, DOCS_API_V2, LEGACY_DOC, CASE_VARIANT_DOC]) {
    const result = stored.get(fixture.sourceId);
    await h.waitForIndexedChunks(fixture.sourceId, result?.chunkCount ?? 0);
  }
});

afterAll(async () => {
  await h?.teardown();
});

const sourceIdsOf = (hits: { sourceId: string }[]) => new Set(hits.map((hit) => hit.sourceId));

describe('storeContent persists domain', () => {
  it('reports the domain it was given, and null when omitted', () => {
    expect(stored.get(DOCS_API_V1.sourceId)?.domain).toBe('docs/api/v1');
    expect(stored.get(LEGACY_DOC.sourceId)?.domain).toBeNull();
  });

  it('stores the exact domain and its ancestor chain on both the document and its chunks', async () => {
    const document = await h.documents.findOne({ sourceId: DOCS_API_V1_SUB.sourceId });
    expect(document?.domain).toBe('docs/api/v1/sub');
    expect(document?.domainPath).toEqual(['docs', 'docs/api', 'docs/api/v1', 'docs/api/v1/sub']);

    const chunkRows = await h.chunks.find({ sourceId: DOCS_API_V1_SUB.sourceId }).toArray();
    expect(chunkRows.length).toBeGreaterThan(0);
    for (const chunk of chunkRows) {
      expect(chunk.domain).toBe('docs/api/v1/sub');
      expect(chunk.domainPath).toEqual(['docs', 'docs/api', 'docs/api/v1', 'docs/api/v1/sub']);
    }
  });
});

describe('search_knowledge domain filtering is prefix-matched', () => {
  it('finds every fixture, including the domain-less one, with no filter applied', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'vector', limit: 10 }),
      h.context(),
    );
    expect(sourceIdsOf(result.hits)).toEqual(
      new Set([
        DOCS_API_V1.sourceId,
        DOCS_API_V1_SUB.sourceId,
        DOCS_API_V2.sourceId,
        LEGACY_DOC.sourceId,
        CASE_VARIANT_DOC.sourceId,
      ]),
    );
  });

  it('an exact-leaf filter matches itself and its descendants, not siblings', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'vector', limit: 10, filters: { domain: 'docs/api/v1' } }),
      h.context(),
    );
    expect(sourceIdsOf(result.hits)).toEqual(
      new Set([DOCS_API_V1.sourceId, DOCS_API_V1_SUB.sourceId]),
    );
  });

  it('a parent-prefix filter matches every descendant leaf', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'vector', limit: 10, filters: { domain: 'docs/api' } }),
      h.context(),
    );
    expect(sourceIdsOf(result.hits)).toEqual(
      new Set([DOCS_API_V1.sourceId, DOCS_API_V1_SUB.sourceId, DOCS_API_V2.sourceId]),
    );
  });

  it('a leaf with no descendants matches only itself', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'vector', limit: 10, filters: { domain: 'docs/api/v2' } }),
      h.context(),
    );
    expect(sourceIdsOf(result.hits)).toEqual(new Set([DOCS_API_V2.sourceId]));
  });

  it('is case-sensitive: a differently-cased domain does not collide', async () => {
    const lower = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'vector', limit: 10, filters: { domain: 'docs/api' } }),
      h.context(),
    );
    expect(sourceIdsOf(lower.hits)).not.toContain(CASE_VARIANT_DOC.sourceId);

    const cased = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'vector', limit: 10, filters: { domain: 'Docs/API' } }),
      h.context(),
    );
    expect(sourceIdsOf(cased.hits)).toEqual(new Set([CASE_VARIANT_DOC.sourceId]));
  });

  it('the text leg also honours the domain filter (mongot side, not just $vectorSearch)', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'text', limit: 10, filters: { domain: 'docs/api/v1' } }),
      h.context(),
    );
    expect(sourceIdsOf(result.hits)).toEqual(
      new Set([DOCS_API_V1.sourceId, DOCS_API_V1_SUB.sourceId]),
    );
  });

  it('a domain no content carries returns no hits, not an error', async () => {
    const result = await h.service.searchKnowledge(
      searchInput(QUERY, { mode: 'vector', limit: 10, filters: { domain: 'docs/nothing-here' } }),
      h.context(),
    );
    expect(result.hits).toEqual([]);
  });
});

describe('list_sources domain filtering', () => {
  it('is prefix-matched and reports the exact domain per source', async () => {
    const result = await h.service.listSources(
      { limit: 50, offset: 0, sort: 'title', order: 'asc', domain: 'docs/api' },
      h.context(),
    );

    expect(new Set(result.sources.map((source) => source.sourceId))).toEqual(
      new Set([DOCS_API_V1.sourceId, DOCS_API_V1_SUB.sourceId, DOCS_API_V2.sourceId]),
    );
    const v1 = result.sources.find((source) => source.sourceId === DOCS_API_V1.sourceId);
    expect(v1?.domain).toBe('docs/api/v1');
  });

  it('without a domain filter, still lists domain-less sources with domain: null', async () => {
    const result = await h.service.listSources(
      { limit: 50, offset: 0, sort: 'title', order: 'asc' },
      h.context(),
    );
    const legacy = result.sources.find((source) => source.sourceId === LEGACY_DOC.sourceId);
    expect(legacy?.domain).toBeNull();
  });
});

describe('delete_content by domain is exact, never cascading', () => {
  async function seed(sourceId: string, domain: string): Promise<StoreContentResult> {
    return h.service.storeContent(
      storeInput(DOCS_API_V1, {
        sourceId,
        title: `Ephemeral ${sourceId}`,
        domain,
        content: `# Ephemeral ${sourceId}\n\nDisposable content for the domain delete test of ${sourceId}.\n`,
      }),
      h.context(),
    );
  }

  it('removes only the exact domain, leaving descendants and siblings intact', async () => {
    const parent = await seed('domain-tests/ephemeral-parent', 'ephemeral/parent');
    const child = await seed('domain-tests/ephemeral-child', 'ephemeral/parent/child');
    const sibling = await seed('domain-tests/ephemeral-sibling', 'ephemeral/sibling');

    const result = await h.service.deleteContent({ domain: 'ephemeral/parent' }, h.context());

    expect(result.deletedDocuments).toBe(1);
    expect(result.sourceIds).toEqual([parent.sourceId]);

    expect(await h.documents.countDocuments({ sourceId: parent.sourceId })).toBe(0);
    expect(await h.chunks.countDocuments({ sourceId: parent.sourceId })).toBe(0);
    // The descendant and the sibling are untouched — an exact selector, not a prefix.
    expect(await h.documents.countDocuments({ sourceId: child.sourceId })).toBe(1);
    expect(await h.documents.countDocuments({ sourceId: sibling.sourceId })).toBe(1);

    await h.service.deleteContent({ sourceId: child.sourceId }, h.context());
    await h.service.deleteContent({ sourceId: sibling.sourceId }, h.context());
  });
});
