---
name: embedding-model-migration
description: Runbook for changing the embedding model, dimensions or provider - what chunk provenance guarantees, the ordered steps (add provider, update EMBEDDING_MODEL/DIMENSIONS, recreate the vector index if the width changed, run db:reembed, verify with embeddingCoverage), why search stays correct mid-backfill, incremental runs, and rollback. Use before touching EMBEDDING_MODEL, EMBEDDING_DIMENSIONS or EMBEDDING_PROVIDER.
---

# Migrating the embedding model or provider

Changing the embedding model invalidates every vector in the corpus. Done in the
wrong order it strands the knowledge base — search returns nothing, and the
reason is invisible. Done in this order it is a background backfill during which
search keeps working.

---

## Why nothing gets orphaned

Every chunk records **who embedded it**, as flat, indexed, filterable fields:

```
embeddingProvider   'voyage'
embeddingModel      'voyage-context-3'
embeddingDimensions 1024
embeddedAt          <Date>
```

Plus a matching stamp on the parent document (`document.embedding`) for the
management views. Two of those fields — `embeddingModel` and
`embeddingDimensions` — are declared **filter paths** in
`src/db/index-definitions/chunks.vector.json`, and that is what the whole
migration story rests on:

- **Search is always constrained to the configured model.**
  `buildVectorFilter()` in `src/services/knowledge-service.ts` unconditionally
  adds `embeddingModel == config.embedding.model` and
  `embeddingDimensions == config.embedding.dimensions` to every `$vectorSearch`.
  `buildTextFilter()` pins the model too (`embeddingDimensions` is not in
  `chunks.text.json`, which is fine — the vector leg pins both, and two configs
  sharing a model name but differing in width is pathological).
  So a half-migrated corpus returns **fewer** results, never a ranking that
  silently mixes two incompatible vector spaces. That failure mode — confidently
  wrong answers — is far worse than temporarily thin recall.
- **The backfill knows exactly what is left.** "Stale" is
  `embeddingModel != target OR embeddingDimensions != target`, served by the
  `chunks_embeddingModel_dimensions` index.
- **`storeContent` notices too.** An unchanged content hash whose chunks were
  embedded by a different model is re-ingested rather than skipped
  (event `ingest.repair`), so ordinary traffic helps the migration along.

---

## Before you start

Answer these:

1. **Does the vector width change?** `voyage-context-3` → `voyage-3.5` at the
   same 1024 dims is the easy case. Any change to `EMBEDDING_DIMENSIONS` means
   the vector index must be dropped and recreated (see step 3) and there is an
   unavoidable window where the old vectors are unmatchable.
2. **Is the new model contextual?** `CONTEXTUAL_MODELS` in `src/config/env.ts`
   drives `config.embedding.contextual`. Moving from contextual to
   non-contextual is legal — the provider interface is the same either way — but
   retrieval characteristics change, so re-check quality by hand, not just by
   test.
3. **Does the width the model supports match?** The env schema rejects an
   `EMBEDDING_DIMENSIONS` the model does not offer (`2048 | 1024 | 512 | 256`
   for the known Voyage Matryoshka models). Add the model to
   `KNOWN_MODEL_DIMENSIONS` if it is new.
4. **How big is the corpus?** `GET /api/embedding-coverage` (bearer token
   required) gives chunk and document counts per model. Multiply by your
   provider's rate limit to get a realistic wall-clock estimate before you start.

---

## Step 1 — Add the provider (only if the vendor changes)

Skip this for a model change within Voyage.

1. Implement `EmbeddingProvider` (`src/embeddings/provider.ts`) in a new module
   under `src/embeddings/`. It must satisfy the interface's guarantees, not just
   its types:
   - `embedDocumentChunks(documents)` takes chunks **grouped by parent document,
     in order**, and returns `embeddings[d][c]` mirroring the input shape
     exactly — same outer length, same inner lengths — or throws
     `EmbeddingError`.
   - Every vector's length equals `info.dimensions`. Check it in the provider;
     the service checks again, and both checks matter.
   - Rebuild the response from the vendor's explicit per-entry index if it
     provides one, never from array position. See the reasoning in the
     `voyage.ts` module docblock.
   - Honour `options.signal` so a cancelled request cancels the HTTP call.
   - `embedQueries()` uses the query-side input type; document and query
     embeddings are asymmetric for most vendors.
2. Add the slug to the `EMBEDDING_PROVIDER` enum in `src/config/env.ts` and to
   the switch in `createEmbeddingProvider()` (`src/embeddings/factory.ts`). The
   switch has an exhaustive `never` check, so forgetting the second half is a
   compile error rather than a runtime surprise at first ingest.
3. Unit-test it with mocked `fetch`, the way
   `tests/unit/embeddings-voyage.test.ts` does. No network in the unit project.

Nothing in ingestion or search changes. That is the point of the interface.

---

## Step 2 — Update the configuration

```
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-3.5
EMBEDDING_DIMENSIONS=1024
```

Set these wherever the target environment gets its config, then **restart the
process**. Config is validated once at startup; there is no hot reload.

The restart is not optional and the backfill enforces it: `reembed()` throws a
`ValidationError` if the requested target does not match the configured provider,
because the provider can only produce what it is configured for and a target it
cannot reach would re-select the same chunks forever.

At this point search is already constrained to the new model, so it returns
nothing (or only whatever has already been migrated). Expect that. It is the
correct behaviour, and it is why the next two steps should follow immediately.

---

## Step 3 — Recreate the vector index, if and only if the width changed

Same width ⇒ nothing to do; skip to step 4.

Different width ⇒ `numDimensions` must change, and it **cannot be updated in
place** (Atlas Local 8.0 cannot update a `vectorSearch` index at all; cloud
Atlas rejects a `numDimensions`/`similarity` change). `ensureIndexes` refuses
before it even asks, with an explanatory `IndexError`, rather than dropping a
production index for you.

```bash
# see the plan first
./scripts/ndocker.sh npm run db:indexes -- --dry-run

# drop it deliberately, from mongosh against the target database:
#   db.chunks.dropSearchIndex("chunks_vector_index")

# recreate at the new width (EMBEDDING_DIMENSIONS is read from the environment)
./scripts/ndocker.sh npm run db:indexes
```

Details and the surrounding reasoning are in the `vector-index-management`
skill.

---

## Step 4 — Backfill

```bash
# what would happen: how many stale chunks, how many documents
./scripts/ndocker.sh npm run db:reembed -- --dry-run

# do it
./scripts/ndocker.sh npm run db:reembed
```

`db:reembed` runs `src/cli/reembed.ts`, a thin wrapper over
`KnowledgeService.reembed(input, ctx)`. The authoritative input contract is
`reembedSchema` in `src/domain/schemas.ts`; run the CLI with `--help` for how it
spells each one as a flag. The five parameters are:

| Field              | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `dryRun`           | Count stale chunks and candidate documents, write nothing.       |
| `maxDocuments`     | Cap the documents touched in one run. For incremental backfills. |
| `sourceIds`        | Restrict the run to specific sources (up to 1000).               |
| `targetModel`      | Defaults to the configured model. Must equal it.                 |
| `targetDimensions` | Defaults to the configured dimensions. Must equal them.          |

What the run actually does, and the properties you should not break if you edit
it:

- Work is grouped **by document**, and **every** chunk of a touched document is
  re-embedded — not just the stale ones. The contextual model needs the whole
  document in chunk order, and leaving a document with vectors from two runs
  recreates the mixed-vector-space problem this whole exercise exists to avoid.
- Candidate documents are sorted by `_id` so successive capped runs make
  progress through the corpus instead of re-picking the same documents.
- One bad document never aborts the run: the failure is counted
  (`chunksFailed`, incremented by that document's stale-chunk count so the
  number stays comparable with `staleChunks`), logged via `logAppError`, and the
  loop continues.
- Chunks are updated with a `bulkWrite`; the parent document's `embedding` stamp
  is updated to match. `version` and `updatedAt` on the document are **not**
  bumped — a re-embed is not a content revision.
- `ctx.signal` aborts the loop cleanly between documents (event
  `reembed.aborted`), so a Ctrl-C leaves a consistent, partially-migrated state
  that a later run picks up.

### Incremental backfills

For a large corpus, or a provider with a tight rate limit, run it in slices —
`maxDocuments` caps one run, `sourceIds` restricts it (check `--help` for the
flag spellings):

```bash
# a few hundred documents at a time, repeat until staleChunks reaches 0
./scripts/ndocker.sh npm run db:reembed -- --max-documents 200

# or migrate the sources that matter most, first
./scripts/ndocker.sh npm run db:reembed -- --source-ids docs/api,docs/runbook
```

Each run is independent and resumable — the stale filter is recomputed from
provenance every time, so there is no cursor to lose and re-running after a crash
is safe.

---

## Step 5 — Verify

```bash
curl -sS http://localhost:3000/api/embedding-coverage \
  -H "Authorization: Bearer $TOKEN"
```

`embeddingCoverage()` groups every chunk by `(provider, model, dimensions)` and
reports chunk and document counts. **The migration is done when only the new
model appears.** Also worth checking:

- `list_sources` returns an `embeddingModels` array per source; more than one
  entry means that source is mid-backfill.
- `reembed --dry-run` reporting `staleChunks: 0` is the same statement from the
  other direction.
- `GET /readyz` confirms the vector index is queryable at the new width.
- Then actually search. Run real queries you know the answers to. Coverage
  counters prove the vectors were written; only retrieval proves they are good.

---

## Rolling back

There is no undo for a vector: re-embedding overwrites in place. But nothing is
orphaned, because provenance is recorded, so rollback is just the same migration
run in reverse:

1. Set `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` / `EMBEDDING_PROVIDER` back to
   the previous values and restart.
2. If the width changed, drop and recreate the vector index at the old width
   (step 3 again).
3. `npm run db:reembed` — everything now stamped with the new model is stale
   again, and gets converted back.

Cost is another full pass over the corpus. Which is the real argument for
step 4's `sourceIds`: migrate one representative source first, evaluate
retrieval quality on it, and only then commit to the whole corpus.

If the _content_ is still available upstream, a re-ingest (`store_content` with
the same `sourceId`) is equivalent and also refreshes the chunking — but it is
strictly more work than a re-embed, since it re-chunks and rewrites every
document.

---

## Verify the code change itself

```bash
./scripts/ndocker.sh npx tsc --noEmit
./scripts/ndocker.sh npm run lint
./scripts/ndocker.sh npm test
```

Then the integration suite against Atlas Local (exact invocation in `CLAUDE.md`
§13). `tests/integration/reembed.test.ts` covers the backfill against real data
and a real index; `tests/unit/embeddings-*.test.ts` cover provider behaviour
with no network.
