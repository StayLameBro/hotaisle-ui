# AGENTS.md

A guide for coding agents (and people) working on hotaisle-ui: a web app for renting Hot Aisle MI300X GPUs, running
on Cloudflare Workers. The README has the product description.

## Run it

```sh
npm install
cp .dev.vars.example .dev.vars    # SESSION_SECRET: 32+ random characters
npm run dev                       # http://localhost:8787 (add ?demo for sample data)
npm run dev:fake                  # against a local stand-in API: email sign-in, keys tok-alice / tok-bob
npm test                          # Worker tests in the Workers runtime; run before every commit
npm run typecheck
npm run test:ui                   # layout and motion checks in headless Chrome (~3 min)
```

Node 20+. The Worker serves `web/dist` as static assets, so run `npm run build` after changing the app (or keep
`cd web && npm run watch` running).

## Where things are

| Path | What |
| --- | --- |
| `wrangler.jsonc` | the Worker: static assets, the `Account` Durable Object, vars |
| `worker/src/index.ts` | routes, the guard, sign-in (`/auth/*`), the API proxy (`/api/*`), records (`/records/*`) |
| `worker/src/session.ts` | the session cookie: AES-GCM, keys derived from `SESSION_SECRET` |
| `worker/src/account.ts` | one Durable Object per account: records, history, auto-end alarms |
| `worker/src/hotaisle.ts` | calls the Worker itself makes to Hot Aisle; the email sign-in adapter |
| `worker/dev/fake-api.mjs` | a stand-in Hot Aisle API for tests and `npm run dev:fake` |
| `shared/records.ts` | records, history and auto-end logic, shared by the Worker and sample data |
| `web/src/api.ts` | every call the app makes; sends them to sample data when that's on |
| `web/src/demo/api.ts` | sample data: an in-browser copy of the API and of `/records` |
| `web/src/Connect.tsx` | the sign-in screen (email link, API key, sample data) |
| `web/src/App.tsx` | views, state, what the drawing is told to show |
| `web/src/Launch.tsx`, `Machines.tsx` | ordering, the hold-to-launch key, machine cards, receipts, history |
| `web/src/Stage.tsx`, `web/src/iso/` | the drawing and its frame loop |
| `web/tests/stability.mjs` | drives the app (via `wrangler dev`) in headless Chrome; fails on any layout shift |

## Connecting it to the real API

The page calls `/api/*`, which the Worker forwards verbatim to `https://admin.hotaisle.app/api` with
`Authorization: Token <session token>`. The API surface the app depends on is what `web/src/demo/api.ts` implements;
compare its routes and JSON shapes with the live API to find mismatches, fix them in `web/src/api.ts`, and keep the
sample data in step.

**Email sign-in.** The schema defines `EmailLoginRequest {email}`, `EmailLoginResponse {claim_ticket, email,
expires_at}` and `EmailLoginClaimRequest {claim_ticket}` but no paths yet. Set `EMAIL_LOGIN_START_PATH` and
`EMAIL_LOGIN_CLAIM_PATH` in `wrangler.jsonc` when they're published. The shape of a finished claim isn't published
either: `claimEmailLogin` in `worker/src/hotaisle.ts` is the one place that reads it (it accepts `token`,
`session_token`, `api_key` or `session.token`, and treats 202/204/408/409/425/428 as still waiting). If session
tokens use a different `Authorization` scheme than `Token`, change it in `upstream()` and `proxy()`.

**Passkeys.** Not in the API yet. They would add `/auth/passkey/*` routes that relay the WebAuthn ceremony to Hot
Aisle and store the resulting token in the session, the same way email sign-in does.

**Auto-end.** The Account Durable Object ends machines with the token it was last used with. If session tokens expire
before a timer fires, the timer can't end the machine (it retries every minute and shows why on the card). A release
time on the machine in Hot Aisle's API would remove that dependency.

## Rules that must hold

Money:
- **Ending a machine must really end it.** Auto-end (`fireTimers` in `shared/records.ts`) releases VMs through
  `virtual_machines/{name}/` and bare metal through `bare_metal/{name}/?force=true`; a 404 counts as already gone. Any
  other failure retries every minute and shows the error on the machine. Never treat a failure as success.
- Minimum charges: 30 minutes for a VM, 8 hours for bare metal. Estimates and receipts apply them.

Keys and privacy:
- A token never reaches the page: not in a response body, a URL, or a readable cookie. It is only ever in the
  encrypted session cookie, or encrypted in the account's Durable Object while an auto-end timer is pending.
- Never log tokens, emails or claim tickets. Durable Objects are named by a hash of the email, not the email.
- The guard stays: `X-Requested-With: hotaisle-ui` on `/auth`, `/api`, `/records`, same-origin only,
  `SameSite=Strict` cookie, strict CSP.

Layout and motion (checked by `npm run test:ui`):
- Nothing moves unless the person asked: no layout shift, fixed-width numbers, the order fits its sheet.
- The drawing writes to the DOM only when a value changes and sleeps when nothing moves. Fans are WebGL, not SVG.
- One drawer out at a time, and none reverses on load.

## Not verified yet

Everything has run against sample data and the stand-in API only: not a real account, not the real email sign-in
endpoints, not bare metal for real, and not the deploy button.
