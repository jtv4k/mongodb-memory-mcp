---
name: ingestion-pipeline
description: The validate - chunk - embed - persist contract for this knowledge base, stage by stage, with each stage's invariants and what silently breaks when one is violated. Use before changing the chunker, the embedding provider, the chunk/document schema, or anything in storeContent, and to work out what to re-run to prove the change is safe.
---

# The ingestion pipeline

```
validate  ->  chunk (pure)  ->  embed (contextual, grouped by document)  ->  persist
```

One implementation, in `storeContent()` in `src/services/knowledge-service.ts`.
Every surface — MCP `store_content`, `POST /api/content`, the web UI — goes
through it. There is no second ingestion path and there must never be one.

Each stage may assume exactly what the previous one guarantees, and nothing more.
The failures that matter here are the **silent** ones: a violated invariant
usually does not throw, it just degrades retrieval in a way no test notices.

---

## Stage 1 — Validate

**Where:** `parseInput(storeContentSchema, args, 'store_content')` in the
transport, before the service is called.
**In:** untrusted arguments from an AI client. **Out:** `StoreContentInput`.

Guarantees the rest of the pipeline relies on:

- `content` is a non-empty string of at most `MAX_CONTENT_CHARS` (5,000,000) and
  contains at least one non-whitespace character.
- `contentType` is one of `CONTENT_TYPES` — the chunker switches on it and has no
  default branch worth relying on.
- `tags` are trimmed, lowercased and deduplicated. Filters compare against the
  normalised form; skipping this makes `tags: ['MongoDB']` unfindable.
- `metadata` is JSON-serialisable, under 32KB, has no key starting with `$` and
  no prototype-pollution key. It is persisted verbatim.
- `chunkOverlapTokens < chunkSizeTokens` when both are overridden.

**What breaks if you skip it:** the MCP SDK validates against
`z.object(storeContentShape)` and **cannot see the `superRefine` rules**. Removing
the handler's `parseInput` call silently disables every cross-field check while
leaving the tool apparently working. Validation failures must be
`ValidationError` — they log at `warn` with event `input.validation_failed`,
which is what keeps a caller's bad argument distinguishable from an outage.

---

## Stage 2 — Chunk

**Where:** `chunkContent({ content, contentType, options })` in
`src/chunking/index.ts`, called through `runChunking()` in the service.
**In:** normalised content (`normalizeContent` has already stripped a BOM and
converted CRLF to LF). **Out:** `ChunkingResult { chunks, strategy, stats }`.

### The chunker is pure and must stay pure

No I/O, no clock, no randomness, no logger, no config lookup, no `Date.now()`.
The same input always produces a deeply equal output. This is not stylistic: it
is what makes retrieval quality testable at all, and what lets
`tests/unit/chunking.test.ts` assert exact offsets. If you need configuration,
take it as a parameter (`options: ChunkingConfig`); if you need a different token
counter, pass `countTokens` — and it must be pure too, because the purity of
`chunkContent` is only as good as the counter it is given.

### Invariants the next stages depend on

- `chunk.text === content.slice(chunk.charStart, chunk.charEnd)` — exactly.
  Nothing is injected into the text: no heading breadcrumb, no separator, no
  re-added code fence, no whitespace normalisation. The web UI and the
  highlighting code both rely on this being an exact slice.
- `index` is 0-based and contiguous; the array is in **document order**.
- `charStart`/`charEnd` are strictly increasing across chunks; consecutive
  regions may overlap (`chunks[i].charStart < chunks[i-1].charEnd`).
- `tokenCount === estimateTokens(text)`; no chunk begins or ends with whitespace.
- `strategy` names the code path that ran (`CHUNKING_STRATEGIES`) and is stored
  on the document, so a later targeted re-chunk can select only the documents
  whose splitter changed.

### What breaks silently if you violate them

- **Prefixing the heading breadcrumb into `chunk.text`** looks like an
  improvement (it helps a non-contextual model) and destroys the offset
  guarantee: highlighting windows land in the wrong place and the document view
  shows the wrong region. Our default model already conditions each chunk on its
  siblings, so it buys much less than it costs. If a caller wants it, they can
  prepend from `headingPath` themselves and own the skew.
- **Reordering chunks** breaks the contextual embedding in stage 3. Nothing
  throws. Retrieval just gets worse.
- **Emitting a chunk larger than the model's context** produces an upstream
  error at stage 3, far from the cause.

Failures here are `ChunkingError` — an _ingestion_ fault, logged at `error` with
event `ingest.chunking_failed`, never confused with a caller's bad input.
`runChunking` also treats "zero chunks produced" as a `ChunkingError`, because a
document with no chunks is invisible forever and must not be stored quietly.

---

## Stage 3 — Embed

**Where:** `embedDocument()` in the service, calling
`embeddings.embedDocumentChunks([chunkTexts], { signal })`.
**In:** the chunk texts of **one** document, in order. **Out:** one vector per
chunk, plus token usage and provider info.

### Chunk order is significant

The default model, `voyage-context-3`, is _contextual_: it embeds each chunk
conditioned on its siblings. That is why the provider interface takes
`documents: readonly (readonly string[])[]` — chunks grouped by parent document,
in order — instead of a flat list of strings, and why ingestion makes **one**
call per document rather than a batch loop over chunks. Split a document's
chunks across two calls, or shuffle them, and every vector shifts. Nothing
errors; recall quietly drops.

A non-contextual provider satisfies the same interface by ignoring the grouping,
so callers never branch on it.

### Vector length is checked twice, before anything is written

`embedDocument` rejects the result unless:

1. the number of vectors equals the number of chunks, and
2. **every** vector's length equals `config.embedding.dimensions`.

A wrong width is unrecoverable. Atlas will either reject the write or — worse —
accept it and never match it, so the chunk is silently absent from search
forever. The same width must equal the vector index's `numDimensions`; see the
`vector-index-management` skill.

`src/embeddings/voyage.ts` adds a third guarantee worth preserving: the response
is rebuilt from Voyage's explicit per-entry `index`, never from array position.
Trusting position would attach the wrong vector to the wrong chunk, and every
individual vector would still look plausible.

Failures are `EmbeddingError` (`retryable: true`, event
`ingest.embedding_failed`). Do not let a transport-level failure surface as a
`ValidationError` — the two have different owners and different remediation, and
the log pipeline keys off the distinction.

---

## Stage 4 — Persist

**Where:** `persist()` in the service.
**In:** the document row and the complete new chunk set. **Out:** nothing; the
knowledge base is updated atomically.

- **Chunks are replaced atomically.** The preferred path is a transaction:
  `replaceOne` the document, `deleteMany` the old chunks, `insertMany` the new
  ones. Atlas Local and cloud Atlas are both replica sets, so a concurrent search
  can never observe a document whose chunks are half old and half new.
- **The fallback is bounded and self-healing.** A single transaction is limited
  by the 16MB oplog-entry cap, which a very large document (roughly 1,900+ chunks
  of 1024 float64s) exceeds. The non-transactional path can only ever
  _under_-populate on a crash, never mix generations, and the next
  `storeContent` for the same `sourceId` detects the shortfall (stored
  `chunking.chunkCount` vs actual) and repairs it (event `ingest.repair`).
- **Chunks never become an array on the document.** Their own collection, joined
  by `documentId`. This is a hard rule; see `CLAUDE.md` §0.
- **Denormalised parent fields must be written on every chunk**: `title`, `uri`,
  `contentType`, `tags`, `documentVersion`, `documentContentHash`. Omit one and
  either `$vectorSearch` can no longer filter on it (only indexed chunk fields
  are filterable) or search hits lose their attribution.
- **Provenance must be written flat**: `embeddingProvider`, `embeddingModel`,
  `embeddingDimensions`, `embeddedAt`. Two of these are declared filter paths in
  `chunks.vector.json` and every search query pins them. Nest them and you lose
  the guarantee that a mid-backfill search cannot mix two vector spaces.
- **`version` tracks content revisions only.** A pure re-embed of unchanged text
  does not bump `version` or `updatedAt`.

### Idempotency is driven by the content hash

`computeContentHash()` (sha256 of the normalised content) is the identity.
`storeContent` short-circuits to `outcome: 'unchanged'` — no chunking, no
embedding, no write — only when all three hold:

1. the hash matches the stored document,
2. the actual chunk count matches `document.chunking.chunkCount`, and
3. no chunk is stale (embedded by a different model or width).

Weakening any of those turns a crashed half-ingest into a permanently broken
document that every later call happily skips. `deriveSourceId()` matters for the
same reason: an AI client retrying the identical call must land on the identical
`sourceId`, or it creates a duplicate instead of a no-op.

---

## Changing one stage without breaking the others

**The chunker.** Free to change internally as long as the invariants above hold.
Existing documents keep their old chunks until re-ingested — `strategy` on the
document records which splitter produced them. Re-run
`tests/unit/chunking.test.ts` (it asserts the offset and ordering invariants
directly), then `tests/integration/ingest-search.test.ts` to confirm retrieval
quality did not regress.

**The embedding provider or model.** Do not touch this pipeline. Implement
`EmbeddingProvider`, wire it into `createEmbeddingProvider()`, and follow the
`embedding-model-migration` skill. `factory.ts` has an exhaustive `never` check,
so adding a provider to the env enum without wiring it up is a compile error.

**The chunk schema.** Adding a field means: `ChunkDoc` in `src/domain/types.ts`,
the `chunkDocs` mapping in `storeContent`, and — if anything will ever filter on
it — a `filter` path in `chunks.vector.json` and/or a mapping in
`chunks.text.json`, applied with `npm run db:indexes`. Existing chunks will not
have the field until re-ingested; write the query so a missing field is not a
silent empty result.

**Adding a stage** (a cleaner, a classifier, a dedupe pass). Put it before
chunking if it changes the text — the hash and the offsets are computed from
what chunking sees, so anything that rewrites content after hashing breaks
`chunk.text === content.slice(...)`. Give it its own `AppError` subclass rather
than reusing `ChunkingError`, so its failures stay separable in the logs.

---

## Proving the change

```bash
./scripts/ndocker.sh npx tsc --noEmit
./scripts/ndocker.sh npm run lint
./scripts/ndocker.sh npx vitest run --project unit tests/unit/chunking.test.ts
./scripts/ndocker.sh npm test
```

Then the integration suite against Atlas Local (exact `docker run --network host`
invocation in `CLAUDE.md` §13). `tests/integration/ingest-search.test.ts` is the
round trip that actually proves the pipeline: store realistic multi-section
markdown, search it back, and check attribution, heading path, offsets, the
vector leg genuinely running (`vectorScore` non-null in `mode: 'vector'`),
filters restricting results, and an idempotent re-store reporting `unchanged`.

If retrieval quality is what changed, a green test suite is necessary and not
sufficient — ingest a real corpus into the dev stack and search it by hand.
