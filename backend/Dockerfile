# Build the Configer backend as a small static binary.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# -trimpath drops local build paths; -s -w strip the symbol/debug tables for a
# smaller binary. CGO stays off so the result is fully static.
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/configer ./cmd/configer

FROM alpine:3.20
# git: the write-back engine shells out to it. ca-certificates: TLS to GitHub.
RUN apk add --no-cache git ca-certificates \
    && adduser -D -u 10001 configer
COPY --from=build /out/configer /usr/local/bin/configer
# Run unprivileged. The mounted repo volume must be writable by uid 10001
# (see deploy/docker-compose.yml).
USER configer
ENV CONFIGER_ADDR=:8080
EXPOSE 8080
# Liveness without shelling in curl: the binary probes its own /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["configer", "-healthcheck"]
ENTRYPOINT ["configer"]
