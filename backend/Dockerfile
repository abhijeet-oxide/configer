# Build the Configer backend as a small static binary.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/configer ./cmd/configer

FROM alpine:3.20
RUN apk add --no-cache git ca-certificates
COPY --from=build /out/configer /usr/local/bin/configer
ENV CONFIGER_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["configer"]
