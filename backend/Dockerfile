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

# Server-side state: the workspace registry, the platform database (SQLite by
# default) and clones of connected repositories. It has to be a real directory
# owned by the unprivileged runtime user - the default CONFIGER_DATA is
# RELATIVE, so without this the very first thing the process does is try to
# mkdir inside a root-owned working directory and die with "permission denied".
RUN mkdir -p /var/lib/configer && chown configer:configer /var/lib/configer
ENV CONFIGER_DATA=/var/lib/configer
# Mount a volume here to keep applications and history across container
# replacement; without one, this state starts empty on every new container.
VOLUME ["/var/lib/configer"]

# A writable HOME, so git and any tool that wants per-user state has somewhere
# to put it instead of failing against a root-owned "/".
ENV HOME=/home/configer
WORKDIR /home/configer

# Run unprivileged. The mounted repository does NOT need to be chowned to this
# uid - Configer marks the repositories it manages as trusted rather than
# rewriting the ownership of an operator's own files (see internal/gitengine).
# It does need to be WRITABLE by uid 10001, because Configer commits into it.
USER configer
ENV CONFIGER_ADDR=:8080
EXPOSE 8080
# Liveness without shelling in curl: the binary probes its own /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["configer", "-healthcheck"]
ENTRYPOINT ["configer"]
