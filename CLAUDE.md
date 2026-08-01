# CLAUDE.md — MongoDB RAG KB MCP

Operating notes for anyone — an AI coding session or a human contributor —
working in this repository. Read this before touching anything: it is the
accumulated set of decisions and conventions the code cannot state for itself.

---

## 0. Hard rules — violate none of these

1. **All Node tooling runs inside a container, never on the host.** No host
   `node`, `npm`, `npx`, `tsc`, `vitest` or `eslint`. Use
   `./scripts/ndocker.sh <cmd>` from the project root, or
   `docker compose ... run --rm app <cmd>`. The wrapper pins `HOME`, the XDG
   directories, `TMPDIR` and the npm cache to paths under the bind-mounted
   project (`.container-home/` and `.npm-cache/`, both gitignored), so tooling
   never writes outside the repository.
2. **`.env` is never committed and never read directly.** `.env.example` is the
   checked-in template. Config reaches the process through the environment
   (`env_file` in compose, `--env-file`, or exported vars);
   `src/config/env.ts` reads `process.env` and nothing else.
3. **Index definitions are code.** They live in `src/db/index-definitions/*.json`
   and are applied by `npm run db:indexes`. Never create or edit a search index
   in the Atlas UI — the UI is not the source of truth and cloud Atlas would
   immediately drift from Atlas Local.
4. **Chunks never live in an array on the parent document.** They are their own
   collection (unbounded-array anti-pattern; also the 16MB document limit and
   the fact that a vector index cannot index an array of subdocuments usefully).
5. **Every `/api/*` route requires the bearer token, reads included.** This is a
   product decision, not an oversight: the process is network-reachable and an
   unauthenticated read surface hands the whole knowledge base to anyone who can
   reach the port. The direct consequence is that the server-rendered web pages
   call `KnowledgeService` **in-process** rather than fetching `/api/*`, so no
   token ever reaches a browser. `/healthz`, `/readyz` and static assets are the
   only open routes.

---

## 1. What this is

An MCP server that lets AI clients write into, and read out of, a MongoDB-backed
knowledge base:

- **Ingest** — `store_content` takes raw content plus metadata, splits it with a
  structure-aware chunker, embeds the chunks, and persists document + chunks.
- **Retrieve** — `search_knowledge` runs semantic (`$vectorSearch`), keyword
  (`$search`), or hybrid retrieval and returns ranked chunks with full source
  attribution.
- **Manage** — `list_sources` and `delete_content`, plus a re-embedding backfill.

One long-lived Node process serves three surfaces on one port: the MCP
Streamable HTTP transport, a REST API, and server-rendered EJS pages. Not stdio,
because the process has to be shareable and remotely reachable.

---

## 2. Stack, and why

| Choice                                                 | Why                                                                                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24.18.0, native ESM, TypeScript strict            | Pinned in `.nvmrc`, `engines`, and `node:24-slim`. ESM because everything downstream (the SDK, `tsx`) is ESM-first.                                                                                              |
| MongoDB Atlas (cloud) + Atlas Local for dev/CI         | `mongodb/mongodb-atlas-local:8.0` runs `mongod` **and** `mongot` in one container, so `$search` and `$vectorSearch` behave identically in dev, CI and production. A plain `mongo` image cannot run either stage. |
| `voyage-context-3` @ 1024 dims, cosine, contextual     | See §6.                                                                                                                                                                                                          |
| Express 5 + pino-http + EJS + Tailwind 4               | One process, one port, no SPA build. Views are server-rendered; the only client-side asset is a compiled stylesheet.                                                                                             |
| MCP Streamable HTTP (`@modelcontextprotocol/sdk`)      | Long-lived, network-reachable, shares the process with REST and the UI.                                                                                                                                          |
| zod for all external input                             | Content from an AI client is untrusted. Nothing reaches MongoDB or the embedding provider unvalidated.                                                                                                           |
| App-side reciprocal rank fusion, **not** `$rankFusion` | See §7.                                                                                                                                                                                                          |
| Vitest, split into `unit` and `integration` projects   | See §9.                                                                                                                                                                                                          |

---

## 3. TypeScript facts that trip people up

These are all enforced by `tsconfig.json` and will bite on the first build:

- **`module`/`moduleResolution` are `nodenext`.** Every relative import MUST end
  in `.js`, even when the file on disk is `.ts`:
  ```ts
  import { createKnowledgeService } from '../services/index.js';
  ```
- **`verbatimModuleSyntax: true`.** A type-only import must say so:
  ```ts
  import type { AppConfig } from '../config/env.js';
  ```
  A value and a type from the same module are two import statements, or an
  inline `import { type Foo, bar }` (eslint enforces `inline-type-imports`).
- **`noUncheckedIndexedAccess: true`.** `arr[i]` is `T | undefined` and
  `record[key]` is `V | undefined`. Handle it — `?? fallback`, a `continue`, or
  an explicit throw. Do not reach for `!`.
- **`resolveJsonModule` with import attributes.** JSON imports need
  `with { type: 'json' }` (see `src/db/indexes.ts`).
- **zod is v3 (3.25.76), classic API.** `import { z } from 'zod'`. Do NOT import
  `zod/v4` — the MCP SDK accepts either, but every schema in this repo is v3 and
  mixing them breaks inference.
- No `any` without a comment justifying it. No `@ts-ignore`.
- `exactOptionalPropertyTypes` is **off**, so `{ foo: undefined }` satisfies
  `foo?: string`. Several call sites rely on that (e.g. spreading optional
  `cause` into `AppErrorOptions`).

Style: JSDoc block at the top of every module explaining **why** it exists;
sparse inline comments only where the reason is not evident; single quotes;
2-space indent; 100 columns; trailing commas; named exports only. In prose —
docs, comments, log and error strings — write "MongoDB", never "Mongo".
Identifiers follow the MongoDB drivers' conventions (`MongoClient`-style
`Mongo` prefixes are fine), and `mongod`, `mongot` and the `mongo` image name
stay lowercase.

---

## 4. Directory map

```
src/
  index.ts                  process entrypoint: loadConfig -> logger -> MongoDB -> provider ->
                            service -> app -> listen; graceful shutdown on SIGTERM/SIGINT
  app.ts                    Express assembly order + AppBundle { app, shutdown }
  errors.ts                 AppError + typed subclasses; the `kind` discriminant is what keeps
                            ingestion faults distinguishable from validation faults
  redact.ts                 secret scrubbing for any text leaving the process; shared by MCP
                            and HTTP so an AppError cannot be safe on one and leak on the other
  logger.ts                 pino factory, secret redaction, logAppError(), requestLogger()
  config/env.ts             the ONLY place env is read; zod schema -> AppConfig slices
  domain/types.ts           DocumentDoc, ChunkDoc, ChunkView, Chunk, SearchHit + every result type
  domain/schemas.ts         zod shapes/schemas for all external payloads + parseInput()
  db/client.ts              connectMongo(), pingMongo(), MongoConnection
  db/collections.ts         COLLECTIONS, documentsCollection(), chunksCollection(),
                            CHUNK_VIEW_PROJECTION (excludes the vector)
  db/indexes.ts             ensureIndexes(), planIndexes(), waitForSearchIndex(),
                            searchIndexIsQueryable(), STANDARD_INDEXES, drift detection
  db/index-definitions/     chunks.vector.json, chunks.text.json, documents.text.json — canonical
  cli/setup-indexes.ts      `npm run db:indexes` entrypoint (--dry-run, --no-wait, --timeout)
  cli/reembed.ts            `npm run db:reembed` entrypoint
  chunking/index.ts         chunkContent() — PURE. Structure-aware splitting + packing + overlap
  chunking/markdown.ts      line scanner, block parser, heading-stack breadcrumb
  chunking/tokens.ts        estimateTokens() — the default TokenCounter
  embeddings/provider.ts    EmbeddingProvider interface, embedQuery(), batchDocuments()
  embeddings/voyage.ts      VoyageEmbeddingProvider (contextual + flat endpoints)
  embeddings/fake.ts        FakeEmbeddingProvider — deterministic hashed bag-of-words
  embeddings/factory.ts     createEmbeddingProvider() — the only module naming a concrete provider
  services/types.ts         KnowledgeService, KnowledgeServiceDeps, RequestContext
  services/index.ts         barrel: createKnowledgeService + search-fusion + highlight re-exports
  services/knowledge-service.ts  the entire business logic: ingest, search, manage, re-embed
  services/search-fusion.ts reciprocalRankFusion() — pure, synchronous, no I/O
  services/highlight.ts     snippet windowing + the escape-then-<mark> HTML boundary
  services/identity.ts      normalizeContent(), computeContentHash(), deriveSourceId(), deriveTitle()
  mcp/server.ts             TOOL_NAMES + createMcpServer() — composition root, no logic
  mcp/http.ts               createMcpHttpHandler(): session map, transport lifecycle, closeAll()
  mcp/auth.ts               createMcpAuthMiddleware() — timing-safe bearer / x-api-key check
  mcp/tools/shared.ts       ToolDeps, runTool(), toolResult(), text formatters; re-exports
                            redactSecrets from redact.ts
  mcp/tools/*.ts            one module per tool, each exporting register<Tool>Tool()
  mcp/tools/rejections.ts   wraps the SDK's tools/call handler so argument rejections log
                            mcp.tool_rejected instead of vanishing
  http/request-id.ts        requestIdMiddleware(), getRequestId(), createRequestContext()
  http/health.ts            /healthz (liveness, no deps) and /readyz (MongoDB + vector index)
  http/api.ts               the authenticated REST router
  http/errors.ts            404 handler + final error handler (AppError -> status + payload)
  http/web.ts               server-rendered routes; calls KnowledgeService directly
  views/**.ejs              layout, search, documents, document, error, partials
  styles/tailwind.css       Tailwind 4 CSS-first input; compiles to src/public/css/app.css
docker/                     Dockerfile (multi-stage), compose base + dev override, atlas-local/
scripts/ndocker.sh          the containerised node wrapper — read it before writing any docker run
scripts/copy-assets.mjs     copies views/ + public/ into dist/ after tsc
tests/unit/                 no DB, no network
tests/integration/          real Atlas Local, randomised database name
```

---

## 5. Data model

Two collections. Real field names, from `src/domain/types.ts`.

### `documents`

`_id`, `sourceId` (unique), `title`, `uri`, `contentType`, `content` (verbatim),
`contentHash` (sha256 of the normalised content), `contentLength`, `tags[]`,
`metadata`, `ingest { agent, sessionId, clientName, clientVersion, at, channel }`,
`chunking { strategy, chunkSizeTokens, chunkOverlapTokens, chunkCount }`,
`embedding { provider, model, dimensions, contextual }`, `version`, `createdAt`,
`updatedAt`.

`version` tracks **content** revisions only. A pure re-embed of unchanged text
does not bump it and does not touch `updatedAt`, so "recently updated" stays
meaningful during a backfill.

### `chunks`

`_id`, `documentId`, `sourceId`, `chunkIndex`, `text`, `charStart`, `charEnd`,
`tokenCount`, `headingPath[]`, then the denormalised parent fields — `title`,
`uri`, `contentType`, `tags[]`, `documentVersion`, `documentContentHash` — then
the vector and its provenance: `embedding` (`number[1024]`),
`embeddingProvider`, `embeddingModel`, `embeddingDimensions`, `embeddedAt`, plus
`createdAt` / `updatedAt`.

**Why chunks denormalise the parent's fields.** `$vectorSearch` can only filter
on paths declared in the vector index, and the index is on `chunks`. A filter on
`tags` or `contentType` therefore has to read those values off the chunk itself.
The same copies mean every search hit carries attribution (title, uri, source)
with no `$lookup` per hit. The cost is that re-ingest must rewrite the whole
chunk set — which it does anyway, because the text changed.

**Why embedding provenance is flat.** `embeddingProvider`, `embeddingModel`,
`embeddingDimensions` and `embeddedAt` are top-level scalars, not a nested
`embedding: { … }` object, because two of them are declared **filter paths** in
`chunks.vector.json`. Every vector query pins
`embeddingModel == config.embedding.model` and
`embeddingDimensions == config.embedding.dimensions`, which is what makes a
half-finished migration safe: a mid-backfill search returns _fewer_ results
rather than silently ranking two incompatible vector spaces against each other.
A nested object would not be filterable and the guarantee would be gone.

Standard (b-tree) indexes are declared in `STANDARD_INDEXES` in
`src/db/indexes.ts`, each with a `why` string naming the query it serves. If
nothing runs that query, delete the index.

---

## 6. The embedding decision

- **Model:** `voyage-context-3`, **1024** dimensions, **cosine**.
- **Contextual.** The model embeds each chunk conditioned on the sibling chunks
  of the same document. That is why `EmbeddingProvider.embedDocumentChunks()`
  takes `documents: readonly (readonly string[])[]` — chunks grouped by parent,
  **in order** — and not a flat list of strings. Reordering or splitting a
  document's chunks across calls silently degrades retrieval quality with no
  error anywhere.
- Voyage serves contextual models from `POST /contextualizedembeddings` and every
  other model from `POST /embeddings`. `src/embeddings/voyage.ts` is the only
  module that knows this; the flat branch flattens on the way out and re-splits
  on the way back so callers see the same nested shape either way.
- The response is rebuilt from Voyage's explicit per-entry `index`, never from
  array position. Trusting position would attach the wrong vector to the wrong
  chunk — a corruption nothing downstream could detect, because each vector is
  individually plausible.
- **`EMBEDDING_DIMENSIONS` must equal the vector index `numDimensions`.** The
  JSON holds the shipped default (1024) and `buildVectorIndexDefinition()`
  overrides it from config at apply time, so `db:indexes` keeps them in sync —
  but only if you re-run it. A mismatch is not a silent wrong answer, it is a
  `$vectorSearch` failure that reads like a data problem; `ensureIndexes` logs
  `index.dimension_override` when config and the checked-in value disagree.
- `FakeEmbeddingProvider` reports the **configured** model and dimensions, not
  its own name, so provenance stamps and vector widths stay consistent with the
  index whichever provider is selected.

---

## 7. Search

`searchKnowledge` has three modes: `vector`, `text`, `hybrid` (the default when
`SEARCH_HYBRID_ENABLED`).

**Hybrid is two aggregations fused in application code, deliberately not
`$rankFusion`.** Reasons, in order of importance:

1. Atlas Local 8.0 and cloud Atlas then behave identically — no
   "works locally, ranks differently in prod".
2. The ranking becomes a pure function (`src/services/search-fusion.ts`) and is
   unit-tested exhaustively without a database.
3. We keep the per-leg raw scores and ranks on every hit for display and
   debugging, which a server-side fusion stage does not surface.

The fusion itself is reciprocal rank fusion: each leg contributes
`weight / (k + rank)` with `k = SEARCH_RRF_K` (default 60) and
`weight = SEARCH_VECTOR_WEIGHT` for the vector leg, `1 - that` for text. Raw
scores are thrown away on purpose — a `$vectorSearch` cosine score in a narrow
`[0,1]` band and an unbounded Lucene BM25 score have no fixed transform between
them, so only the _ordering_ is comparable. Ties break lexicographically on
`chunkId` so results are stable between calls.

Both legs over-fetch (`limit * 4`, floored at 20, capped at 500) so a chunk
ranked 11th by both legs — the classic hybrid win — can still surface.

**Graceful degradation.** If the text leg fails, `hybrid` falls back to
`effectiveMode: 'vector'` and still answers; only an explicit `mode: 'text'`
request turns the failure into an error. This matters because on a fresh
knowledge base the text index is routinely still building while the vector index
is already queryable. A missing text index is logged once
(`search.text_index_unavailable`) rather than once per query, and the flag resets
on the first successful text leg so recovery is visible too. A missing **vector**
index is fatal — silently returning nothing would send an operator hunting for
content that is sitting right there.

Atlas Local answers a query against a non-existent index with an empty result
set rather than an error, so "zero hits" is ambiguous. `confirmIndex()` resolves
it with a `listSearchIndexes` probe, but only when a leg came back empty, and it
caches the first success so the hot path never pays.

**Browse search is separate from all of this.** The `search` parameter on
`list_sources` / `list_documents` / the `/documents` page is a `wildcard`
`$search` against the documents text index, whose keywordLowercase analyzer
indexes each field's whole value as one lowercased term — a true
case-insensitive substring match, served by the index. It is deliberately NOT a
`$regex`: a case-insensitive regex can never use an index, anchored or not.
Like the vector leg, a missing documents index is fatal (the error says to run
`db:indexes`), and MongoDB Search consistency applies — a just-stored document
appears in browse search after a beat.

---

## 8. The ingestion contract

`validate → chunk (pure) → embed (contextual, grouped) → persist`. Each stage may
assume exactly what the previous one guarantees, and nothing more.

**1. Validate** — `parseInput(storeContentSchema, args, 'store_content')`. The
MCP SDK validates against `z.object(shape)` and **cannot see cross-field
`superRefine` rules**, so the handler must re-parse with the full schema. Output:
normalised input — tags lowercased and deduped, `contentType` defaulted (with
MIME-style aliases like `text/markdown` folded onto the enum first), metadata
size- and key-checked. Failures are `ValidationError` (caller's fault, logged
at `warn`).

**2. Chunk** — `chunkContent({ content, contentType, options })`. Pure: no I/O,
no clock, no randomness, no logger, no config lookup. Guarantees the next stage
relies on:

- `chunk.text === content.slice(chunk.charStart, chunk.charEnd)` exactly —
  nothing is injected into the text, not even the heading breadcrumb.
- `index` is 0-based and contiguous; order is document order.
- `tokenCount === estimateTokens(text)`; no chunk starts or ends with whitespace.

Failures are `ChunkingError` (an _ingestion_ fault, logged at `error`, event
`ingest.chunking_failed`).

**3. Embed** — `embedDocumentChunks([chunkTexts])`, one call per document, chunks
in order, because the model is contextual. The service then checks two things
before anything is written: the vector count equals the chunk count, and every
vector's length equals `config.embedding.dimensions`. A wrong width is
unrecoverable — the index would either reject the write or accept it and never
match. Failures are `EmbeddingError` (retryable, event
`ingest.embedding_failed`).

**4. Persist** — preferred path is a transaction: replace the document, delete
the old chunks, insert the new ones. Atlas Local and cloud Atlas are both replica
sets, so a concurrent search can never see half-old/half-new chunks. The fallback
(non-transactional replace → delete → insert) exists only for documents whose
chunk set exceeds the 16MB oplog-entry limit; it can under-populate on a crash
but never mix generations, and the next `storeContent` for the same `sourceId`
detects the shortfall (stored `chunking.chunkCount` vs actual) and repairs it.

**Idempotency** is driven by `contentHash`. Same hash + complete, current chunk
set ⇒ `outcome: 'unchanged'`, no chunking, no embedding, no write. Same hash but
chunks missing or embedded by a different model ⇒ re-ingest (event
`ingest.repair`).

---

## 9. Testing

Two Vitest projects, defined in `vitest.config.ts`.

- **`unit`** — `tests/unit/**`. Never touches a database or the network. Every
  HTTP call is mocked; every DB dependency is a fake object. `npm test` runs
  only this and is the gate everything else waits on in CI.
- **`integration`** — `tests/integration/**`. Real Atlas Local, real index
  creation, real `$vectorSearch`. Each run generates a randomised database name
  (`ragkb_test_<random>`) and **checks it is not already in use** before
  claiming it, so concurrent local and CI runs cannot collide; teardown drops it
  even when a test fails. Runs sequentially in one fork (`singleFork`) because
  search-index creation is heavy and Atlas Local is a single node.
  `EMBEDDING_PROVIDER=fake` — CI has no API key, a fork PR has no secrets, and a
  Voyage outage must not turn every build red. The fake emits real 1024-dim
  vectors with genuine semantic signal, so retrieval assertions are meaningful.
- **Live Voyage** — `tests/integration/live-voyage.test.ts` is opt-in: it needs a
  real `VOYAGE_API_KEY` and is not part of any default run.

MongoDB Search is eventually consistent: after an insert a chunk is not instantly
searchable. Poll for it; never `sleep` and hope.

---

## 10. Observability

pino, one JSON object per line to stdout. `LOG_PRETTY=true` swaps in
`pino-pretty` for dev.

- **Redaction is structural**, not opportunistic: `authorization`, `x-api-key`,
  `cookie`, `set-cookie`, `apiKey`, `authToken`, `VOYAGE_API_KEY`,
  `MCP_AUTH_TOKEN`, and `embedding` / `embeddings` / `*.embedding` (so a 1024-float
  vector never reaches a log line).
- **Request ids.** `requestIdMiddleware()` assigns one per HTTP request, echoes
  it in the `x-request-id` response header, and `requestLogger()` binds it to a
  child logger. An inbound `x-request-id` is only reused if it matches a
  conservative character class — it is attacker-controlled and lands in both a
  header and the logs. MCP tool calls mint their own id via `randomUUID()`.
- **Ingestion failures log distinctly from validation failures.** This is a spec
  requirement and `logAppError()` enforces it by mapping `AppError.kind` to a
  level and a stable, greppable `event` string. Always use `logAppError`, never
  `logger.error({ err })`:

  | kind         | level | event                     |
  | ------------ | ----- | ------------------------- |
  | `config`     | fatal | `config.invalid`          |
  | `validation` | warn  | `input.validation_failed` |
  | `auth`       | warn  | `auth.rejected`           |
  | `not_found`  | warn  | `resource.not_found`      |
  | `chunking`   | error | `ingest.chunking_failed`  |
  | `embedding`  | error | `ingest.embedding_failed` |
  | `storage`    | error | `storage.failed`          |
  | `search`     | error | `search.failed`           |
  | `index`      | error | `index.unavailable`       |
  | `internal`   | error | `internal.error`          |

  Other stable events worth knowing: `mongo.connected`,
  `embedding.provider_selected`, `index.created` / `index.updated` /
  `index.unchanged` / `index.dimension_override` / `index.setup_complete`,
  `ingest.unchanged`, `ingest.repair`, `ingest.transaction_unavailable`,
  `search.text_index_unavailable`, `content.deleted`, `reembed.dry_run`,
  `reembed.completed`, `mcp.tool_succeeded`, `mcp.tool_failed`,
  `mcp.tool_rejected`, `mcp.rejection_hook_unavailable`, `auth.throttled`,
  `mcp.session_expired`, `mcp.sessions_exhausted`.

---

## 11. Configuration

`src/config/env.ts` is the only module that reads the environment. It validates
once at startup and throws `ConfigError` listing **every** problem at once — one
crash tells you about all the misconfigured variables. Services depend on the
nested slices (`config.mongo`, `config.embedding`, …), never on the flat record,
which keeps their signatures honest and makes them trivial to construct in tests.

Required with no default: `MONGODB_URI`, `MONGODB_DB_NAME`, `MCP_AUTH_TOKEN`
(min 16 chars), and `VOYAGE_API_KEY` whenever `EMBEDDING_PROVIDER=voyage` (the
default). Everything else has a working default — read the schema rather than
guessing.

Cross-field rules the schema enforces: `CHUNK_OVERLAP_TOKENS <
CHUNK_SIZE_TOKENS`; `CHUNK_MIN_TOKENS <= CHUNK_SIZE_TOKENS`;
`SEARCH_DEFAULT_LIMIT <= SEARCH_MAX_LIMIT`; and `EMBEDDING_DIMENSIONS` must be
one of the model's supported widths (`2048 | 1024 | 512 | 256` for the known
Voyage Matryoshka models).

**Production-only rules.** When `NODE_ENV=production` the schema additionally
rejects a weak `MCP_AUTH_TOKEN` (under 24 characters, fewer than 10 distinct
characters, or containing a placeholder marker such as `changeme` or
`not-a-secret`) and a bare `TRUST_PROXY=true`. Neither fires in development or
test, so the dev stack's obviously-fake token and CI's dummy still work.

**`TRUST_PROXY` is not a boolean any more.** It accepts `false`/`no`/`off`/`0`,
`true`/`yes`/`on`, a hop count (`1`, `2`, …), or a trusted address list
(`loopback,10.0.0.0/8`). A bare number is read as a HOP COUNT, so `TRUST_PROXY=1`
means "one proxy in front of me" rather than "trust everything" — Express's
`true` trusts the whole `X-Forwarded-For` chain, which makes `req.ip`
client-controlled, and `req.ip` is both the audit field and the key the
failed-auth throttle in `src/mcp/auth.ts` uses.

Adding a variable means touching four places: the zod schema, the matching
`*Config` interface, `buildConfig()`, and `.env.example`. If it should be
settable from the host environment for a container, also add it to the
`environment:` list in `docker/docker-compose.yml`.

---

## 12. Running it

Dev stack (Atlas Local + the app in watch mode). **Both `-f` flags, always** —
the dev file is an override and is not usable alone:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up
```

First boot of Atlas Local takes 20–40s (replica-set init + `mongot` start); the
healthcheck allows 90s. The app waits on `service_healthy`.

Apply the index definitions into the running stack:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  run --rm app npm run db:indexes
```

Then the UI is at <http://localhost:3000/search> and the MCP endpoint at
`http://localhost:3000/mcp`.

Tear down / reset local MongoDB state: see `docker/atlas-local/README.md`. Search
indexes live in `docker/atlas-local/mongot/data/` — wiping it means re-running
`db:indexes`.

---

## 13. Common tasks (exact commands)

All Node tooling goes through the container wrapper. Run from the project root.

```bash
# typecheck the whole project (the thing that catches cross-module drift)
./scripts/ndocker.sh npx tsc --noEmit

# lint everything, or one file
./scripts/ndocker.sh npm run lint
./scripts/ndocker.sh npx eslint src/services/knowledge-service.ts

# format
./scripts/ndocker.sh npm run format          # write
./scripts/ndocker.sh npm run format:check    # CI's check

# unit tests (no DB, no network)
./scripts/ndocker.sh npm test
./scripts/ndocker.sh npx vitest run --project unit tests/unit/chunking.test.ts

# integration tests — needs Atlas Local reachable on 127.0.0.1:27017.
# --network host, and HOME/XDG/TMPDIR pinned inside /app so nothing is
# written outside the project.
mkdir -p .container-home/tmp
docker run --rm --network host -u "$(id -u):$(id -g)" -v "$PWD":/app -w /app \
  -e HOME=/app/.container-home \
  -e XDG_CACHE_HOME=/app/.container-home/.cache \
  -e XDG_CONFIG_HOME=/app/.container-home/.config \
  -e TMPDIR=/app/.container-home/tmp \
  -e npm_config_cache=/app/.npm-cache \
  -e MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
  -e EMBEDDING_PROVIDER=fake \
  -e MCP_AUTH_TOKEN=0123456789abcdef0123456789abcdef \
  node:24-slim npx vitest run --project integration

# index management
./scripts/ndocker.sh npm run db:indexes -- --dry-run     # read-only plan
./scripts/ndocker.sh npm run db:indexes                  # apply and wait
./scripts/ndocker.sh npm run db:indexes -- --no-wait     # submit, do not block

# re-embedding backfill
./scripts/ndocker.sh npm run db:reembed -- --dry-run

# production image
docker build -f docker/Dockerfile --target prod -t ragkb-app:local .
```

`npm run db:indexes` needs `MONGODB_URI`/`MONGODB_DB_NAME` in its environment;
from the host wrapper, pass them with `-e` on a `docker run`, or run it through
`docker compose ... run --rm app` where compose supplies them.

---

## 14. When you change something

- **A chunking rule** → `tests/unit/chunking.test.ts`, then
  `tests/integration/ingest-search.test.ts`. Existing documents keep their old
  chunks until re-ingested; `document.chunking.strategy` records which splitter
  produced them, so a targeted re-chunk is possible.
- **An index definition** → `npm run db:indexes -- --dry-run` first, then apply.
  `numDimensions` and `similarity` generally cannot be updated in place: that is
  drop + recreate + re-embed. See `.claude/skills/vector-index-management`.
- **The embedding model or provider** →
  `.claude/skills/embedding-model-migration`. There is a correct order and
  getting it wrong strands the corpus.
- **A new MCP tool** → `.claude/skills/add-mcp-tool`.
- **Anything in the ingest path** → `.claude/skills/ingestion-pipeline` for what
  each stage may and may not assume.
- **Any text filter, substring search or case-insensitive lookup** →
  `.claude/skills/indexed-text-matching` — why a case-insensitive `$regex` can
  never use an index, and the recipe that can.
- **Never commit without running** `tsc --noEmit`, `npm run lint` and
  `npm test`. The pre-commit hook covers lint-staged and the typecheck in the
  `tooling` container (`git config core.hooksPath .husky` once per clone); the
  tests are on you, and CI gates on them.
