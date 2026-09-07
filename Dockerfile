# syntax=docker/dockerfile:1

# The web app, compiled into web/build for the Go binary to embed. Corepack
# picks the pnpm version pinned in package.json.
FROM node:22-alpine AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# The server, statically linked so it can run from scratch: it never dials
# out, so it needs no CA bundle, and stdlib only means no go.sum.
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/*.go web/
COPY --from=web /src/web/build web/build
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mailarchive ./cmd/mailarchive

FROM scratch
COPY --from=server /mailarchive /mailarchive
# nobody:users, the owner Unraid gives appdata. The archive is written 0700
# and 0600, so the mounted /data must belong to this uid.
USER 99:100
ENV MAILARCHIVE_ADDR=:8080 MAILARCHIVE_DATA=/data
EXPOSE 8080
ENTRYPOINT ["/mailarchive", "serve"]
