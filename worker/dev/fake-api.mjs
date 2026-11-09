// A stand-in for the Hot Aisle API's sign-in parts, for tests and for trying the sign-in screens locally
// without an account. It knows two API keys and does the email-link sign-in the API's schema describes:
// start with an email, get a private claim ticket, wait until the emailed link is opened, then receive a token.
//
// Email sign-in paths here are made up (the real ones aren't published yet); the Worker reads them from
// EMAIL_LOGIN_START_PATH and EMAIL_LOGIN_CLAIM_PATH.
//
//   node worker/dev/fake-api.mjs    runs it with `wrangler dev` pointed at it, and prints each "email" link

export const FAKE_EMAIL_START = '/fake/email-login/';
export const FAKE_EMAIL_CLAIM = '/fake/email-login/claim/';
export const KEYS = { 'tok-alice': 'alice@example.com', 'tok-bob': 'bob@example.com' };

export function fakeHotAisle({ onEmail } = {}) {
  const calls = [];
  const logins = new Map(); // ticket -> { email, opened, token }
  const tokens = new Map(Object.entries(KEYS));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetch(input, init) {
    const req = typeof input === 'string' || input instanceof URL ? new Request(input, init) : input;
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');
    const token = (req.headers.get('Authorization') ?? '').replace(/^Token /, '');
    calls.push(`${req.method} ${path}${url.search} ${token}`);

    // test controls
    if (path === '/__calls') return json(calls);
    if (path === '/__open') {
      const l = [...logins.values()].find((x) => x.email === url.searchParams.get('email'));
      if (!l) return json({ error: 'no login for that email' }, 404);
      l.opened = true;
      return json({ ok: true });
    }

    if (req.method === 'POST' && path === FAKE_EMAIL_START) {
      const { email } = await req.json();
      const ticket = 'ticket-' + crypto.randomUUID();
      const login = { email: String(email).toLowerCase(), opened: false, token: 'sess-' + crypto.randomUUID() };
      logins.set(ticket, login);
      onEmail?.(login.email, `/api/__open?email=${encodeURIComponent(login.email)}`);
      return json({ claim_ticket: ticket, email: login.email, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
    }
    if (req.method === 'POST' && path === FAKE_EMAIL_CLAIM) {
      const { claim_ticket } = await req.json();
      const l = logins.get(claim_ticket);
      if (!l) return json({ message: 'unknown ticket' }, 400);
      if (!l.opened) return new Response(null, { status: 202 });
      tokens.set(l.token, l.email);
      logins.delete(claim_ticket);
      return json({ token: l.token, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() });
    }

    const who = tokens.get(token);
    if (!who) return json({ message: 'Invalid token' }, 401);
    if (path === '/user/') return json({ user: { email: who, name: who.split('@')[0] }, teams: [{ handle: 'lab', name: 'Lab', roles: ['owner'], effective_roles: ['owner'] }] });
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.endsWith('/whoami/')) return json({ who, path });
    // enough for the signed-in app to load: an empty account
    if (path.endsWith('/balance/')) return json({ available_balance: 0, hourly_rate: 0, virtual_machine_count: 0, bare_metal_server_count: 0, minimum_balance: 1000 });
    if (req.method === 'GET') return json([]);
    return json({ message: 'the stand-in API only signs in' }, 400);
  }

  return { fetch, calls };
}

// ---------------------------------------------------------------- run it locally with wrangler dev
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const api = fakeHotAisle({
    onEmail: (email, link) => console.log(`\n  [fake email to ${email}] open to sign in: http://127.0.0.1:8788${link}\n`),
  });
  const server = createServer(async (req, res) => {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((r) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => r(Buffer.concat(chunks)));
    });
    const r = await api.fetch(new Request(`http://127.0.0.1:8788${req.url}`, { method: req.method, headers: req.headers, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  server.listen(8788, '127.0.0.1', async () => {
    console.log('fake Hot Aisle API on http://127.0.0.1:8788/api  (API keys: tok-alice, tok-bob)');
    const secret = (await import('node:crypto')).randomBytes(32).toString('base64url');
    const w = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--var', `SESSION_SECRET:${secret}`, '--var', 'API_BASE:http://127.0.0.1:8788/api', '--var', `EMAIL_LOGIN_START_PATH:${FAKE_EMAIL_START}`, '--var', `EMAIL_LOGIN_CLAIM_PATH:${FAKE_EMAIL_CLAIM}`], { stdio: 'inherit' });
    w.on('exit', (c) => process.exit(c ?? 0));
  });
}
