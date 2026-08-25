FROM rust:1.88-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --locked --bin risk-compliance-core

FROM debian:bookworm-slim AS runtime
RUN useradd --system --create-home --uid 10001 umoja
COPY --from=build /src/target/release/risk-compliance-core /usr/local/bin/risk-compliance-core
USER 10001:10001
EXPOSE 8082
ENTRYPOINT ["/usr/local/bin/risk-compliance-core"]
