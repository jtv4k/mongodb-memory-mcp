# MongoDB RAG KB MCP

An MCP server backed by a MongoDB knowledge base.

AI clients hand it content over the [Model Context Protocol](https://modelcontextprotocol.io);
it splits that content with a structure-aware chunker, embeds the chunks with
Voyage AI, and stores them in MongoDB with Atlas Vector Search + Atlas Search
indexes. Anything stored can then be retrieved semantically — by an MCP client,
by a REST call, or through a small server-rendered web UI — with the source
document, heading breadcrumb and relevance score attached to every hit.

One Node process serves all three surfaces on one port:

| Surface               | Where                   | Auth                               |
| --------------------- | ----------------------- | ---------------------------------- |
| MCP (Streamable HTTP) | `POST/GET/DELETE /mcp`  | bearer token                       |
| REST API              | `/api/*`                | bearer token — **including reads** |
| Web UI                | `/search`, `/documents` | none (server-rendered, read-only)  |
| Health probes         | `/healthz`, `/readyz`   | none                               |

MCP tools: `store_content`, `search_knowledge`, `list_sources`,
`delete_content`.

---

## Prerequisites

- **Docker** and **Docker Compose v2+**. That is the whole list.
- **You do not need Node on your machine.** This is unusual, so to be explicit:
  every `npm`, `tsc`, `vitest` and `eslint` invocation in this repo runs inside a
  pinned `node:24-slim` container. `./scripts/ndocker.sh` is the wrapper; the dev
  stack runs the app in a container too. Installing Node locally is not
  required and not used.
- A **Voyage AI API key** for real ingestion (<https://voyageai.com>). Not needed
  for tests — those run against a deterministic offline embedder.
- Roughly 4 GB of free RAM for the Atlas Local container. It has been
  OOM-killed on smaller machines.

---

## First run

### 1. Create your env file

```bash
cp .env.example .env
```

`.env` is gitignored and must never be committed.

**Must be filled in:**

| Variable          | Notes                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOYAGE_API_KEY`  | Required whenever `EMBEDDING_PROVIDER=voyage`, which is the default. Set `EMBEDDING_PROVIDER=fake` to run the whole stack with no key at all (useful for a first look; the vectors are real but the semantics are crude). |
| `MCP_AUTH_TOKEN`  | Minimum 16 characters. Generate one: `openssl rand -hex 32`                                                                                                                                                               |
| `MONGODB_URI`     | Only for the production/cloud-Atlas stack. The dev stack sets it for you (see below).                                                                                                                                     |
| `MONGODB_DB_NAME` | Same — dev defaults to `rag_kb_dev`.                                                                                                                                                                                      |

**Working defaults for everything else**, including
`EMBEDDING_MODEL=voyage-context-3`, `EMBEDDING_DIMENSIONS=1024`,
`CHUNK_SIZE_TOKENS=512`, `CHUNK_OVERLAP_TOKENS=64`, `PORT=3000`, `MCP_PATH=/mcp`,
`SEARCH_HYBRID_ENABLED=true`. The full schema, with the defaults and the
cross-field rules, is `src/config/env.ts` — that file is the source of truth.

> **Dev-stack precedence gotcha.** `docker/docker-compose.dev.yml` sets
> `NODE_ENV`, `LOG_LEVEL`, `LOG_PRETTY`, `MONGODB_URI`, `MONGODB_DB_NAME` and
> `MCP_AUTH_TOKEN` directly in its `environment:` block, and an entry there beats
> `env_file: ../.env`. `MONGODB_URI` must be overridden — dev's database lives on
> the compose network, not wherever `.env` points. The consequence is that in dev
> your `.env` value for `MCP_AUTH_TOKEN` is **ignored** unless you also make it
> visible to compose's interpolation:
>
> ```bash
> docker compose --env-file .env \
>   -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up
> ```
>
> Without `--env-file`, dev falls back to the obviously-not-a-secret token
> `dev-local-token-not-a-secret`. That is fine on a laptop and unacceptable
> anywhere reachable. `VOYAGE_API_KEY` is _not_ affected — it is passed through
> from `env_file` normally.

### 2. Bring up the dev stack

Always pass **both** `-f` files. The dev file is an override and does nothing on
its own.

```bash
docker compose --env-file .env \
  -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up
```

This starts two services:

- **`mongodb`** — `mongodb/mongodb-atlas-local:8.0`, published on `localhost:27017`.
  It runs `mongod` _and_ `mongot`, which is why `$search` and `$vectorSearch`
  work locally exactly as they do in cloud Atlas.
- **`app`** — the server in `tsx watch` mode with `src/` bind-mounted, published
  on `localhost:3000`. Edits from your editor reload with no rebuild.

First boot takes 20–40 seconds while Atlas Local initialises a single-node
replica set and starts `mongot`. The app waits for it. Watch progress with
`docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml logs -f mongodb`.

### 3. Apply the index definitions

Search will return nothing until you do this. The definitions live in
`src/db/index-definitions/*.json` and are applied as code — never by hand in the
Atlas UI.

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  run --rm app npm run db:indexes
```

It prints a table of every standard, Atlas Search and Vector Search index with
`created` / `updated` / `unchanged` and whether each is queryable, then waits for
the search indexes to finish building. Re-running it is safe and idempotent —
it is the deploy-time migration step. Add `-- --dry-run` to see the plan without
writing anything.

### 4. Open the UI

<http://localhost:3000/search> — search box, ranked results with source, heading
breadcrumb, score and highlighted snippet.
<http://localhost:3000/documents> — browse what has been ingested.

---

## Using the REST API

Every `/api/*` route requires the token, **reads included**. That is deliberate:
the process is network-reachable, and an open read surface would hand the entire
knowledge base to anyone who can reach the port.

```bash
export TOKEN='<your MCP_AUTH_TOKEN>'
export BASE='http://localhost:3000'

# Store a document
curl -sS -X POST "$BASE/api/content" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "sourceId": "demo/vector-search",
        "title": "Atlas Vector Search notes",
        "contentType": "markdown",
        "tags": ["mongodb", "demo"],
        "content": "# Atlas Vector Search\n\nThe $vectorSearch stage performs approximate nearest-neighbour search over an indexed vector field.\n\n## Filters\n\nA field must be declared as a filter path in the index before it can be filtered on."
      }'

# Search it back
curl -sS -G "$BASE/api/search" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'q=how do I filter a vector search' \
  --data-urlencode 'limit=5' \
  --data-urlencode 'mode=hybrid'

# What is in there?
curl -sS "$BASE/api/sources" -H "Authorization: Bearer $TOKEN"

# Remove it again
curl -sS -X DELETE "$BASE/api/content?sourceId=demo/vector-search" \
  -H "Authorization: Bearer $TOKEN"
```

Full route list:

| Method   | Path                                                                  | Service call                                                             |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST`   | `/api/content`                                                        | `storeContent` — 201 when created, 200 when updated or unchanged         |
| `GET`    | `/api/search?q=&limit=&mode=&tags=&sourceIds=&minScore=&includeText=` | `searchKnowledge`                                                        |
| `GET`    | `/api/sources?limit=&offset=&tag=&search=&sort=&order=`               | `listSources`                                                            |
| `GET`    | `/api/documents?limit=&offset=&tag=&search=`                          | `listDocuments`                                                          |
| `GET`    | `/api/documents/:id`                                                  | `getDocument` — accepts an ObjectId **or** a `sourceId`; 404 when absent |
| `DELETE` | `/api/content`                                                        | `deleteContent` — selector in the body or the query string               |
| `GET`    | `/api/embedding-coverage`                                             | which embedding models the corpus actually contains                      |

List parameters accept both `?tags=a,b` and `?tags=a&tags=b`.

---

## Connecting an MCP client

The transport is **Streamable HTTP** at `http://localhost:3000/mcp` (configurable
with `MCP_PATH`), authenticated with the same bearer token. For a client that
reads an `mcp.json`-style config:

```json
{
  "mcpServers": {
    "rag-kb": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <your MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Sanity check with curl — an unauthenticated request must be rejected:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp"       # 401
```

---

## Development commands

All Node tooling runs in a container. Run these from the project root.

```bash
./scripts/ndocker.sh npm run typecheck      # tsc --noEmit over the whole project
./scripts/ndocker.sh npm run lint           # eslint
./scripts/ndocker.sh npm run format:check   # prettier, the CI check
./scripts/ndocker.sh npm run format         # prettier, write
./scripts/ndocker.sh npm test               # unit tests: no database, no network
```

Run a single unit file:

```bash
./scripts/ndocker.sh npx vitest run --project unit tests/unit/chunking.test.ts
```

### Integration tests

These need Atlas Local reachable on `127.0.0.1:27017`. The dev stack publishes
it there. Each run picks a randomised, conflict-checked database name
(`ragkb_test_…`) and drops it afterwards, so it will not disturb your dev data,
and concurrent runs cannot collide. They use the deterministic offline embedder,
so **no Voyage key is required**.

`ndocker.sh` uses the default bridge network, from which the published port is
not reachable on Linux, so run this one on the host network — still a container,
so the no-host-Node rule holds:

```bash
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
```

`HOME`, the XDG directories, `TMPDIR` and the npm cache are pinned inside `/app`
on purpose: this project never writes outside its own directory.

### Pre-commit hook

Lint-staged plus a whole-project typecheck, both in a container. Install once per
clone (npm's `prepare` cannot do it from inside a container with no git):

```bash
git config core.hooksPath .husky
```

---

## Building the production image

`docker/Dockerfile` is multi-stage; `prod` is the default target.

```bash
docker build -f docker/Dockerfile -t ragkb-app:local .
```

It compiles TypeScript, builds the Tailwind stylesheet, copies `views/` and
`public/` into `dist/`, then assembles a runtime image with production
dependencies only, running as the unprivileged `node` user with a `HEALTHCHECK`
on `/healthz`.

The production compose stack has **no database service** — production points at
cloud Atlas via `MONGODB_URI`:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Apply the same index definitions to the cloud cluster with the same command
(`npm run db:indexes`); only `MONGODB_URI` differs.

---

## Project layout

| Path                         | What lives there                                                      |
| ---------------------------- | --------------------------------------------------------------------- |
| `src/index.ts`, `src/app.ts` | Process entrypoint and Express assembly                               |
| `src/config/env.ts`          | The only module that reads the environment; zod-validated `AppConfig` |
| `src/domain/`                | Persistence types and every zod schema for external input             |
| `src/db/`                    | Connection, typed collections, index management                       |
| `src/db/index-definitions/`  | **Canonical** Atlas Search / Vector Search JSON                       |
| `src/chunking/`              | Pure, structure-aware chunker                                         |
| `src/embeddings/`            | `EmbeddingProvider` interface, Voyage provider, offline fake, factory |
| `src/services/`              | `KnowledgeService` — all business logic; rank fusion; highlighting    |
| `src/mcp/`                   | MCP server, Streamable HTTP transport, auth, one module per tool      |
| `src/http/`                  | REST router, health probes, request ids, error handling, web routes   |
| `src/views/`, `src/styles/`  | EJS templates and the Tailwind input stylesheet                       |
| `src/cli/`                   | `db:indexes` and `db:reembed` entrypoints                             |
| `tests/unit/`                | No database, no network                                               |
| `tests/integration/`         | Real Atlas Local, real vector index                                   |
| `docker/`                    | Dockerfile, compose base + dev override, Atlas Local bind mounts      |
| `scripts/ndocker.sh`         | The containerised Node wrapper                                        |
| `CLAUDE.md`                  | Architecture and conventions, for AI sessions and humans alike        |
| `SPEC.md`                    | The original product spec                                             |

---

## Troubleshooting

**Atlas Local takes forever to come up / the app exits before Mongo is ready.**
First boot has to initialise a replica set and start `mongot`; 20–40 seconds is
normal on a warm image and longer on a cold one. The compose healthcheck allows
90 seconds and the app waits on `service_healthy`, so just wait and watch
`docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml logs -f mongodb`.
If the container restart-loops or exits 137, it was OOM-killed — give Docker more
memory.

**Search returns nothing even though I stored content.** Almost always one of:

1. `npm run db:indexes` was never run against this database. Run it.
2. The index exists but is still building. `GET /readyz` reports the vector
   index specifically, and `npm run db:indexes -- --dry-run` prints a
   `QUERYABLE` column. Atlas Search is eventually consistent — a just-inserted
   chunk is not instantly searchable.
3. You recreated the Mongo container without the `mongot` bind mount, in which
   case the search index data was discarded. See
   `docker/atlas-local/README.md`; re-run `db:indexes`.

Note that a missing **text** index degrades hybrid search to vector-only rather
than failing (you will see one `search.text_index_unavailable` warning); a
missing **vector** index is a hard error telling you to run `db:indexes`.

**Dimension mismatch.** `EMBEDDING_DIMENSIONS` must equal the vector index's
`numDimensions`. `db:indexes` injects the configured value into the definition
when it applies it, and logs `index.dimension_override` when config disagrees
with the checked-in default. If the index already exists at a different width,
the migration **refuses to change it in place** and tells you what to do:
neither `numDimensions` nor `similarity` can be updated on all deployments, so it
is drop → recreate → re-embed the whole collection (`npm run db:reembed`), which
is an operator decision, not something a migration script should do for you.

**`401` from `/mcp` or `/api/...`.** Send
`Authorization: Bearer <MCP_AUTH_TOKEN>`. Every `/api/*` route needs it,
including `GET`s — that is intentional. In the dev stack the effective token is
whatever compose interpolated, which is `dev-local-token-not-a-secret` unless you
passed `--env-file .env` (see the precedence note above). Confirm what the
container is actually using with
`docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml config`.

**Atlas Local restart-loops with permission errors on the bind mounts.** The
image runs as uid/gid `1000:1000`. If your host account is not uid 1000, `mongod`
cannot write to `docker/atlas-local/`:

```bash
sudo chown -R 1000:1000 docker/atlas-local
```

Full details, including the shared `mongod`↔`mongot` keyfile and how to reset
local state, are in `docker/atlas-local/README.md`.

**`Cannot find module 'express'` in the dev container.** `node_modules` is a
named volume that masks the host tree deliberately (the host copy may be built
for a different platform, or absent). It is populated from the image the first
time the volume is created, so after a dependency change you need to recreate it:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml down -v
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up --build
```

**`no such service: mongodb`.** You passed only one `-f`. The base compose file
is production-shaped and deliberately has no database service; Atlas Local comes
from the dev override.
