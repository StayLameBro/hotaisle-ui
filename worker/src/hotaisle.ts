// Calls to the Hot Aisle API made by the Worker itself (sign-in, and auto-end while nobody is looking).
// Everything the page asks for goes through the proxy in index.ts instead.

export type Env = {
  ASSETS: Fetcher;
  ACCOUNTS: DurableObjectNamespace;
  /** At least 32 random characters. Encrypts session cookies and tokens kept for auto-end. A Worker secret. */
  SESSION_SECRET: string;
  /** Default https://admin.hotaisle.app/api */
  API_BASE?: string;
  /**
   * Email sign-in. The API's schema defines the request and response types (EmailLoginRequest, EmailLoginResponse,
   * EmailLoginClaimRequest) but doesn't publish the endpoints yet; set these two paths (relative to API_BASE) once
   * it does. While either is unset, the sign-in screen offers an API key only.
   */
  EMAIL_LOGIN_START_PATH?: string;
  EMAIL_LOGIN_CLAIM_PATH?: string;
  VERSION?: string;
  /** Tests and local development only: a stand-in Hot Aisle API that calls go to instead of API_BASE. */
  UPSTREAM?: Fetcher;
};

/** Sends a request to the Hot Aisle API (or, in tests and local development, its stand-in). */
export const send = (env: Env, url: string, init: RequestInit) => (env.UPSTREAM ? env.UPSTREAM.fetch(url, init) : fetch(url, init));

export const apiBase = (env: Env) => (env.API_BASE || 'https://admin.hotaisle.app/api').replace(/\/+$/, '');
export const emailLoginEnabled = (env: Env) => !!(env.EMAIL_LOGIN_START_PATH && env.EMAIL_LOGIN_CLAIM_PATH);

const UA = (env: Env) => `hotaisle-ui/${env.VERSION ?? 'dev'}`;

export async function upstream(env: Env, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': UA(env) };
  if (opts.token) headers.Authorization = `Token ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return send(env, apiBase(env) + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

export type Who = { user: { email?: string; name?: string }; teams: unknown[] };

/** Who a token belongs to, or why it can't be used. */
export async function whoIs(env: Env, token: string): Promise<{ ok: true; who: Who; body: string } | { ok: false; status: number; message: string }> {
  let r: Response;
  try {
    r = await upstream(env, 'GET', '/user/', { token });
  } catch (e) {
    return { ok: false, status: 502, message: 'Could not reach the Hot Aisle API: ' + (e as Error).message };
  }
  const body = await r.text();
  if (r.status === 401 || r.status === 403) return { ok: false, status: 401, message: "Hot Aisle didn't accept that key. Check you copied all of it, and that it hasn't been deleted." };
  if (!r.ok) return { ok: false, status: 502, message: `The API answered ${r.status}: ${body.trim().slice(0, 300)}` };
  try {
    return { ok: true, who: JSON.parse(body) as Who, body };
  } catch {
    return { ok: false, status: 502, message: 'The API answered with something other than JSON.' };
  }
}

// ---------------------------------------------------------------- email sign-in (the API's types; paths are settings)

/** EmailLoginResponse: the private ticket stays with this Worker (in the encrypted session), never in the email. */
export type EmailLoginStart = { claim_ticket: string; email: string; expires_at: string };

export async function startEmailLogin(env: Env, email: string): Promise<{ ok: true; start: EmailLoginStart } | { ok: false; status: number; message: string }> {
  const r = await upstream(env, 'POST', env.EMAIL_LOGIN_START_PATH!, { body: { email } });
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

/**
 * Asks whether the emailed link has been opened, with the private ticket (EmailLoginClaimRequest). The finished
 * answer's exact shape isn't published yet: this takes the session token from `token`, `session_token`,
 * `api_key` or `session.token`, whichever is there. Still waiting: 202, 204, 408, 409, 425, 428, or a JSON
 * `status` of "pending". Anything else is a failure. This one function is all that changes if the shape differs.
 */
export async function claimEmailLogin(env: Env, ticket: string): Promise<{ state: 'done'; token: string; expires_at?: string } | { state: 'waiting' } | { state: 'failed'; message: string }> {
  let r: Response;
  try {
    r = await upstream(env, 'POST', env.EMAIL_LOGIN_CLAIM_PATH!, { body: { claim_ticket: ticket } });
  } catch (e) {
    return { state: 'failed', message: 'Could not reach the Hot Aisle API: ' + (e as Error).message };
  }
  const text = await r.text();
  if ([202, 204, 408, 409, 425, 428].includes(r.status)) return { state: 'waiting' };
  if (!r.ok) return { state: 'failed', message: messageOf(text) || `The API answered ${r.status}` };
  try {
    const j = JSON.parse(text) as Record<string, unknown> & { session?: { token?: string; expires_at?: string } };
    if (j.status === 'pending') return { state: 'waiting' };
    const token = [j.token, j.session_token, j.api_key, j.session?.token].find((v): v is string => typeof v === 'string' && v.length > 0);
    if (!token) return { state: 'failed', message: 'Signed in, but the API sent no session token.' };
    const expires = [j.expires_at, j.session?.expires_at].find((v): v is string => typeof v === 'string');
    return { state: 'done', token, expires_at: expires };
  } catch {
    return { state: 'failed', message: 'Unexpected answer from the API when finishing email sign-in.' };
  }
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
