##
# Multi-stage image for mongodb-rag-kb-mcp.
#
# One file serves every workflow so the dev and production runtimes cannot drift
# apart. Build context is the PROJECT ROOT, not docker/:
#
#   docker build -f docker/Dockerfile .                      -> production (default)
#   docker build -f docker/Dockerfile --target dev     .     -> watch-mode dev image
#   docker build -f docker/Dockerfile --target tooling .     -> pre-commit hook image
#
# Debian bookworm `slim`, never Alpine. This project is supported on glibc, and
# musl's differences in DNS/SRV resolution are exactly the sort of thing that
# only surfaces against a real `mongodb+srv://` Atlas connection string.
#
# PID-1 signal handling is deliberately NOT solved with tini here: compose sets
# `init: true`, which gives the same reaping and SIGTERM forwarding without
# adding a second binary to the runtime image.
##

ARG NODE_VERSION=24.18.0
ARG PORT=3000

# ---------------------------------------------------------------------------
# base — settings shared by every stage
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV} \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# Install and build as the image's unprivileged `node` account (uid/gid 1000,
# which is also the usual first host account) rather than as root. node_modules
# and dist/ then already belong to the runtime user, so the production stage
# needs no `chown -R` over a 300 MB tree and the dev bind mount never acquires
# root-owned files.
RUN chown node:node /app
USER node

# ---------------------------------------------------------------------------
# deps — the full dependency tree (dev + prod)
# ---------------------------------------------------------------------------
FROM base AS deps

# Manifests only. Nothing in this layer depends on src/, so a dependency change
# is the only thing that can invalidate it — editing a .ts file never re-runs
# the (slow) install.
COPY --chown=node:node package.json package-lock.json ./

# `--include=dev` is explicit and load-bearing: npm omits devDependencies by
# itself whenever NODE_ENV=production, and both the dev image and the build
# stage need the TypeScript/Tailwind toolchain.
RUN npm ci --include=dev

# ---------------------------------------------------------------------------
# dev — watch mode, no build step, source arrives at run time
# ---------------------------------------------------------------------------
FROM deps AS dev

ENV NODE_ENV=development

# No source is copied and nothing is compiled on purpose: docker-compose.dev.yml
# bind-mounts the host working tree over /app and `tsx watch` reloads on save,
# so anything baked in here would just be shadowed by that mount.
ARG PORT
EXPOSE ${PORT}
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------------
# tooling — the container the pre-commit hook runs in
# ---------------------------------------------------------------------------
# node:24-slim ships without git, and lint-staged is fundamentally a git tool
# (`git stash create`, `git diff --staged`, `git add`). Rather than pull the
# ~1 GB full node:24 image just for the hook, add git to the slim base. No
# node_modules is baked in: scripts/ndocker.sh bind-mounts the project, so the
# hook always uses the host's installed toolchain and can never go stale.
FROM base AS tooling

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
USER node

CMD ["node", "--version"]

# ---------------------------------------------------------------------------
# build — compile TypeScript, build Tailwind, copy runtime assets
# ---------------------------------------------------------------------------
FROM deps AS build

COPY --chown=node:node tsconfig.json tsconfig.build.json ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src

# `npm run build` = tsc -p tsconfig.build.json && tailwindcss --minify && copy
# views/ + public/ into dist/. dist/ is self-contained afterwards, which is what
# lets the prod stage drop the source tree and the dev dependencies entirely.
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps — runtime dependency tree only
# ---------------------------------------------------------------------------
# Built from `base` rather than from `deps` so the pruned tree is a fresh,
# reproducible `npm ci` and not a `npm prune` over an install that already ran.
FROM base AS prod-deps

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# prod — minimal runtime image (default target)
# ---------------------------------------------------------------------------
FROM base AS prod

ARG PORT
ENV NODE_ENV=production \
    PORT=${PORT} \
    HOST=0.0.0.0

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# package.json is required at run time, not just at build time: `"type":
# "module"` is what makes Node treat dist/*.js as ESM.
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE ${PORT}

# Liveness only — /healthz has no dependencies, so a MongoDB outage does not make
# Docker kill an otherwise healthy process (that is what /readyz is for).
# Node 24 has global fetch, so this needs no curl and keeps the image slim.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
