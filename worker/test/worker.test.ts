import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { accountId } from '../src/session';

const ORIGIN = 'https://ui.test';
const H = { 'X-Requested-With': 'hotaisle-ui', 'Content-Type': 'application/json' };

/** One browser: keeps the session cookie between calls, like a real one. */
function browser() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = H) => {
    const r = await exports.default.fetch(ORIGIN + path, {
      method,
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.get('Set-Cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: r.status, text: await r.text(), setCookie: set, headers: r.headers };
  };
  return { call, cookie: () => cookie };
}

const upstreamCalls = async (): Promise<string[]> => (await (await env.UPSTREAM!.fetch('https://api.test/api/__calls')).json()) as string[];

describe('sign-in with an API key', () => {
  it('keeps the key out of the page: an encrypted, HttpOnly, Secure, SameSite=Strict cookie', async () => {
    const b = browser();
    const r = await b.call('POST', '/auth/key', { key: 'tok-alice' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).user.email).toBe('alice@example.com');
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/Secure/);
    expect(r.setCookie).toMatch(/SameSite=Strict/);
    expect(b.cookie()).not.toContain('tok-alice');
    expect(r.text).not.toContain('tok-alice');
    const status = JSON.parse((await b.call('GET', '/auth/status')).text);
    expect(status).toMatchObject({ signed_in: true, kind: 'key' });
    expect(JSON.stringify(status)).not.toContain('tok-alice');
  });

  it('refuses a key Hot Aisle refuses, and sets no session', async () => {
    const b = browser();
    const r = await b.call('POST', '/auth/key', { key: 'tok-nobody' });
    expect(r.status).toBe(401);
    expect(r.setCookie).toBeNull();
  });

  it('forwards API calls with each visitor’s own key', async () => {
    const alice = browser();
    const bob = browser();
    await alice.call('POST', '/auth/key', { key: 'tok-alice' });
    await bob.call('POST', '/auth/key', { key: 'tok-bob' });
    expect(JSON.parse((await alice.call('GET', '/api/teams/lab/whoami/')).text).who).toBe('alice@example.com');
    expect(JSON.parse((await bob.call('GET', '/api/teams/lab/whoami/')).text).who).toBe('bob@example.com');
    expect(await upstreamCalls()).toContain('GET /teams/lab/whoami/ key:tok-bob');
  });

  it('signs out', async () => {
    const b = browser();
    await b.call('POST', '/auth/key', { key: 'tok-alice' });
    expect((await b.call('POST', '/auth/signout')).setCookie).toMatch(/Max-Age=0/);
    expect((await b.call('GET', '/api/user/')).status).toBe(401);
  });
});

describe('the guard', () => {
  it('refuses calls without the custom header, from other origins, or without a session', async () => {
    const b = browser();
    await b.call('POST', '/auth/key', { key: 'tok-alice' });
    expect((await b.call('GET', '/api/user/', undefined, { 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await b.call('GET', '/api/user/', undefined, { ...H, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await b.call('GET', '/api/user/', undefined, { ...H, Origin: ORIGIN })).status).toBe(200);
    expect((await browser().call('GET', '/api/user/')).status).toBe(401);
    expect((await browser().call('GET', '/records/machines?team=lab')).status).toBe(401);
  });

  it('rejects a tampered cookie', async () => {
    const r = await exports.default.fetch(ORIGIN + '/api/user/', { headers: { ...H, Cookie: 'hai_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    expect(r.status).toBe(401);
  });

  it('serves the app with a strict Content Security Policy', async () => {
    const r = await exports.default.fetch(ORIGIN + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(await r.text()).toContain('<div id="root">');
  });
});

describe('sign-in with an email link', () => {
  it('waits for the link to be opened, then signs in; the claim ticket never reaches the page', async () => {
    const b = browser();
    const status0 = JSON.parse((await b.call('GET', '/auth/status')).text);
    expect(status0.email_login).toBe(true);
    const start = await b.call('POST', '/auth/email/start', { email: 'Carol@Example.com' });
    expect(start.status).toBe(200);
    expect(await upstreamCalls()).toContain('POST /user/email/login/ -');
    expect(start.text).not.toContain('ticket');
    expect(b.cookie()).not.toContain('ticket');
    expect(JSON.parse((await b.call('GET', '/auth/status')).text).waiting_for_email.email).toBe('carol@example.com');
    expect(JSON.parse((await b.call('POST', '/auth/email/wait')).text).done).toBe(false);
    expect((await b.call('GET', '/api/user/')).status).toBe(401);
    // the person opens the link in their email
    await env.UPSTREAM!.fetch('https://api.test/api/__open?email=carol%40example.com');
    const done = await b.call('POST', '/auth/email/wait');
    expect(JSON.parse(done.text)).toMatchObject({ done: true, user: { email: 'carol@example.com' } });
    expect(JSON.parse((await b.call('GET', '/auth/status')).text)).toMatchObject({ signed_in: true, kind: 'email' });
    expect(JSON.parse((await b.call('GET', '/api/teams/lab/whoami/')).text).who).toBe('carol@example.com');
    // a session from email sign-in goes out as X-Session-Key, never as an API key
    const calls = await upstreamCalls();
    expect(calls.filter((c) => c.startsWith('GET /teams/lab/whoami/ session:sess-')).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith('GET /teams/lab/whoami/ key:sess-'))).toBe(false);
    expect(calls).toContain('POST /user/email/complete/ -');
  });

  it('renews the session as it is used, and switches to the new key', async () => {
    const b = browser();
    await b.call('POST', '/auth/email/start', { email: 'dave@example.com' });
    await env.UPSTREAM!.fetch('https://api.test/api/__open?email=dave%40example.com');
    expect(JSON.parse((await b.call('POST', '/auth/email/wait')).text).done).toBe(true);
    const keyIn = async () => {
      await b.call('GET', '/api/teams/lab/whoami/');
      return (await upstreamCalls()).filter((c) => c.startsWith('GET /teams/lab/whoami/')).pop()!;
    };
    const first = await keyIn();
    // the session gets near its end: Hot Aisle answers the next call with a new key
    await env.UPSTREAM!.fetch('https://api.test/api/__expire?email=dave%40example.com&in=30');
    const renewing = await b.call('GET', '/api/teams/lab/whoami/');
    expect(renewing.setCookie).toMatch(/HttpOnly/);
    expect(renewing.text).not.toContain('sess-');
    const after = await keyIn();
    expect(after).toMatch(/ session:sess-/);
    expect(after).not.toBe(first);
  });

  it('never signs in from an unapproved link', async () => {
    const b = browser();
    await b.call('POST', '/auth/email/start', { email: 'erin@example.com' });
    expect(JSON.parse((await b.call('POST', '/auth/email/wait')).text).done).toBe(false);
    expect(JSON.parse((await b.call('GET', '/auth/status')).text).signed_in).toBe(false);
  });

  it('refuses something that is not an email address', async () => {
    expect((await browser().call('POST', '/auth/email/start', { email: 'not an email' })).status).toBe(400);
  });
});

describe('records', () => {
  it('keeps each account’s records apart', async () => {
    const alice = browser();
    const bob = browser();
    await alice.call('POST', '/auth/key', { key: 'tok-alice' });
    await bob.call('POST', '/auth/key', { key: 'tok-bob' });
    expect((await alice.call('POST', '/records/machines', { team: 'lab', name: 'vm-a', launched: true })).status).toBe(200);
    expect((await alice.call('GET', '/records/machines?team=lab')).text).toContain('vm-a');
    expect((await bob.call('GET', '/records/machines?team=lab')).text).not.toContain('vm-a');
  });

  it('stores no logins on the server: only launch records and history', async () => {
    const b = browser();
    await b.call('POST', '/auth/key', { key: 'tok-alice' });
    await b.call('POST', '/records/machines', { team: 'lab', name: 'vm9', launched: true, gpus: '1× MI300X', price_cents: 299 });
    await b.call('POST', '/records/history', { team: 'lab', name: 'vm8', gpus: '1× MI300X', ended_at: new Date().toISOString() });
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(await accountId('alice@example.com')));
    await runInDurableObject(stub, async (_o, state) => {
      expect([...(await state.storage.list()).keys()]).toEqual(['records']);
      expect(JSON.stringify(await state.storage.get('records'))).not.toContain('tok-alice');
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
