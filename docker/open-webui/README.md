# Open WebUI demo

Chat with the knowledge base. You bring an Ollama server; everything else comes
up with the stack, and the tools register themselves.

There are two extra containers. `open-webui` is the chat UI. `mcpo` is a bridge,
because Open WebUI calls OpenAPI tool servers and our server speaks MCP.

## Run it

```bash
./docker/open-webui/run.sh
```

It asks for your Ollama URL, optionally a model to build a preset around, then
starts everything. Say yes when it offers to apply the search indexes — on a
clean database, search returns nothing until you do.

Then open <http://localhost:8080>, and in the sidebar open **Workspace** and pick
**MongoDB KB**. There is no sign-in, and the knowledge-base tools are already
attached to that model.

Re-run the script whenever your Ollama URL or model changes. It rewrites both
through Open WebUI's admin API, so nothing needs resetting.

**Ran this stack before?** Open WebUI only accepts a disabled sign-in on a fresh
database — otherwise it answers "You can't turn off authentication because there
are existing users." Drop the volume and bring it back up; the seeder
re-registers the tools:

```bash
docker volume rm ragkb_open_webui_data
```

That missing sign-in is deliberate — one fewer step to a working chat — but know
what it exposes. The port publishes on every interface, and the tools are not
scoped to a user, so anyone who can reach 8080 can read the whole knowledge base
through `search_knowledge`. Fine on a laptop. Not fine on a shared network. To
lock it down, set `WEBUI_AUTH` back to `true` in `docker-compose.demo.yml`, or
bind the port to `127.0.0.1`.

| Service    | URL                     |
| ---------- | ----------------------- |
| Chat UI    | <http://localhost:8080> |
| App + REST | <http://localhost:3000> |
| Bridge     | <http://localhost:8000> |

### Driving compose yourself

Put the values in `.env` and pass all three `-f` flags — the dev and demo files
are overrides and do nothing alone:

```bash
OLLAMA_BASE_URL=http://192.168.1.50:11434    # required
OWUI_BASE_MODEL=qwen3:latest                 # optional, see below

docker compose --env-file .env \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml up

docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml run --rm app npm run db:indexes
```

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
