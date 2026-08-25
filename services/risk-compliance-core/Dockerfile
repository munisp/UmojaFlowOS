# syntax=docker/dockerfile:1

# aws-lc-sys (pulled in via reqwest's rustls-tls -> aws-lc-rs) compiles AWS-LC
# from source at build time and needs cmake + a C compiler + perl, not just
# cargo/rustc. zstd-sys also needs a C compiler. bookworm-slim covers all
# three; no musl/Alpine attempted here given the CGO/glibc lessons already
# hit twice in this session (vpp's confluent-kafka-go, this repo's
# tigerbeetle-go payment-engine).
FROM rust:1-bookworm AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential cmake perl pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --bin risk-compliance-core

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init curl \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system app && adduser --system --ingroup app app

WORKDIR /app
COPY --from=builder --chown=app:app /app/target/release/risk-compliance-core ./risk-compliance-core

ENV PORT=8082
EXPOSE 8082

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["./risk-compliance-core"]
