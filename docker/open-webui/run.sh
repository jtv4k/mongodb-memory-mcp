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

# The only genuinely required value. It is resolved inside the Open WebUI
# container, so localhost means that container, where nothing is listening.
while [ -z "${OLLAMA_BASE_URL:-}" ]; do
  read -r -p "  Ollama URL, reachable from a container (e.g. http://192.168.1.50:11434): " \
    OLLAMA_BASE_URL
done
export OLLAMA_BASE_URL

# Optional. With it, the seeder also creates a model preset that has Native
# function calling and the knowledge-base system prompt already applied.
ask OWUI_BASE_MODEL "Ollama model for the preset (blank to skip)" ""

compose=(docker compose)
[ -f .env ] && compose+=(--env-file .env)
compose+=(
  -f docker/docker-compose.yml
  -f docker/docker-compose.dev.yml
  -f docker/docker-compose.demo.yml
)

echo
echo "Starting the stack..."
"${compose[@]}" up -d

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
  next_step="No model preset was created, because no Ollama model was given.
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
