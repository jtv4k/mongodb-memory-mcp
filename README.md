# MongoDB RAG KB MCP

Have you ever explained the same thing to an AI assistant three times in one
week? I have. The context window closes, the session ends, and everything the
assistant learned goes with it.

This is my answer to that. It is an MCP server sitting on top of MongoDB. An AI
client hands it content over the [Model Context Protocol](https://modelcontextprotocol.io);
the server splits that content with a structure-aware chunker, embeds the chunks
with Voyage AI, and stores them in MongoDB behind Atlas Vector Search and Atlas
Search indexes. Later — a different session, a different client, a different
week — you ask a question in plain language and get the relevant passages back,
each one carrying its source document, heading breadcrumb and relevance score.

One Node process serves three surfaces on one port:

| Surface               | Where                   | Auth                               |
| --------------------- | ----------------------- | ---------------------------------- |
| MCP (Streamable HTTP) | `POST/GET/DELETE /mcp`  | bearer token                       |
| REST API              | `/api/*`                | bearer token — **including reads** |
| Web UI                | `/search`, `/documents` | none (server-rendered, read-only)  |
| Health probes         | `/healthz`, `/readyz`   | none                               |

Four MCP tools: `store_content`, `search_knowledge`, `list_sources`,
`delete_content`.

---

## What you need

- **Docker** and **Docker Compose v2+**.
- **No Node on your machine.** Every `npm`, `tsc`, `vitest` and `eslint` command
  in this repository runs inside a pinned `node:24-slim` container.
  `./scripts/ndocker.sh` is the wrapper, and the dev stack runs the app in a
  container too. Installing Node locally is neither required nor used.
- A **Voyage AI API key** (<https://voyageai.com>) for real ingestion. The tests
  do not need one — they run against a deterministic offline embedder.
- Roughly **4 GB of free RAM** for the Atlas Local container.

---

## First run

### 1. Create your env file

```bash
cp .env.example .env
```

`.env` is gitignored. Keep it that way.

Two variables you must fill in:

| Variable         | Notes                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOYAGE_API_KEY` | Required whenever `EMBEDDING_PROVIDER=voyage`, which is the default. Set `EMBEDDING_PROVIDER=fake` to run the whole stack with no key at all — the vectors are real, the semantics are crude, and it costs nothing. |
| `MCP_AUTH_TOKEN` | Minimum 16 characters. Generate one with `openssl rand -hex 32`.                                                                                                                                                    |

`MONGODB_URI` and `MONGODB_DB_NAME` matter only for the production stack; dev
sets both for you. Everything else already has a working default —
`EMBEDDING_MODEL=voyage-context-3`, `EMBEDDING_DIMENSIONS=1024`,
`CHUNK_SIZE_TOKENS=512`, `CHUNK_OVERLAP_TOKENS=64`, `PORT=3000`,
`MCP_PATH=/mcp`, `SEARCH_HYBRID_ENABLED=true`, and about thirty more. The full
schema, including the cross-field rules, lives in `src/config/env.ts`.

The file `docker/docker-compose.dev.yml` sets
`NODE_ENV`, `LOG_LEVEL`, `LOG_PRETTY`, `MONGODB_URI`, `MONGODB_DB_NAME` and
`MCP_AUTH_TOKEN` in its `environment:` block, and an entry there beats
`env_file: ../.env`. That's important to remember for `MONGODB_URI` -- the URI
will work from the docker compose file over `.env`. That also means
your `.env` token is ignored in dev unless you also hand it to compose's
interpolation:

```bash
docker compose --env-file .env \
  -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up --build
```

The dev environment falls back to the token `dev-local-token-not-a-secret` without `--env-file`, which is exactly as secure as it sounds. `VOYAGE_API_KEY` is unaffected — it comes through `env_file` normally if it's not set in compose.

### 2. Bring up the dev stack

Pass **both** `-f` files; later overrides.

```bash
docker compose --env-file .env \
  -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up --build
```

`--build` matters on a fresh clone: the app image (`ragkb-app`) is built locally
from `docker/Dockerfile` and never published to a registry, and some Compose
versions try to pull a missing image instead of building it. Later runs reuse
the build cache.

That starts two services:

- **`mongodb`** — `mongodb/mongodb-atlas-local:8.0` on `localhost:27017`. It
  runs `mongod` _and_ `mongot`, which is the whole reason `$search` and
  `$vectorSearch` behave locally exactly as they do in cloud Atlas.
- **`app`** — the server under `tsx watch` with `src/` bind-mounted, on
  `localhost:3000`. Save a file in your editor and it reloads. No rebuild.

First boot takes 20–40 seconds while Atlas Local initialises a single-node
replica set and starts `mongot`. The app waits for it.

### 3. Apply the index definitions

Do not skip this one. Search returns nothing until you run it.

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  run --rm app npm run db:indexes
```

The definitions live in `src/db/index-definitions/*.json` and are applied as
code — never by hand in the Atlas UI, because the UI is not the source of truth
and cloud Atlas would drift from your laptop within a day. The command prints
every standard, Atlas Search and Vector Search index as `created`, `updated` or
`unchanged`, reports whether each is queryable, then waits for the search
indexes to finish building. It is idempotent, so re-running it is safe; this is
the deploy-time migration step. Add `-- --dry-run` to see the plan and write
nothing.

### 4. Open the UI

<http://localhost:3000/search> is the search page — query box, ranked results,
each with its source, heading breadcrumb, score and a highlighted snippet.
<http://localhost:3000/documents> browses what you have ingested, and each
document has its own page. `/` redirects to `/search`.

---

## Using the REST API

Every `/api/*` route requires the token, **reads included**. That is deliberate,
and I will defend it: the process is network-reachable, so an open read surface
hands your entire knowledge base to anyone who can reach the port. The direct
consequence is that the web pages call the service in-process instead of
fetching `/api/*`, so no token ever reaches a browser.

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

The full route list:

| Method   | Path                                                                  | What it does                                                             |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST`   | `/api/content`                                                        | `storeContent` — 201 when created, 200 when updated or unchanged         |
| `GET`    | `/api/search?q=&limit=&mode=&tags=&sourceIds=&minScore=&includeText=` | `searchKnowledge`                                                        |
| `GET`    | `/api/sources?limit=&offset=&tag=&search=&sort=&order=`               | `listSources`                                                            |
| `GET`    | `/api/documents?limit=&offset=&tag=&search=`                          | `listDocuments`                                                          |
| `GET`    | `/api/documents/:id`                                                  | `getDocument` — accepts an ObjectId **or** a `sourceId`; 404 when absent |
| `DELETE` | `/api/content`                                                        | `deleteContent` — selector in the body or the query string               |
| `GET`    | `/api/embedding-coverage`                                             | which embedding models the corpus actually contains                      |

List parameters accept either form: `?tags=a,b` or `?tags=a&tags=b`.

Search runs in one of three modes. `vector` is pure `$vectorSearch`, `text` is
pure `$search`, and `hybrid` — the default — runs both legs and fuses them in
application code with reciprocal rank fusion. Why fuse in the application rather
than use `$rankFusion`? Three reasons. First, Atlas Local and cloud Atlas then
rank identically, so nothing "works locally and ranks differently in
production." Second, the ranking becomes a pure function that unit tests can
exercise exhaustively without a database. Third, we keep each leg's raw score
and rank on every hit, which a server-side fusion stage does not surface.

---

## Connecting an MCP client

The transport is **Streamable HTTP** at `http://localhost:3000/mcp` (change the
path with `MCP_PATH`), authenticated with the same bearer token. For a client
that reads an `mcp.json`-style config:

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

Sanity check it with curl. An unauthenticated request must be rejected:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp"       # 401
```

---

## Development

All Node tooling runs in a container. Run these from the project root.

```bash
./scripts/ndocker.sh npm run typecheck      # tsc --noEmit over the whole project
./scripts/ndocker.sh npm run lint           # eslint
./scripts/ndocker.sh npm run format:check   # prettier, the CI check
./scripts/ndocker.sh npm run format         # prettier, write
./scripts/ndocker.sh npm test               # unit tests: no database, no network
```

A single unit file:

```bash
./scripts/ndocker.sh npx vitest run --project unit tests/unit/chunking.test.ts
```

### Integration tests

These want Atlas Local on `127.0.0.1:27017`, which the dev stack publishes. Each
run picks a randomised database name (`ragkb_test_…`), checks nobody else
claimed it first, and drops it afterwards — so it will not disturb your dev data
and concurrent runs cannot collide. They use the offline embedder, so no Voyage
key is required.

`ndocker.sh` uses the default bridge network, and on Linux the published port is
not reachable from there. Run this one on the host network instead — still a
container, so the no-host-Node rule holds:

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

`HOME`, the XDG directories, `TMPDIR` and the npm cache all point inside `/app`
on purpose. This project writes nothing outside its own directory, and that
includes stray cache entries and npm logfiles.

### Pre-commit hook

Lint-staged plus a whole-project typecheck, both in a container. Install it once
per clone — npm's `prepare` cannot, since it runs inside a container with no
git:

```bash
git config core.hooksPath .husky
```

---

## Building for production

`docker/Dockerfile` is multi-stage and `prod` is the default target.

```bash
docker build -f docker/Dockerfile -t ragkb-app:local .
```

It compiles TypeScript, builds the Tailwind stylesheet, copies `views/` and
`public/` into `dist/`, then assembles a runtime image with production
dependencies only, running as the unprivileged `node` user with a `HEALTHCHECK`
on `/healthz`.

The production compose stack has **no database service**, because production
points at cloud Atlas through `MONGODB_URI`:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Apply the index definitions to the cloud cluster with the same
`npm run db:indexes` command. Only `MONGODB_URI` differs. That is the point of
keeping them as code.

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

## When something goes wrong

**`pull access denied for ragkb-app` on `up`.** The app image is built locally
from `docker/Dockerfile` and does not exist in any registry, but some Compose
versions try to pull a missing image rather than build it. Pass `--build` (the
commands above do), or run
`docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml build`
once and re-run `up`.

**It worked the first time, and now Mongo never becomes healthy.** Check the
logs for `No primary exists currently` and a stream of
`ReadConcernMajorityNotAvailableYet`. If they are there, the replica set stored
in `docker/atlas-local/mongod/data/` was initialised under a container hostname
that no longer exists, so the container is not a member of the replica set it
just loaded. It never elects a primary.

This is why `docker-compose.dev.yml` pins `hostname: ragkb-mongodb`. Docker
otherwise names each container after its ID, and that ID changes on every
recreation. It looks like a keyfile or permissions problem — "worked once, fails
on recreate" sounds like both — and it is neither.

If your data directory predates that setting, reset it once:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml down
rm -rf docker/atlas-local/mongod/data/* docker/atlas-local/mongot/data/*
rm -f  docker/atlas-local/mongod/conf/keyfile
```

Then bring the stack up and re-run `npm run db:indexes`. Changing `hostname:`
later means doing this again — see `docker/atlas-local/README.md`.

**`error writing key file: open /data/configdb/keyfile: permission denied`.**
You wiped `mongod/data/` but kept the keyfile. An empty data directory puts
`runner` on its initialize path, which rewrites the keyfile, and the surviving
one is mode `0400` — unwritable even by its owner. Despite the message, this is
not a uid problem. Delete it and bring the stack up again; it is regenerated on
boot:

```bash
rm -f docker/atlas-local/mongod/conf/keyfile
```

**Atlas Local takes forever, or the app exits before Mongo is ready.** First
boot has to initialise a replica set and start `mongot`. Twenty to forty seconds
is normal on a warm image, longer on a cold one. The healthcheck allows 90
seconds and the app waits on `service_healthy`, so watch and wait:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml logs -f mongodb
```

A restart loop or exit code 137 means it was OOM-killed. Give Docker more
memory.

**Search returns nothing, but I know I stored content.** Almost always one of
three things. First, `npm run db:indexes` was never run against this database —
run it. Second, the index exists but is still building; `GET /readyz` reports
the vector index specifically, and `db:indexes -- --dry-run` prints a
`QUERYABLE` column. Remember that Atlas Search is eventually consistent, so a
chunk inserted a second ago is not searchable yet. Third, you recreated the
Mongo container without the `mongot` bind mount, which discards the search index
data — see `docker/atlas-local/README.md`, then re-run `db:indexes`.

Worth knowing: a missing **text** index degrades hybrid search to vector-only
rather than failing, and logs one `search.text_index_unavailable` warning. A
missing **vector** index is a hard error. Returning zero results silently would
send you hunting for content that is sitting right there.

**Dimension mismatch.** `EMBEDDING_DIMENSIONS` must equal the vector index's
`numDimensions`. `db:indexes` injects the configured value when it applies the
definition and logs `index.dimension_override` when config disagrees with the
checked-in default. If the index already exists at a different width, the
migration refuses to change it in place and tells you so. Neither
`numDimensions` nor `similarity` can be updated on all deployments, so the real
path is drop, recreate, then re-embed the whole collection with
`npm run db:reembed`. That is an operator's decision, not something a migration
script should make for you.

**`401` from `/mcp` or `/api/…`.** Send
`Authorization: Bearer <MCP_AUTH_TOKEN>`. Every `/api/*` route needs it,
including `GET`s. In dev the effective token is whatever compose interpolated —
`dev-local-token-not-a-secret` unless you passed `--env-file .env`. Confirm what
the container actually got:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml config
```

**Atlas Local restart-loops with permission errors on the bind mounts.** The
image runs as uid/gid `1000:1000`. If your host account is not uid 1000,
`mongod` cannot write to `docker/atlas-local/`:

```bash
sudo chown -R 1000:1000 docker/atlas-local
```

The full picture — the shared `mongod`↔`mongot` keyfile, how to reset local
state — is in `docker/atlas-local/README.md`.

**`Cannot find module 'express'` in the dev container.** `node_modules` is a
named volume that masks the host tree deliberately, since the host copy may be
built for another platform or missing entirely. It is populated from the image
the first time the volume is created, so after a dependency change you have to
recreate it:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml down -v
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml up --build
```

**`no such service: mongodb`.** You passed only one `-f`. The base compose file
is production-shaped and has no database service by design; Atlas Local comes
from the dev override.
