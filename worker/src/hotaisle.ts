// Calls to the Hot Aisle API made by the Worker itself (sign-in).
// Everything the page asks for goes through the proxy in index.ts instead.

export type Env = {
  ASSETS: Fetcher;
  ACCOUNTS: DurableObjectNamespace;
  /** At least 32 random characters. Encrypts session cookies. A Worker secret. */
  SESSION_SECRET: string;
  /** Default https://admin.hotaisle.app/api */
  API_BASE?: string;
  VERSION?: string;
  /** Tests and local development only: a stand-in Hot Aisle API that calls go to instead of API_BASE. */
  UPSTREAM?: Fetcher;
};

/**
 * What a session calls the API with. An API key goes in `Authorization: Token <key>`; a session from email sign-in
 * goes in `X-Session-Key: <token>`.
 */
export type Credential = { token: string; kind: 'key' | 'email' };

export const authHeaders = (c: Credential): Record<string, string> => (c.kind === 'email' ? { 'X-Session-Key': c.token } : { Authorization: `Token ${c.token}` });

/** Sends a request to the Hot Aisle API (or, in tests and local development, its stand-in). */
export const send = (env: Env, url: string, init: RequestInit) => (env.UPSTREAM ? env.UPSTREAM.fetch(url, init) : fetch(url, init));

export const apiBase = (env: Env) => (env.API_BASE || 'https://admin.hotaisle.app/api').replace(/\/+$/, '');

const UA = (env: Env) => `hotaisle-ui/${env.VERSION ?? 'dev'}`;

export async function upstream(env: Env, method: string, path: string, opts: { cred?: Credential; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': UA(env), ...(opts.cred ? authHeaders(opts.cred) : {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return send(env, apiBase(env) + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

export type Who = { user: { email?: string; name?: string }; teams: unknown[] };

/** Who a credential belongs to, or why it can't be used. */
export async function whoIs(env: Env, cred: Credential): Promise<{ ok: true; who: Who; body: string } | { ok: false; status: number; message: string }> {
  let r: Response;
  try {
    r = await upstream(env, 'GET', '/user/', { cred });
  } catch (e) {
    return { ok: false, status: 502, message: 'Could not reach the Hot Aisle API: ' + (e as Error).message };
  }
  const body = await r.text();
  if (r.status === 401 || r.status === 403)
    return { ok: false, status: 401, message: cred.kind === 'key' ? "Hot Aisle didn't accept that key. Check you copied all of it, and that it hasn't been deleted." : 'Hot Aisle ended that sign-in. Sign in again.' };
  if (!r.ok) return { ok: false, status: 502, message: `The API answered ${r.status}: ${body.trim().slice(0, 300)}` };
  try {
    return { ok: true, who: JSON.parse(body) as Who, body };
  } catch {
    return { ok: false, status: 502, message: 'The API answered with something other than JSON.' };
  }
}

// ---------------------------------------------------------------- email sign-in
//
//   POST /user/email/login/     {email}        -> 200 {email, claim_ticket, expires_at}; Hot Aisle emails an approval link
//   POST /user/email/wait/      {claim_ticket} -> waits up to 20 s: 202 still pending, 204 approved
//   POST /user/email/complete/  {claim_ticket} -> 204, the session in X-New-Session-Key and X-Session-Key-Expires;
//                                                 401 if unapproved, expired or already used
//
// The claim ticket is private to this Worker (it lives in the encrypted session); the emailed link only approves.

const EMAIL_LOGIN = '/user/email/login/';
const EMAIL_WAIT = '/user/email/wait/';
const EMAIL_COMPLETE = '/user/email/complete/';

export type EmailLoginStart = { claim_ticket: string; email: string; expires_at: string };

export async function startEmailLogin(env: Env, email: string): Promise<{ ok: true; start: EmailLoginStart } | { ok: false; status: number; message: string }> {
  let r: Response;
  try {
    r = await upstream(env, 'POST', EMAIL_LOGIN, { body: { email } });
  } catch (e) {
    return { ok: false, status: 502, message: 'Could not reach the Hot Aisle API: ' + (e as Error).message };
  }
  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status === 429 ? 429 : 400, message: messageOf(text) || `The API answered ${r.status}` };
  try {
    const j = JSON.parse(text) as EmailLoginStart;
    if (!j.claim_ticket || !j.expires_at) throw new Error('missing claim_ticket');
    return { ok: true, start: j };
  } catch {
    return { ok: false, status: 502, message: 'Unexpected answer from the API when starting email sign-in.' };
  }
}

/** Waits (up to about 20 seconds) for the emailed link to be approved. */
export async function waitEmailLogin(env: Env, ticket: string): Promise<'approved' | 'waiting' | { failed: string }> {
  let r: Response;
  try {
    r = await upstream(env, 'POST', EMAIL_WAIT, { body: { claim_ticket: ticket } });
  } catch (e) {
    return { failed: 'Could not reach the Hot Aisle API: ' + (e as Error).message };
  }
  const text = await r.text();
  if (r.status === 204) return 'approved';
  if (r.status === 202) return 'waiting';
  return { failed: r.status === 401 ? 'That sign-in link has expired. Send a new one.' : messageOf(text) || `The API answered ${r.status}` };
}

/** Exchanges an approved claim ticket for a session token. */
export async function completeEmailLogin(env: Env, ticket: string): Promise<{ token: string; expires?: number } | { failed: string }> {
  let r: Response;
  try {
    r = await upstream(env, 'POST', EMAIL_COMPLETE, { body: { claim_ticket: ticket } });
  } catch (e) {
    return { failed: 'Could not reach the Hot Aisle API: ' + (e as Error).message };
  }
  await r.text();
  const token = r.headers.get('X-New-Session-Key');
  if (r.status === 401) return { failed: 'That sign-in was not approved, has expired, or was already used. Send a new link.' };
  if (!r.ok || !token) return { failed: `Unexpected answer from the API when finishing email sign-in (${r.status}).` };
  const expires = Date.parse(r.headers.get('X-Session-Key-Expires') ?? '');
  return { token, expires: Number.isFinite(expires) ? expires : undefined };
}

function messageOf(text: string): string {
  const t = text.trim();
  try {
    const j = JSON.parse(t);
    return String(j.message || j.error || j.detail || '').slice(0, 300);
  } catch {
    return t.slice(0, 300);
  }
}
