---
name: vector-index-management
description: How MongoDB Vector Search and MongoDB Search index definitions are declared as code in src/db/index-definitions/, applied identically to Atlas Local and cloud Atlas by npm run db:indexes, how drift and readiness are detected, how to add a filter path, and the drop-recreate-re-embed path for a numDimensions or similarity change. Use when adding or altering any search index, or when search returns nothing.
---

# Vector and search index management

Three search indexes and seven standard indexes, all declared as code, all applied
by one idempotent command. The Atlas UI is **never** the source of truth: an
index clicked together by hand cannot be reproduced on Atlas Local, in CI, or on
the next cluster.

| Index                                                                | Collection  | Type           | Definition                                     |
| -------------------------------------------------------------------- | ----------- | -------------- | ---------------------------------------------- |
| `MONGODB_VECTOR_INDEX_NAME` (default `chunks_vector_index`)          | `chunks`    | `vectorSearch` | `src/db/index-definitions/chunks.vector.json`  |
| `MONGODB_TEXT_INDEX_NAME` (default `chunks_text_index`)              | `chunks`    | `search`       | `src/db/index-definitions/chunks.text.json`    |
| `MONGODB_DOCUMENTS_TEXT_INDEX_NAME` (default `documents_text_index`) | `documents` | `search`       | `src/db/index-definitions/documents.text.json` |

Standard b-tree indexes live in `STANDARD_INDEXES` in `src/db/indexes.ts`, each
carrying a `why` string naming the query it serves. If nothing runs that query,
delete the index rather than keeping it "just in case".

---

## The command

```bash
# read-only: what would change, and what is queryable right now
./scripts/ndocker.sh npm run db:indexes -- --dry-run

# apply, then wait for the search indexes to become queryable
./scripts/ndocker.sh npm run db:indexes

# apply and return immediately
./scripts/ndocker.sh npm run db:indexes -- --no-wait

# override MONGODB_INDEX_READY_TIMEOUT_MS for this run
./scripts/ndocker.sh npm run db:indexes -- --timeout 600000
```

It needs `MONGODB_URI` and `MONGODB_DB_NAME` in its environment. Inside the dev
stack that is already true:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  run --rm app npm run db:indexes
```

**The command is identical for Atlas Local and cloud Atlas — only `MONGODB_URI`
differs.** That is the entire point of declaring the definitions as code. Exit
code 0 means every index exists and (unless `--no-wait`) is queryable; 1 means
something needs a human. CI runs it as a smoke test before the integration
suite.

---

## How the definitions become a live index

1. The JSON files carry a `$comment` key for whoever opens them next. Atlas
   rejects unknown top-level keys, so `stripComments()` removes it recursively
   before the definition ever reaches the server.
2. `buildVectorIndexDefinition(config)` clones the vector definition and
   **overwrites `numDimensions` from `config.embedding.dimensions`**. The value
   in the JSON (1024) is the shipped default for `voyage-context-3`; the index
   must always match the configured model, otherwise the first `$vectorSearch`
   fails with a dimension mismatch that reads like a data problem instead of a
   config one. When the two disagree, `ensureIndexes` logs
   `index.dimension_override` and `db:indexes` prints a warning line, because
   changing the width is the one change that also requires a re-embed.
3. `desiredSearchIndexes(config)` resolves all three against the current config,
   including their configured names.
4. `ensureIndexes()` creates the collections if absent (a search index cannot be
   created on a namespace that does not exist), applies the standard indexes,
   then reconciles each search index.

---

## How `created` / `unchanged` / `updated` is decided

`planSearchAction()` compares the desired definition with what the server
reports:

- No such index ⇒ **created**.
- Exists but with a different `type` (`search` vs `vectorSearch`) ⇒ hard error.
  A migration will not silently drop and replace an index of the wrong kind.
- Otherwise `firstDifference()` walks the desired definition against
  `latestDefinition`. Any difference ⇒ **updated**; none ⇒ **unchanged**.

The comparison is deliberately **one-directional**: every key _we_ declare must
be present and equal on the server, and anything the server added on top is
ignored. Atlas echoes definitions back with its own defaults filled in
(`storedSource`, `analyzer`, per-field `norms`/`indexOptions`, `quantization` on
vector fields). A naive deep-equal would report drift on every single run and
update the index forever. Arrays _are_ compared positionally and must match in
length, because a filter path that was added or dropped is real drift.

Text definitions get one extra normalisation: Atlas accepts
`mappings.fields.<name>` as either a single mapping object or an array of them,
and does not always echo back the form that was submitted, so both sides are
normalised to the array form (`normaliseTextDefinition`).

If you change the comparison logic, the failure mode to watch for is not a false
error — it is an index that flaps between `unchanged` and `updated` on
alternate runs.

---

## Adding a filter path to the vector index

**A field must be a declared `filter` path before `$vectorSearch` can filter on
it.** There is no dynamic filtering. This is also _why_ chunks denormalise their
parent's `tags`, `contentType`, `title` and `uri`: the index is on `chunks`, so
the filterable values have to live on the chunk.

1. Make sure the field is actually written on every chunk in `storeContent`
   (`src/services/knowledge-service.ts`). An index on a field that does not exist
   filters everything out.
2. Add it to `chunks.vector.json`:
   ```json
   { "type": "filter", "path": "documentVersion" }
   ```
3. If the _text_ leg must filter on it too, add a mapping to `chunks.text.json`
   — a `token` field with the `lowercase` normalizer for exact-match values, a
   `string` field with `lucene.standard` for analysed text. `dynamic: false` is
   deliberate there: indexing the 1024-float `embedding` array as text would be a
   large and completely useless waste of index space.
4. Use it in `buildVectorFilter()` / `buildTextFilter()` in the service. Note
   that `$vectorSearch` filters support no `$all`, so "all of these tags" is an
   `$and` of single-element `$in`s.
5. `npm run db:indexes -- --dry-run` (expect `updated`), then apply.
6. Backfill: existing chunks written before the field existed will not have it.
   Either re-ingest those sources or write the filter so a missing field is not a
   silent empty result.

**Adding a filter path is normally an in-place update on cloud Atlas.** Atlas
Local 8.0 cannot update a `vectorSearch` index in place at all (see below), so
locally you will need to drop and recreate — which is cheap, because the stored
vectors themselves are untouched and do **not** need re-embedding.

---

## Verifying an index is queryable

"Exists" and "usable" are different states. `isQueryable()` requires
`queryable === true` **and** `status === 'READY'`.

- `npm run db:indexes -- --dry-run` prints a `QUERYABLE` column for every index.
- `GET /readyz` reports the vector index specifically and answers 503 when it is
  not queryable, with the index name and remediation in the body.
- In code: `searchIndexIsQueryable(db, collection, name)` is a one-shot probe
  that swallows every failure into `false` — callers use it to decide whether to
  degrade, and a probe that can throw would turn a degraded search into a failed
  one.
- `waitForSearchIndex(db, collection, name, timeoutMs, logger)` polls every 2s.
  It returns `false` on timeout (a slow build is not automatically a failure —
  the app can start without the index, a deploy step generally cannot) but
  **throws** on `status: 'FAILED'`, because polling a failed build forever is a
  lie.

MongoDB Search is eventually consistent in a second sense too: a just-inserted
chunk is not instantly searchable even against a ready index. Poll for it in
tests; never `sleep` and hope.

### When search returns nothing

Atlas Local answers a query against a non-existent index with an **empty result
set**, not an error, so "zero hits" is genuinely ambiguous. The service resolves
it with `confirmIndex()` — a `listSearchIndexes` probe issued only when a leg
came back empty, cached after the first success. A missing **vector** index is
then a hard `IndexError` telling you to run `db:indexes`; a missing **text**
index degrades hybrid search to vector-only with a single
`search.text_index_unavailable` warning.

---

## The hard case: changing `numDimensions` or `similarity`

**Neither can be changed by an in-place update on all deployments.** Verified
behaviour:

- **Atlas Local 8.0** validates _any_ `updateSearchIndex` payload as a text-index
  definition, so updating a `vectorSearch` index in place always fails there with
  `BadValue: "mappings" is required`, whatever changed.
- **Cloud Atlas** accepts some vector updates (adding a filter path) but rejects
  a `numDimensions` / `similarity` change.

`ensureIndexes` therefore refuses **before** it asks: `assertVectorShapeUnchanged`
throws an `IndexError` explaining the situation rather than letting the migration
drop a production index and strand every vector already stored. That is an
operator's decision, not a script's.

The deliberate procedure:

```bash
# 1. Confirm what you are about to do.
./scripts/ndocker.sh npm run db:indexes -- --dry-run

# 2. Drop the vector index. From mongosh against the target database:
#      db.chunks.dropSearchIndex("chunks_vector_index")

# 3. Recreate it at the new width (EMBEDDING_DIMENSIONS must already be updated
#    in the environment the command runs in).
./scripts/ndocker.sh npm run db:indexes

# 4. Every stored chunk was embedded at the OLD width and is now unmatchable.
#    Re-embed the whole corpus.
./scripts/ndocker.sh npm run db:reembed -- --dry-run
./scripts/ndocker.sh npm run db:reembed
```

Step 4 is not optional and not cosmetic: a chunk whose vector length differs from
the index's `numDimensions` is silently absent from every search result, forever.
If the width changed because the _model_ changed, follow the
`embedding-model-migration` skill instead — it covers the ordering that keeps
search correct while the backfill runs.

Changing `similarity` (e.g. `cosine` → `dotProduct`) is the same drop-and-recreate
dance, but the stored vectors are still valid, so no re-embed is needed.

---

## Standard indexes

`ensureStandardIndexes` calls `createIndexes` with explicit names — never the
driver-generated `sourceId_1` — so drift is legible in `listIndexes` output and the
names are spelled in exactly one place. `createIndexes` is idempotent for an
identical spec.

An existing index with the **same name but a different key** cannot be fixed by
re-running: `createIndexes` errors, and the wrapper's message says so and tells
you to drop it. `planIndexes` detects the same situation read-only and logs
`index.key_conflict`. Dropping and recreating a b-tree index is safe — no data is
lost — but on a large collection it is not instant.

---

## Verify

```bash
./scripts/ndocker.sh npx tsc --noEmit
./scripts/ndocker.sh npx vitest run --project unit tests/unit/indexes.test.ts
./scripts/ndocker.sh npm run db:indexes -- --dry-run     # against the target DB
```

`tests/unit/indexes.test.ts` covers definition loading, dimension injection and
the drift comparison without a database. `tests/integration/indexes.test.ts`
proves the real thing against Atlas Local: indexes are created, become queryable,
a second run reports `unchanged`, `numDimensions` matches the configured value,
and a drifted definition is updated.
