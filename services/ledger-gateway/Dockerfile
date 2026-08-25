# syntax=docker/dockerfile:1

# No native TLS/compression sys-crates in this one's lockfile (pure
# axum/tokio/serde) - lean build, just needs a linker (build-essential).
FROM rust:1-bookworm AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --bin ledger-gateway

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init curl \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system app && adduser --system --ingroup app app

WORKDIR /app
COPY --from=builder --chown=app:app /app/target/release/ledger-gateway ./ledger-gateway

ENV PORT=8083
EXPOSE 8083

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["./ledger-gateway"]
