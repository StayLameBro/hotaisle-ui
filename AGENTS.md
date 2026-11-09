# AGENTS.md

A brief for coding agents (and people) working on hotaisle-ui: a Go binary with an embedded React app for renting
Hot Aisle MI300X GPUs, locally or hosted for many people. Read this first; the README has the product description.

## Run it

```sh
make demo                         # build everything, open with sample data (no account, nothing billed)
make test                         # go vet, go test, TypeScript check: run before every commit
make test-ui                      # layout and motion checks in headless Chrome (~3 min; needs Chrome)
./bin/hotaisle-ui --host :8080 --demo   # the hosted mode, as a public demo
```

Go 1.24+, Node 20+. `make build` runs `npm ci` and `vite build`, then embeds `web/dist` into the binary. For front-end
work: `cd web && npm run watch` in one terminal, `./bin/hotaisle-ui --demo --static web/dist` in another, reload.

## Where things are

| Path | What |
| --- | --- |
| `main.go` | flags; local mode (opens a browser) or `--host` (many people) |
| `internal/server/server.go` | the proxy that adds the API key, the guard, `/local/*` endpoints, auto-end timers |
| `internal/server/hosted.go` | hosted mode: per-visitor sessions, per-account records, demo sandboxes |
| `internal/demo/demo.go` | the sample-data API: an in-memory copy of the Hot Aisle API, built from its docs |
| `internal/state` | machine records: launch time, price, auto-end timer, history of ended runs |
| `internal/config` | reads and writes the Hot Aisle CLI's `~/.hotaisle/config.json` (local mode only) |
| `web/src/api.ts` | every API call the UI makes, and the VM / bare-metal routing |
| `web/src/App.tsx` | views, state, what the drawing is told to show |
| `web/src/Launch.tsx`, `Machines.tsx` | ordering, the hold-to-launch key, machine cards, receipts, history |
| `web/src/Stage.tsx` | the drawing's frame loop: camera springs, drawers, tags, GPU heat |
| `web/src/iso/hall.ts` | builds the rack row SVG; `fanGL.ts` draws every fan in one WebGL call |
| `web/tests/stability.mjs` | drives the real binary in headless Chrome and fails on any layout shift |

## Connecting it to the real API

The UI only ever calls `/api/*` (forwarded verbatim to `https://admin.hotaisle.app/api` with `Authorization: Token
...`) and `/local/*` (this server's own endpoints). So the API surface it depends on is exactly what
`internal/demo/demo.go` implements. To check it against the real API, compare the routes and JSON shapes in
`demo.go` with the live ones; any mismatch is fixed in `web/src/api.ts` (and mirrored in `demo.go`, so the demo stays
a faithful copy). Things the drawing guesses because the API doesn't say: which other tenants share a server, and
which of a server's 8 GPU slots a machine has. If the API ever exposes those, `Stage.tsx`'s `layout()` is where they
go.

## Rules that must hold

Money:
- **Ending a machine must really end it.** Auto-end (`fireTimers` in `server.go`) releases VMs through
  `virtual_machines/{name}/` and bare metal through `bare_metal/{name}/?force=true`; a 404 counts as already gone.
  Any other failure retries every minute and shows the error on the machine. Never treat a failure as success.
- Minimum charges: 30 minutes for a VM, 8 hours for bare metal. Estimates and receipts apply them.

Keys and privacy:
- The API key never reaches the page. Local mode keeps it in the CLI config file (0600); hosted mode keeps it in
  memory on the visitor's session only. Never log it, never write it to disk in hosted mode, never put it in a URL.
- Hosted mode never reads the host's `~/.hotaisle` or `~/.ssh`. Hosted record files never contain a key or an email.
- SSH key comments are often email addresses: they are never shown or uploaded (`localPublicKeys`).
- Local mode's guard (127.0.0.1 only, Host check, one-time link cookie, `X-Requested-With`, same-origin) stays as is.

Layout and motion (checked by `make test-ui`):
- Nothing moves unless the person asked: no layout shift, fixed-width numbers, the order fits its sheet.
- The drawing writes to the DOM only when a value changes and sleeps when nothing moves. Fans are WebGL, not SVG.
- One drawer out at a time, and none reverses on load.

Tests to keep green: `go test ./...` (including `hosted_test.go`: sessions never share a key, the demo site refuses
real keys, auto-end uses the owner's key), `npm run typecheck`, `make test-ui`.

## Not verified yet

Everything has run against the sample-data API only. Not yet against a real account: field names and status values,
the bare-metal flow (reserve, install stages, power, reinstall, release), and the VM web console. Start there.

## Releasing and hosting

- Push a tag `vX.Y.Z`: `.github/workflows/release.yml` builds binaries for macOS, Linux and Windows, attaches them to a
  GitHub release, and publishes the Docker image to `ghcr.io/<owner>/hotaisle-ui`.
- The image runs `--host auto` (listens on `$PORT` or 8080) as a non-root user. Put it behind HTTPS and run one
  instance: sessions live in its memory. `--data /data` with a volume keeps machine records across restarts.
