# hotaisle-ui, hosted for many people. Each visitor signs in with their own Hot Aisle API key, kept in
# memory for their session only.
#
#   docker build -t hotaisle-ui .
#   docker run -p 8080:8080 hotaisle-ui                           # sign in with your own API key
#   docker run -p 8080:8080 hotaisle-ui --demo                    # a public demo: sample data only
#   docker run -p 8080:8080 -v hotaisle-ui:/data hotaisle-ui --data /data   # keep machine records
#
# Put it behind HTTPS (any reverse proxy or platform load balancer). It listens on $PORT, or 8080.

# Base images are pinned by digest (a moved tag can't change what is built); Dependabot proposes updates.
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS bin
WORKDIR /src
COPY go.mod ./
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /hotaisle-ui . && mkdir -p /empty/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=bin /hotaisle-ui /hotaisle-ui
# a place for --data that the non-root user owns (a named volume mounted here takes its ownership)
COPY --from=bin --chown=65532:65532 /empty/data /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/hotaisle-ui", "--host", "auto"]
