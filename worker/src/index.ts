// hotaisle-ui on Cloudflare Workers: the app's static files, and its backend.
//
//   /auth/*     sign in (an API key, or an emailed link), see who is signed in, sign out
//   /api/*      the Hot Aisle API, forwarded with the session's token (the API doesn't answer browsers directly,
//               and the token never reaches the page)
//   /records/*  this account's machine records, history and auto-end timers (a Durable Object per account)
//   anything else: the app
//
// Every /auth, /api and /records call must carry `X-Requested-With: hotaisle-ui` and, when the browser sends an
// Origin, come from this site. Together with the SameSite=Strict cookie, other sites can't make these calls.

import { apiBase, claimEmailLogin, emailLoginEnabled, send, startEmailLogin, whoIs, type Env } from './hotaisle';
import { accountId, readSession, sessionCookie, type Session } from './session';

export { Account } from './account';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function withHeaders(r: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  withHeaders(new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } }));
const fail = (status: number, message: string, headers: Record<string, string> = {}) =>
  withHeaders(new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }));

async function readJSON<T>(req: Request, limit: number): Promise<T | undefined> {
  const text = await req.text();
  if (text.length > limit) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const area = url.pathname.split('/')[1];
    if (area !== 'auth' && area !== 'api' && area !== 'records') return withHeaders(await env.ASSETS.fetch(req));

    // only this site's own pages can call these
    if (req.headers.get('X-Requested-With') !== 'hotaisle-ui') return fail(403, 'missing X-Requested-With header');
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return fail(403, 'cross-origin request refused');

    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
      return fail(500, 'This Worker has no SESSION_SECRET. Set one of 32+ random characters: `npx wrangler secret put SESSION_SECRET` (locally, in .dev.vars).');
    const session = await readSession(req, env.SESSION_SECRET);
    if (area === 'auth') return auth(req, env, url, session);
    if (!session?.token || !session.account) return fail(401, 'not signed in');
    if (area === 'api') return proxy(req, env, url, session.token);
    return records(req, env, url, session);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- sign-in

async function auth(req: Request, env: Env, url: URL, session: Session | undefined): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /auth/status':
      return json({
        signed_in: !!session?.token,
        kind: session?.token ? session.kind : undefined,
        waiting_for_email: session?.pending && !session.token ? { email: session.pending.email, expires_at: session.pending.expires_at } : undefined,
        email_login: emailLoginEnabled(env),
        passkeys: false,
        version: env.VERSION ?? 'dev',
      });

    case 'POST /auth/key': {
      const b = await readJSON<{ key?: string }>(req, 4096);
      const key = (b?.key ?? '').trim().replace(/^Token\s+/i, '');
      if (!key || /\s/.test(key)) return fail(400, "That doesn't look like an API key. It is one line, with no spaces.");
      const who = await whoIs(env, key);
      if (!who.ok) return fail(who.status, who.message);
      const account = await accountId(who.who.user?.email || 'key:' + key);
      return json(JSON.parse(who.body), 200, { 'Set-Cookie': await sessionCookie(env.SESSION_SECRET, { token: key, kind: 'key', account }) });
    }

    case 'POST /auth/email/start': {
      if (!emailLoginEnabled(env)) return fail(404, 'Email sign-in is not available yet. Use an API key.');
      const b = await readJSON<{ email?: string }>(req, 1024);
      const email = (b?.email ?? '').trim();
      if (!EMAIL.test(email) || email.length > 254) return fail(400, "That doesn't look like an email address.");
      const r = await startEmailLogin(env, email);
      if (!r.ok) return fail(r.status, r.message);
      const pending = { ticket: r.start.claim_ticket, email: r.start.email || email, expires_at: r.start.expires_at };
      const days = Math.max(1 / 1440, (Date.parse(pending.expires_at) - Date.now()) / 86400_000);
      return json({ email: pending.email, expires_at: pending.expires_at }, 200, { 'Set-Cookie': await sessionCookie(env.SESSION_SECRET, { pending }, days) });
    }

    case 'POST /auth/email/wait': {
      const p = session?.pending;
      if (!p) return fail(400, 'No email sign-in in progress.');
      if (Date.parse(p.expires_at) <= Date.now()) return fail(410, 'That link has expired. Send a new one.');
      const r = await claimEmailLogin(env, p.ticket);
      if (r.state === 'waiting') return json({ done: false });
      if (r.state === 'failed') return fail(400, r.message);
      const who = await whoIs(env, r.token);
      if (!who.ok) return fail(who.status, who.message);
      const account = await accountId(who.who.user?.email || p.email);
      const days = r.expires_at ? Math.max(1 / 1440, (Date.parse(r.expires_at) - Date.now()) / 86400_000) : 30;
      return json({ done: true, ...JSON.parse(who.body) }, 200, {
        'Set-Cookie': await sessionCookie(env.SESSION_SECRET, { token: r.token, kind: 'email', account }, Math.min(days, 30)),
      });
    }

    case 'POST /auth/signout':
      return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(env.SESSION_SECRET, undefined) });
  }
  return fail(404, 'not found');
}

// ---------------------------------------------------------------- the Hot Aisle API

const FORWARD_HEADERS = ['Content-Type', 'Accept'];

async function proxy(req: Request, env: Env, url: URL, token: string): Promise<Response> {
  const path = url.pathname.slice('/api'.length) + url.search;
  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Authorization', `Token ${token}`);
  headers.set('User-Agent', `hotaisle-ui/${env.VERSION ?? 'dev'}`);
  let r: Response;
  try {
    r = await send(env, apiBase(env) + path, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
  } catch (e) {
    return fail(502, 'Could not reach the Hot Aisle API: ' + (e as Error).message);
  }
  const out = new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' } });
  return withHeaders(out);
}

// ---------------------------------------------------------------- machine records

async function records(req: Request, env: Env, url: URL, session: Session): Promise<Response> {
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(session.account!));
  const inner = new Request('https://account' + url.pathname.slice('/records'.length) + url.search, {
    method: req.method,
    headers: { 'Content-Type': 'application/json', 'X-Hotaisle-Token': session.token! },
    body: req.method === 'GET' ? undefined : await req.text(),
  });
  const r = await stub.fetch(inner);
  return withHeaders(new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' } }));
}

