# Open WebUI demo

Chat with the knowledge base. You bring an Ollama server; everything else comes
up with the stack, and the tools register themselves.

There are two extra containers. `open-webui` is the chat UI. `mcpo` is a bridge,
because Open WebUI calls OpenAPI tool servers and our server speaks MCP.

## Run it

Three things in `.env`, then one command:

```bash
OLLAMA_BASE_URL=http://192.168.1.50:11434    # required
OWUI_ADMIN_EMAIL=you@example.com
OWUI_ADMIN_PASSWORD=something-you-choose
OWUI_BASE_MODEL=qwen3:latest                 # optional, see below
```

```bash
docker compose --env-file .env \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml up --build
```

All three `-f` flags. The dev and demo files are overrides and do nothing alone.

On a clean database, apply the indexes once — search returns nothing until you
do:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml run --rm app npm run db:indexes
```

Then open <http://localhost:8080>, sign in with the credentials above, and pick
the model. The knowledge-base tools are already connected.

| Service    | URL                     |
| ---------- | ----------------------- |
| Chat UI    | <http://localhost:8080> |
| App + REST | <http://localhost:3000> |
| Bridge     | <http://localhost:8000> |

## Your Ollama URL

`OLLAMA_BASE_URL` is resolved inside the Open WebUI container, not by your
shell. `http://localhost:11434` therefore means "inside that container", where
nothing is listening.

- Another machine: its LAN address.
- Docker Desktop: `http://host.docker.internal:11434`.
- Linux, same machine: the host's LAN IP, and set `OLLAMA_HOST=0.0.0.0` on the
  Ollama side so it accepts more than loopback.

## Pick a model that can call tools

This is the one that wastes an afternoon. A model without tool support will not
error — it answers from its own weights and never touches the knowledge base.
Check before you blame the stack:

```bash
curl -sS http://YOUR-OLLAMA:11434/api/show -d '{"model":"qwen3:latest"}' \
  | grep -o '"capabilities":\[[^]]*\]'
```

You want `tools` in that list. `qwen3`, `llama3.1` and `mistral-nemo` all work.

Setting `OWUI_BASE_MODEL` creates a model preset with Function Calling set to
**Native** and a system prompt that teaches the search-first workflow. Build
your own model entry instead and you must set Native yourself — under `Default`,
Open WebUI asks the model to emit the call as text, and reasoning models narrate
it rather than emit it. The reply comes back empty with nothing in any log.

## When it does not work

`docker compose ... logs mcpo` is the fastest answer. A `POST` line means the
model called through and the wiring is fine. No `POST` means the call never left
Open WebUI — see the section above.

## Reset

Accounts and tool registrations live in a named volume:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml down
docker volume rm ragkb_open_webui_data
```

Resetting the knowledge base itself is separate — see
`docker/atlas-local/README.md`.
