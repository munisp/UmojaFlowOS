# syntax=docker/dockerfile:1

# tigerbeetle-go is a CGO binding shipping prebuilt glibc-linked static
# archives (pkg/native/x86_64-linux/libtb_client.a, no musl variant) - build
# and run on Debian/glibc, not Alpine/musl (confirmed reproducibly broken
# for the same class of dependency, confluent-kafka-go/librdkafka, in the
# sibling vpp repo: "undefined reference to `__strdup'" etc. across dozens
# of musl-missing glibc symbols).
FROM golang:1.25-bookworm AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -o payment-engine ./cmd/payment-engine \
 && CGO_ENABLED=1 GOOS=linux go build -o fabric-attestation-worker ./cmd/fabric-attestation-worker

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init curl \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system app && adduser --system --ingroup app app

WORKDIR /app
COPY --from=builder --chown=app:app /app/payment-engine ./payment-engine
COPY --from=builder --chown=app:app /app/fabric-attestation-worker ./fabric-attestation-worker

ENV PORT=8081
EXPOSE 8081

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["./payment-engine"]
