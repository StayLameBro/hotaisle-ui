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
| `worker/src/account.ts` | one Durable Object per account: launch records and history (no logins) |
| `worker/src/hotaisle.ts` | calls the Worker itself makes to Hot Aisle; the email sign-in adapter |
| `worker/dev/fake-api.mjs` | a stand-in Hot Aisle API for tests and `npm run dev:fake` |
| `shared/records.ts` | records and history logic, shared by the Worker and sample data |
| `web/src/api.ts` | every call the app makes; sends them to sample data when that's on |
| `web/src/demo/api.ts` | sample data: an in-browser copy of the API and of `/records` |
| `web/src/Connect.tsx` | the sign-in screen (email link, API key, sample data) |
| `web/src/App.tsx` | views, state, what the drawing is told to show |
| `web/src/Launch.tsx`, `Machines.tsx` | ordering, the hold-to-launch key, machine cards, receipts, history |
| `web/src/Stage.tsx`, `web/src/iso/` | the drawing and its frame loop |
| `web/tests/stability.mjs` | drives the app (via `wrangler dev`) in headless Chrome; fails on any layout shift |

## Connecting it to the real API

The page calls `/api/*`, which the Worker forwards verbatim to `https://admin.hotaisle.app/api` with the session's
credential: `Authorization: Token <key>` for an API key, `X-Session-Key: <token>` for an email sign-in
(`authHeaders` in `worker/src/hotaisle.ts`). The API surface the app depends on is what `web/src/demo/api.ts` implements;
compare its routes and JSON shapes with the live API to find mismatches, fix them in `web/src/api.ts`, and keep the
sample data in step.

**Email sign-in.** `POST /user/email/login/ {email}` returns a private `claim_ticket` (kept in the encrypted session,
never sent to the page); `POST /user/email/wait/ {claim_ticket}` holds up to 20 s and answers 202 (waiting) or 204
(approved); `POST /user/email/complete/ {claim_ticket}` answers 204 with the session token in `X-New-Session-Key` and
its expiry in `X-Session-Key-Expires`, or 401. All of it is in `worker/src/hotaisle.ts`.

**Passkeys.** Not in the API yet. They would add `/auth/passkey/*` routes that relay the WebAuthn ceremony to Hot
Aisle and store the resulting token in the session, the same way email sign-in does.

**Staying signed in.** Email sessions last 20 minutes. With under a minute left, Hot Aisle answers any authenticated
call with `X-New-Session-Key` and `X-Session-Key-Expires`; the proxy switches the session cookie to the new key when its
expiry is at least the current one's, so an older answer arriving late can't undo it. The old key keeps working until
its own expiry. The app calls the API at least every 15 seconds while it's open, so no separate keep-alive is needed.

**No auto-end, on purpose.** Hot Aisle's API has no scheduled shutdown, and an app-side timer could miss one (an
outage, an expired or revoked session) and leave a machine billing. Don't add one back unless the API itself can take
a shutdown time.

## Rules that must hold

Money:
- **Ending a machine must really end it.** End releases a VM through `DELETE virtual_machines/{name}/` (shutting it
  down doesn't stop billing; releasing does, and deletes its data) and bare metal through `bare_metal/{name}/`. Say so
  before the person confirms. Never show a failure as success.
- Minimum charges: 30 minutes for a VM, 8 hours for bare metal. Estimates and receipts apply them.

Keys and privacy:
- A token never reaches the page: not in a response body, a URL, or a readable cookie. It is only ever in the
  encrypted session cookie. Nothing stores logins on the server.
- Never log tokens, emails or claim tickets. Durable Objects are named by a hash of the email, not the email.
- The guard stays: `X-Requested-With: hotaisle-ui` on `/auth`, `/api`, `/records`, same-origin only,
  `SameSite=Strict` cookie, strict CSP.

Layout and motion (checked by `npm run test:ui`):
- Nothing moves unless the person asked: no layout shift, fixed-width numbers, the order fits its sheet.
- The drawing writes to the DOM only when a value changes and sleeps when nothing moves. Fans are WebGL, not SVG.
- One drawer out at a time, and none reverses on load.

## Not verified yet

Everything has run against sample data and the stand-in API only (which follows Hot Aisle's documented email
sign-in): not a real account, not the live email sign-in, not bare metal for real, and not the deploy button.
