#!/usr/bin/env bash
# Start the Open WebUI demo stack, asking for the handful of values it needs.
#
# Everything else already has a working default. Answers are exported before
# compose runs, and compose gives the shell environment precedence over
# --env-file, so what you type here wins over .env for this run only — nothing
# is written back to .env.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${PROJECT_DIR}"

# ask VAR "prompt" ["default"] — keeps any value already in the environment.
ask() {
  local var="$1" prompt="$2" default="${3:-}" current answer
  current="${!var:-$default}"
  read -r -p "  ${prompt}${current:+ [${current}]}: " answer
  printf -v "${var}" '%s' "${answer:-$current}"
  export "${var?}"
}

echo "Open WebUI demo. Press enter to accept a default."
echo

# Chat backend: OpenAI-compatible by default, a plain Ollama server as the
# fallback. ANY endpoint speaking the OpenAI dialect works — api.openai.com,
# AWS Bedrock, a local Ollama's /v1, vLLM. A key already exported in the
# environment is kept without re-asking (and without echoing it).
if [ -z "${OPENAI_API_KEY:-}" ]; then
  read -r -p "  API key for your OpenAI-compatible endpoint (blank: use .env, or Ollama): " \
    OPENAI_API_KEY
fi

# Either URL is resolved inside the Open WebUI container, so for a server on
# this machine localhost means that container, where nothing is listening —
# use host.docker.internal (or the host's LAN address) instead.
if [ -n "${OPENAI_API_KEY:-}" ]; then
  export OPENAI_API_KEY
  ask OPENAI_BASE_URL "OpenAI-compatible URL, reachable from a container" \
    "https://api.openai.com/v1"
  preset_hint="e.g. gpt-4o-mini"
else
  # NEVER export the blank answer: compose gives the shell environment
  # precedence over --env-file, so an exported-but-empty OPENAI_API_KEY would
  # shadow a key supplied via .env and the demo would end up with no backend
  # at all — the exact failure this branch exists to avoid.
  unset OPENAI_API_KEY
  if [ -z "${OLLAMA_BASE_URL:-}" ]; then
    read -r -p "  Ollama URL, reachable from a container (blank if .env sets the backend): " \
      OLLAMA_BASE_URL
  fi
  if [ -n "${OLLAMA_BASE_URL:-}" ]; then
    export OLLAMA_BASE_URL
    preset_hint="e.g. qwen3:latest"
  else
    # Same shadowing hazard as the key above.
    unset OLLAMA_BASE_URL
    echo "  Nothing typed — the chat backend comes from .env (OPENAI_API_KEY or OLLAMA_BASE_URL)."
    preset_hint="e.g. gpt-4o-mini, or an Ollama tag"
  fi
fi

# Optional. With it, the seeder also creates a model preset that has Native
# function calling and the knowledge-base system prompt already applied.
ask OWUI_BASE_MODEL "Chat model for the preset, ${preset_hint} (blank to skip)" ""

compose=(docker compose)
[ -f .env ] && compose+=(--env-file .env)
compose+=(
  -f docker/docker-compose.yml
  -f docker/docker-compose.dev.yml
  -f docker/docker-compose.demo.yml
)

echo
echo "Starting the stack..."
# --build: the app image is built locally, never pulled; some Compose versions
# try to pull a missing image instead of building it.
"${compose[@]}" up -d --build

# Safe to re-run: it is the deploy-time migration step and is idempotent. On a
# fresh database it is also the difference between search working and silently
# returning nothing.
echo
read -r -p "  Apply the search index definitions now? [Y/n]: " apply
case "${apply:-Y}" in
  [nN]*) echo "  Skipped. Run 'npm run db:indexes' before searching." ;;
  *) "${compose[@]}" run --rm app npm run db:indexes ;;
esac

# The preset only exists when a base model was given, so point at it only then.
# Without one there is no "MongoDB KB" entry to find, and sending someone to an
# empty Workspace is worse than saying nothing.
if [ -n "${OWUI_BASE_MODEL:-}" ]; then
  next_step="In the sidebar, open Workspace and pick \"MongoDB KB (${OWUI_BASE_MODEL})\".
The knowledge-base tools are already attached to it."
else
  next_step="No model preset was created, because no chat model was given.
Pick a model in the chat, then switch its tools on from the message input."
fi

cat <<EOF

Ready.

  Chat UI     http://localhost:${OPEN_WEBUI_PORT:-8080}
  Search UI   http://localhost:${PORT:-3000}/search

${next_step}

There is no sign-in.

  Logs        ${compose[*]} logs -f
  Stop        ${compose[*]} down
EOF
