// A stand-in for the Hot Aisle API's sign-in parts, for tests and for trying the sign-in screens locally
// without an account. It knows two API keys (sent as `Authorization: Token <key>`) and does Hot Aisle's email
// sign-in: start with an email and get a private claim ticket; `wait` answers 202 until the emailed link is
// approved, then 204; `complete` exchanges the ticket for a session, sent back in the X-New-Session-Key header and
// used as `X-Session-Key: <token>`. Each call is logged with how it authenticated ("key:…" or "session:…").
//
//   node worker/dev/fake-api.mjs    runs it with `wrangler dev` pointed at it, and prints each "email" link

export const KEYS = { 'tok-alice': 'alice@example.com', 'tok-bob': 'bob@example.com' };

export function fakeHotAisle({ onEmail } = {}) {
  const calls = [];
  const logins = new Map(); // ticket -> { email, opened, token }
  const tokens = new Map(Object.entries(KEYS));
  const sessions = new Map(); // session token -> { email, expires }
  const LIFETIME = 20 * 60_000; // Hot Aisle's email sessions last 20 minutes
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetch(input, init) {
    const req = typeof input === 'string' || input instanceof URL ? new Request(input, init) : input;
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');
    const key = (req.headers.get('Authorization') ?? '').replace(/^Token /, '');
    const session = req.headers.get('X-Session-Key') ?? '';
    calls.push(`${req.method} ${path}${url.search} ${session ? 'session:' + session : key ? 'key:' + key : '-'}`);

    // test controls
    if (path === '/__calls') return json(calls);
    if (path === '/__expire') {
      // bring a person's sessions near their end, as if 19 minutes had passed
      for (const x of sessions.values()) if (x.email === url.searchParams.get('email')) x.expires = Date.now() + Number(url.searchParams.get('in') ?? 30) * 1000;
      return json({ ok: true });
    }
    if (path === '/__open') {
      const l = [...logins.values()].find((x) => x.email === url.searchParams.get('email'));
      if (!l) return json({ error: 'no login for that email' }, 404);
      l.opened = true;
      return json({ ok: true });
    }

    if (req.method === 'POST' && path === '/user/email/login/') {
      const { email } = await req.json();
      const ticket = 'ticket-' + crypto.randomUUID();
      const login = { email: String(email).toLowerCase(), opened: false, token: 'sess-' + crypto.randomUUID() };
      logins.set(ticket, login);
      onEmail?.(login.email, `/api/__open?email=${encodeURIComponent(login.email)}`);
      return json({ claim_ticket: ticket, email: login.email, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
    }
    if (req.method === 'POST' && path === '/user/email/wait/') {
      const { claim_ticket } = await req.json();
      const l = logins.get(claim_ticket);
      if (!l) return json({ message: 'unknown ticket' }, 401);
      if (!l.opened) await new Promise((r) => setTimeout(r, 300)); // the real one holds the request up to 20 s
      return new Response(null, { status: l.opened ? 204 : 202 });
    }
    if (req.method === 'POST' && path === '/user/email/complete/') {
      const { claim_ticket } = await req.json();
      const l = logins.get(claim_ticket);
      if (!l || !l.opened) return json({ message: 'not approved, expired, or already used' }, 401);
      const expires = Date.now() + LIFETIME;
      sessions.set(l.token, { email: l.email, expires });
      logins.delete(claim_ticket);
      return new Response(null, { status: 204, headers: { 'X-New-Session-Key': l.token, 'X-Session-Key-Expires': new Date(expires).toUTCString() } });
    }

    // an API key only as a key, a session only as a session; an expired session is refused
    const live = session ? sessions.get(session) : undefined;
    if (live && live.expires <= Date.now()) return json({ message: 'Session expired' }, 401);
    const who = session ? live?.email : tokens.get(key);
    if (!who) return json({ message: 'Invalid token' }, 401);
    // with under a minute left, any call answers with a new key; the old one keeps working until it expires
    const renew = live && live.expires - Date.now() < 60_000 ? (() => {
      const token = 'sess-' + crypto.randomUUID();
      const expires = Date.now() + LIFETIME;
      sessions.set(token, { email: who, expires });
      return { 'X-New-Session-Key': token, 'X-Session-Key-Expires': new Date(expires).toUTCString() };
    })() : undefined;
    const r = await answer(req, path, who);
    if (renew) for (const [k, v] of Object.entries(renew)) r.headers.set(k, v);
    return r;
  }

  async function answer(req, path, who) {
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
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
    const w = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--var', `SESSION_SECRET:${secret}`, '--var', 'API_BASE:http://127.0.0.1:8788/api'], { stdio: 'inherit' });
    w.on('exit', (c) => process.exit(c ?? 0));
  });
}
