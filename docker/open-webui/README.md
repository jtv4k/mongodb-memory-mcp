# Open WebUI demo

Chat with the knowledge base. You bring a chat backend — an OpenAI-compatible
endpoint and its API key by default, or a plain Ollama server — and everything
else comes up with the stack; the tools register themselves.

There are two extra containers. `open-webui` is the chat UI. `mcpo` is a bridge,
because Open WebUI calls OpenAPI tool servers and our server speaks MCP.

The chat backend is chat-only. The app's embeddings are configured separately
in `.env` (`EMBEDDING_PROVIDER`, Voyage AI by default) and are untouched by
anything on this page.

## Run it

```bash
./docker/open-webui/run.sh
```

It asks for your OpenAI-compatible API key — leave it blank to fall back to an
Ollama server, which it then asks for instead — optionally a model to build a
preset around, then starts everything. Values already in `.env`
(`OPENAI_API_KEY`, `OLLAMA_BASE_URL`) are used when you answer blank; anything
you type wins for that run. Say yes when it offers to apply the search
indexes — on a clean database, search returns nothing until you do.

Then open <http://localhost:8080>. If you gave the script a model, open
**Workspace** in the sidebar and pick **MongoDB KB** — the knowledge-base tools
are already attached to that preset. There is no sign-in.

Re-run the script whenever your endpoint, key or model changes. It rewrites
them through Open WebUI's admin API, so nothing needs resetting.

**Ran this stack before?** Open WebUI only accepts a disabled sign-in on a fresh
database — otherwise it answers "You can't turn off authentication because there
are existing users." Reset the volume (see the last section) and bring it back
up; the seeder re-registers the tools.

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
# OpenAI-compatible chat backend (the default)...
OPENAI_API_KEY=sk-...                        # required for this backend
OPENAI_BASE_URL=https://api.openai.com/v1    # optional, the default
OWUI_BASE_MODEL=gpt-4o-mini                  # optional, see below

# ...or a plain Ollama server instead (leave OPENAI_API_KEY unset):
# OLLAMA_BASE_URL=http://192.168.1.50:11434
# OWUI_BASE_MODEL=qwen3:latest

docker compose --env-file .env \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml up --build

docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml run --rm app npm run db:indexes
```

## Your backend URL

`OPENAI_BASE_URL` can be ANY service speaking the OpenAI dialect —
api.openai.com, AWS Bedrock, vLLM, LM Studio, even an Ollama server's `/v1` —
and `OLLAMA_BASE_URL` any plain Ollama server. Either way the URL is resolved
inside the Open WebUI container, not by your shell. `http://localhost:11434`
therefore means "inside that container", where nothing is listening.

- Another machine: its LAN address.
- Docker Desktop: `http://host.docker.internal:11434`.
- Linux, same machine: the host's LAN IP, and set `OLLAMA_HOST=0.0.0.0` on the
  Ollama side so it accepts more than loopback.

## Pick a model that can call tools

This is the one that wastes an afternoon. A model without tool support will not
error — it answers from its own weights and never touches the knowledge base.
Hosted OpenAI models (`gpt-4o-mini` and up) all call tools. For an Ollama
model, check before you blame the stack:

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

**No models in the picker.** Two causes, both otherwise silent — the seeder
detects and reports each:

- The OpenAI-compatible endpoint does not implement `GET /models`, which is
  where Open WebUI's picker comes from. Gateways in front of Azure or Bedrock
  commonly route only `/chat/completions`. Give `run.sh` a chat model name and
  the seeder pins it on the connection (Open WebUI's `model_ids`), which skips
  discovery entirely.
- The Ollama URL is not reachable from inside the containers — see the URL
  section above. The seeder prints a warning when this is the case.

**Tool calls never happen.** `docker compose ... logs mcpo` is the fastest
answer. A `POST` line means the model called through and the wiring is fine. No
`POST` means the call never left Open WebUI — see the model section above.

## Reset

Accounts and tool registrations live in a named volume:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  -f docker/docker-compose.demo.yml down
docker volume rm ragkb_open_webui_data
```

Resetting the knowledge base itself is separate — see
`docker/atlas-local/README.md`.
