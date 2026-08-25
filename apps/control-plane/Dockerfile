# syntax=docker/dockerfile:1

# ---------- Build stage ----------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# corepack's dynamic pnpm download is unreliable (confirmed reproducibly
# broken on the sibling vpp repo, same packageManager pin) - install the
# pinned version directly via npm instead. 10.4.1 itself also turned out to
# have a broken CJS bundle there; 10.18.0 installs and builds cleanly
# against the same lockfile shape.
RUN npm install -g pnpm@10.18.0

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm build

# ---------- Runtime stage ----------
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.18.0

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --prod --no-frozen-lockfile \
  && pnpm store prune

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
