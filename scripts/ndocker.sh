#!/usr/bin/env bash
# Run any node/npm command inside the pinned Debian Node LTS container.
#
# ALL node tooling for this project runs in a container — never on the host.
# This wrapper is the low-level escape hatch (used for the very first
# `npm install`, before docker-compose has a usable image). For day-to-day work
# prefer:
#
#   docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
#     run --rm app <cmd>
#
# Usage:
#   ./scripts/ndocker.sh npm install
#   ./scripts/ndocker.sh npm run typecheck
#   ./scripts/ndocker.sh node -v
#
# PROJECT BOUNDARY
# ----------------
# Every path this container reads or writes stays inside the project directory.
# HOME and the npm cache are deliberately pointed at directories under /app (the
# bind-mounted project) rather than /tmp or the caller's real home, so nothing —
# not an npm logfile, not a cache entry, not a stray dotfile — is ever written
# outside the repository. Both locations are gitignored and dockerignored.
set -euo pipefail

NODE_IMAGE="${NODE_IMAGE:-node:24-slim}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Created on the host so they are owned by the invoking user, not by root from
# inside the container.
mkdir -p "${PROJECT_DIR}/.container-home" "${PROJECT_DIR}/.npm-cache"

exec docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --volume "${PROJECT_DIR}:/app" \
  --workdir /app \
  --env HOME=/app/.container-home \
  --env XDG_CACHE_HOME=/app/.container-home/.cache \
  --env XDG_CONFIG_HOME=/app/.container-home/.config \
  --env TMPDIR=/app/.container-home/tmp \
  --env npm_config_cache=/app/.npm-cache \
  --env npm_config_update_notifier=false \
  --env npm_config_fund=false \
  --env npm_config_audit=false \
  --env CI=true \
  "${NODE_IMAGE}" "$@"
