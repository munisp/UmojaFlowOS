FROM golang:1.25.4-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/payment-engine ./cmd/payment-engine

FROM alpine:3.21

RUN addgroup -S umoja && adduser -S -D -H -G umoja umoja \
  && mkdir -p /var/lib/umojaflowos/webhook-evidence /var/lib/umojaflowos/webhook-reconciliation \
  && chown -R umoja:umoja /var/lib/umojaflowos
COPY --from=build /out/payment-engine /usr/local/bin/payment-engine
USER umoja:umoja
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/payment-engine"]
