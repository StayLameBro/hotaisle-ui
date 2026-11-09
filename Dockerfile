# hotaisle-ui, hosted for many people. Each visitor signs in with their own Hot Aisle API key, kept in
# memory for their session only.
#
#   docker build -t hotaisle-ui .
#   docker run -p 8080:8080 hotaisle-ui                           # sign in with your own API key
#   docker run -p 8080:8080 hotaisle-ui --demo                    # a public demo: sample data only
#   docker run -p 8080:8080 -v hotaisle-ui:/data hotaisle-ui --data /data   # keep machine records
#
# Put it behind HTTPS (any reverse proxy or platform load balancer). It listens on $PORT, or 8080.

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM golang:1.24-alpine AS bin
WORKDIR /src
COPY go.mod ./
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /hotaisle-ui . && mkdir -p /empty/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=bin /hotaisle-ui /hotaisle-ui
# a place for --data that the non-root user owns (a named volume mounted here takes its ownership)
COPY --from=bin --chown=65532:65532 /empty/data /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/hotaisle-ui", "--host", "auto"]
