# MongoDB RAG KB MCP

Have you ever explained the same thing to an AI assistant three times in one
week? The context window closes, the session ends, and everything the
assistant learned goes with it.

This project is an answer to that: an MCP server sitting on top of MongoDB. An AI
client hands it content over the [Model Context Protocol](https://modelcontextprotocol.io);
the server splits that content with a structure-aware chunker, embeds the chunks
with Voyage AI, and stores them in MongoDB behind MongoDB Vector Search and MongoDB
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
sets both for you. Everything else already has a working default. The full
schema, including the cross-field rules, lives in `src/config/env.ts`.

One compose subtlety worth knowing: `docker-compose.dev.yml` sets several
variables in its `environment:` block, and an entry there beats `env_file`. Your
`.env` token therefore only takes effect in dev when you hand the file to
compose's interpolation with `--env-file .env` — without it, the stack falls
back to `dev-local-token-not-a-secret`, which is exactly as secure as it sounds.

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
every standard, MongoDB Search and Vector Search index as `created`, `updated` or
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
not an oversight: the process is network-reachable, so an open read surface
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
        "title": "MongoDB Vector Search notes",
        "contentType": "markdown",
        "tags": ["mongodb", "demo"],
        "content": "# MongoDB Vector Search\n\nThe $vectorSearch stage performs approximate nearest-neighbour search over an indexed vector field.\n\n## Filters\n\nA field must be declared as a filter path in the index before it can be filtered on."
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

## Try it with a chat UI

There is a demo stack: Open WebUI, pointed at an Ollama server of your own, with
the four tools already connected. One script asks for what it needs and starts
everything.

```bash
./docker/open-webui/run.sh
```

Two things it cannot do for you. You need an Ollama server reachable **from a
container** — `localhost` there means the container, not your machine. And you
need a model that can actually call tools; `qwen3` and `llama3.1` can, and one
that cannot will answer from its own weights and quietly never touch the
knowledge base.

Setup details and troubleshooting live in `docker/open-webui/README.md`.

---

## Development

All Node tooling runs in a container. Run these from the project root.

```bash
./scripts/ndocker.sh npm ci                 # once per clone — populates node_modules
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

Lint-staged plus a whole-project typecheck, both in a container. It needs
`node_modules` populated (`./scripts/ndocker.sh npm ci` above). Install it once
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

| Path                         | What lives there                                                            |
| ---------------------------- | --------------------------------------------------------------------------- |
| `src/index.ts`, `src/app.ts` | Process entrypoint and Express assembly                                     |
| `src/config/env.ts`          | The only module that reads the environment; zod-validated `AppConfig`       |
| `src/domain/`                | Persistence types and every zod schema for external input                   |
| `src/db/`                    | Connection, typed collections, index management                             |
| `src/db/index-definitions/`  | **Canonical** MongoDB Search / Vector Search JSON                           |
| `src/chunking/`              | Pure, structure-aware chunker                                               |
| `src/embeddings/`            | `EmbeddingProvider` interface, Voyage provider, offline fake, factory       |
| `src/services/`              | `KnowledgeService` — all business logic; rank fusion; highlighting          |
| `src/mcp/`                   | MCP server, Streamable HTTP transport, auth, one module per tool            |
| `src/http/`                  | REST router, health probes, request ids, error handling, web routes         |
| `src/views/`, `src/styles/`  | EJS templates and the Tailwind input stylesheet                             |
| `src/cli/`                   | `db:indexes` and `db:reembed` entrypoints                                   |
| `tests/unit/`                | No database, no network                                                     |
| `tests/integration/`         | Real Atlas Local, real vector index                                         |
| `docker/`                    | Dockerfile, compose base + dev/demo overrides, Atlas Local, Open WebUI demo |
| `scripts/`                   | `ndocker.sh` (containerised Node wrapper), asset copy, demo seeder          |
| `CLAUDE.md`                  | Architecture and conventions, for AI sessions and humans alike              |

---

## When something goes wrong

**`pull access denied for ragkb-app` on `up`.** The app image is built locally
from `docker/Dockerfile` and does not exist in any registry, but some Compose
versions try to pull a missing image rather than build it. Pass `--build` (the
commands above do), or run
`docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml build`
once and re-run `up`.

**Search returns nothing, but I know I stored content.** Almost always one of
three things. First, `npm run db:indexes` was never run against this database —
run it. Second, the index is still building; `GET /readyz` reports the vector
index, and `db:indexes -- --dry-run` prints a `QUERYABLE` column. MongoDB Search
is also eventually consistent, so a chunk inserted a second ago is not
searchable yet. Third, you recreated the MongoDB container without the `mongot`
bind mount, which discards the search index data — re-run `db:indexes`. Worth
knowing: a missing **text** index degrades hybrid search to vector-only with one
logged warning; a missing **vector** index is a hard error on purpose.

**`401` from `/mcp` or `/api/…`.** Send
`Authorization: Bearer <MCP_AUTH_TOKEN>` — every `/api/*` route needs it,
including `GET`s. In dev the effective token is whatever compose interpolated
(`dev-local-token-not-a-secret` unless you passed `--env-file .env`);
`docker compose ... config` shows what the container actually got.

**Dimension mismatch.** `EMBEDDING_DIMENSIONS` must equal the vector index's
`numDimensions`; re-running `db:indexes` keeps them in sync. Neither
`numDimensions` nor `similarity` can be changed in place — that is drop,
recreate, re-embed (`npm run db:reembed`), and it is an operator's decision, not
something a migration script should make for you.

**MongoDB never becomes healthy, keyfile complaints, permission errors, resets.**
Everything about the Atlas Local container — the replica set that outlives its
hostname, the shared `mongod`↔`mongot` keyfile, uid 1000 bind mounts, slow first
boots, and how to reset local state — lives in `docker/atlas-local/README.md`.
Start there; the failure modes look alike and that file tells them apart.

**`Cannot find module 'express'` in the dev container.** `node_modules` is a
named volume that deliberately masks the host tree. After a dependency change,
recreate it: `docker compose ... down -v`, then `up --build`.

**`no such service: mongodb`.** You passed only one `-f`. The base compose file
is production-shaped and has no database service by design; Atlas Local comes
from the dev override.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
