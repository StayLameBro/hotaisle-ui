// Sample data: an in-browser stand-in for the Hot Aisle API (and for this app's machine records), so the app
// can be tried, developed and recorded without an account and without spending money. It follows the shapes
// in the public API document. Prices and specs mirror the public pricing page; timings are made up and short.
//
// It lives in this tab: state is kept in sessionStorage, so a reload keeps your sample machines, and nothing
// leaves the browser.

import {
  addEnded,
  checkUpdate,
  emptyRecords,
  historyOf,
  listMachines,
  pruneMachines,
  updateMachine,
  type Ended,
  type MachineUpdate,
  type RecordsState,
} from '../../../shared/records';

const GIB = 2 ** 30;
const TB = 1e12;
const TEAM = 'demo-lab';
const METAL_MINIMUM_MS = 8 * 3600_000;
const VM_MINIMUM_MS = 30 * 60_000;
const KEY = 'hotaisle-ui:sample-data';

type GPU = { count: number; manufacturer?: string; model?: string };
type Specs = { cpu_cores: number; ram_capacity: number; disk_capacity: number; gpus: GPU[]; cpus?: unknown };
type Offer = { Quantity: number; MinimumReservationMinutes: number; OnDemandPrice: number; Specs: Specs };
type SSHAccess = { ip_address: string; port: number };
type Host = { name: string; slots: string[] }; // "" free, "-" someone else's, or a machine's name
type VMRec = {
  name: string;
  deployment_id: string;
  description: string;
  ip_address: string;
  status: string;
  ssh_access: SSHAccess;
  specs: Specs;
  price: number;
  host: string;
  slots: number[];
  created: number;
  readyAt: number;
  runningAt: number; // 0 = no power change under way
  powered: boolean;
};
type ServerRec = { name: string; deployment_id: string; description: string; ip_address: string; ssh_access: SSHAccess; price: number; created: number; installAt: number; off: boolean };
type SSHKey = { type: string; public_key: string; fingerprint: string; comment?: string };
type State = {
  hosts: Host[];
  balance: number; // cents
  balanceAt: number;
  offers: Offer[];
  vms: VMRec[];
  metal: ServerRec[];
  keys: SSHKey[];
  nextPort: number;
  nextIP: number;
  records: RecordsState;
};

/** The order a bare-metal install reports, and when each stage starts (sped up). */
const INSTALL_STAGES: [number, string][] = [
  [0, 'shutting_down'], [2000, 'ac_reset'], [4000, 'bios_reset'], [6000, 'booting_installer'], [9000, 'installing_os'],
  [15000, 'finalizing_os'], [18000, 'first_boot'], [21000, 'first_boot_tasks'], [24000, 'installed'],
];
const stage = (s: ServerRec, now: number) => INSTALL_STAGES.filter(([at]) => now - s.installAt >= at).pop()![1];

/** One XE9680 as bare metal: eight MI300X, two Xeon Platinum 8470, 2 TB, 122 TB of NVMe. */
const metalSpecs = () => ({
  cpu_cores: 104,
  ram_capacity: 2048 * GIB,
  disk_capacity: 8 * 15360 * 1e9,
  gpus: [{ count: 8, manufacturer: 'AMD', model: 'MI300X' }],
  cpus: [{ count: 2, manufacturer: 'Intel', model: 'Xeon Platinum 8470', cores: 52, frequency: 2000000000 }],
});

function fresh(): State {
  const cpu = (cores: number) => ({ count: 1, manufacturer: 'Intel', model: 'Xeon Platinum 8470', cores, frequency: 2000000000 });
  const offer = (n: number, cores: number, qty: number): Offer => ({
    Quantity: qty,
    MinimumReservationMinutes: 30,
    OnDemandPrice: 299 * n,
    Specs: { cpu_cores: cores, ram_capacity: 224 * GIB * n, disk_capacity: 12 * TB, gpus: [{ count: n, manufacturer: 'AMD', model: 'MI300X' }], cpus: cpu(cores) },
  });
  const host = (name: string, ...taken: number[]): Host => ({ name, slots: Array.from({ length: 8 }, (_, i) => (taken.includes(i) ? '-' : '')) });
  return {
    // Other customers hold most of one server. Machines go where the app's preview says they will: next to
    // your others when there is room, else onto a free server.
    hosts: [host('enc1-host-07'), host('enc1-host-12', 0, 1, 2, 3, 4, 5), host('enc1-host-15')],
    balance: 25000,
    balanceAt: Date.now(),
    offers: [offer(1, 13, 6), offer(2, 26, 3), offer(4, 52, 2)],
    vms: [],
    metal: [],
    keys: [],
    nextPort: 22101,
    nextIP: 40,
    records: emptyRecords(),
  };
}

let state: State | undefined;
function load(): State {
  if (state) return state;
  try {
    const saved = sessionStorage.getItem(KEY);
    if (saved) return (state = JSON.parse(saved) as State);
  } catch {
    /* storage unavailable: start fresh */
  }
  return (state = fresh());
}
function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: it lives in memory */
  }
}

const freeSlots = (h: Host) => h.slots.filter((s) => s === '').length;
const hostOf = (s: State, name: string) => s.hosts.find((h) => h.name === name)!;
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const rate = (s: State) => s.vms.reduce((a, v) => a + v.price, 0) + s.metal.reduce((a, m) => a + m.price, 0);

/** Charges for running machines since the last call, and moves boots along. */
function tick(s: State) {
  const now = Date.now();
  s.balance -= (rate(s) * (now - s.balanceAt)) / 3600_000;
  s.balanceAt = now;
  for (const v of s.vms) {
    if (v.status !== 'ready' && now > v.readyAt) v.status = 'ready';
    if (v.runningAt && now > v.runningAt) {
      v.powered = true;
      v.runningAt = 0;
    }
  }
}

const vmJSON = (v: VMRec) => ({ name: v.name, deployment_id: v.deployment_id, description: v.description, ip_address: v.ip_address, status: v.status, ssh_access: v.ssh_access, ...v.specs });
const metalJSON = (m: ServerRec, now: number) => ({
  ...metalSpecs(),
  name: m.name,
  deployment_id: m.deployment_id,
  description: m.description,
  ip_address: m.ip_address,
  manufacturer: 'Dell',
  model: 'PowerEdge XE9680',
  ssh_access: m.ssh_access,
  specs: metalSpecs(),
  os_status: { os_install_status: stage(m, now), last_imaging_update: new Date(now).toISOString() },
});
const teamJSON = () => {
  const roles = ['owner', 'purchaser', 'operator', 'user'];
  return { handle: TEAM, name: 'Demo Lab', description: 'Sample data, nothing here is billed', maximum_virtual_machines: 4, maximum_bare_metal_servers: 1, roles, effective_roles: roles, invitation: false };
};

export type DemoResponse = { status: number; body?: unknown; text?: string };
const ok = (body: unknown, status = 200): DemoResponse => ({ status, body });
const no = (status: number, text: string): DemoResponse => ({ status, text });

async function fingerprint(b64: string) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return 'SHA256:' + btoa(String.fromCharCode(...sum)).replace(/=+$/, '');
}

/** Answers a call the app would make to the Worker (/api, /records), with sample data. */
export async function demoFetch(method: string, rawPath: string, body?: unknown): Promise<DemoResponse> {
  const s = load();
  tick(s);
  await new Promise((r) => setTimeout(r, 120)); // a little network feel, so loading states show
  const r = await route(s, method, rawPath, body);
  save();
  return r;
}

async function route(s: State, m: string, rawPath: string, body: unknown): Promise<DemoResponse> {
  const url = new URL(rawPath, 'https://sample.invalid');
  const q = url.searchParams;
  const now = Date.now();

  // this app's records
  if (url.pathname.startsWith('/records/')) {
    const p = url.pathname.slice('/records'.length);
    if (m === 'GET' && p === '/machines') return ok(listMachines(s.records, q.get('team') ?? ''));
    if (m === 'POST' && p === '/machines') {
      const bad = checkUpdate((body ?? {}) as MachineUpdate);
      return bad ? no(400, bad) : ok(updateMachine(s.records, body as MachineUpdate));
    }
    if (m === 'POST' && p === '/machines/prune') {
      const b = body as { team: string; names: string[] };
      pruneMachines(s.records, b.team, b.names);
      return ok({ ok: true });
    }
    if (m === 'GET' && p === '/history') return ok(historyOf(s.records, q.get('team') ?? ''));
    if (m === 'POST' && p === '/history') {
      const e = body as Ended;
      addEnded(s.records, { ...e, ended_at: e.ended_at || new Date(now).toISOString() });
      return ok({ ok: true });
    }
    return no(404, 'not found');
  }

  const p = url.pathname.replace(/^\/api/, '').replace(/^\/+|\/+$/g, '');
  const parts = p.split('/').map(decodeURIComponent);
  if (p === 'user' && m === 'GET') return ok({ user: { name: 'Demo User', email: 'demo@example.com', created: '2026-01-24T15:00:00Z', email_auth_enabled: false }, teams: [teamJSON()] });
  if (p === 'teams' && m === 'GET') return ok([teamJSON()]);
  if (p === 'user/ssh_keys' && m === 'GET') return ok(s.keys);
  if (p === 'user/ssh_keys' && m === 'POST') {
    const f = String((body as { authorized_key?: string })?.authorized_key ?? '').trim().split(/\s+/);
    if (f.length < 2 || !(f[0].startsWith('ssh-') || f[0].startsWith('ecdsa-'))) return no(422, 'authorized_key must look like: ssh-ed25519 AAAA... comment');
    let fp: string;
    try {
      fp = await fingerprint(f[1]);
    } catch {
      return no(422, 'the key data is not valid base64');
    }
    if (s.keys.some((k) => k.fingerprint === fp)) return no(409, 'key already registered');
    const k = { type: f[0], public_key: f[1], fingerprint: fp, comment: f.slice(2).join(' ') };
    s.keys.push(k);
    return ok(k);
  }
  if (parts.length === 3 && parts[0] === 'user' && parts[1] === 'ssh_keys' && m === 'DELETE') {
    const i = s.keys.findIndex((k) => k.fingerprint === parts[2]);
    if (i < 0) return no(404, 'SSH key not found');
    s.keys.splice(i, 1);
    return { status: 204 };
  }
  if (parts[0] !== 'teams' || parts.length < 2) return no(404, 'not found in sample data');
  if (parts[1] !== TEAM) return no(404, 'team not found');
  const rest = parts.slice(2);
  const r0 = rest[0];

  if (rest.length === 1 && r0 === 'balance' && m === 'GET') {
    const rt = rate(s);
    return ok({
      available_balance: Math.trunc(s.balance),
      hourly_rate: rt,
      virtual_machine_count: s.vms.length,
      bare_metal_server_count: s.metal.length,
      active_stripe_products: [],
      minimum_balance: 1000,
      ...(rt > 0 ? { estimated_runout_time: new Date(now + (s.balance / rt) * 3600_000).toISOString() } : {}),
    });
  }
  if (rest.length === 1 && r0 === 'purchase-credits' && m === 'POST') {
    const cents = Number((body as { cents?: number })?.cents);
    if (!(cents >= 2000)) return no(400, 'cents must be at least 2000 ($20.00)');
    s.balance += cents; // sample data: no checkout, credits land at once
    return ok({ checkout_url: '', expires_at: new Date(now + 3600_000).toISOString(), demo_credited: true });
  }
  if (rest.length === 2 && r0 === 'virtual_machines' && rest[1] === 'available' && m === 'GET') return ok(s.offers);
  if (rest.length === 2 && r0 === 'bare_metal' && rest[1] === 'available' && m === 'GET')
    return ok([{ Quantity: s.hosts.filter((h) => freeSlots(h) === 8).length, MinimumReservationMinutes: 480, OnDemandPrice: 339 * 8, Specs: metalSpecs() }]);
  if (rest.length === 1 && r0 === 'bare_metal' && m === 'GET') return ok(s.metal.map((x) => metalJSON(x, now)));
  if (rest.length === 1 && r0 === 'bare_metal' && m === 'POST') return reserve(s, now);
  if (rest.length >= 2 && r0 === 'bare_metal') {
    const sv = s.metal.find((x) => x.name === rest[1]);
    return sv ? metalRoute(s, m, sv, rest.slice(2).join('/'), q, body, now) : no(404, 'bare metal server not found');
  }
  if (rest.length === 1 && r0 === 'virtual_machines' && m === 'GET') return ok([...s.vms].sort((a, b) => a.created - b.created).map(vmJSON));
  if (rest.length === 1 && r0 === 'virtual_machines' && m === 'POST') return provision(s, body, now);
  if (rest.length >= 2 && r0 === 'virtual_machines') {
    const v = s.vms.find((x) => x.name === rest[1]);
    return v ? vmRoute(s, m, v, rest[2] ?? '', q, body, now) : no(404, 'virtual machine not found');
  }
  return no(404, 'not found in sample data');
}

function provision(s: State, body: unknown, now: number): DemoResponse {
  const req = (body ?? {}) as { gpus?: GPU[]; user_data_url?: string };
  const want = req.gpus?.[0];
  if (!want || !(want.count >= 1)) return no(400, 'request must name the GPUs, e.g. {"gpus":[{"count":1,"model":"MI300X"}]}');
  if (s.vms.length >= 4) return no(401, 'Maximum VMs already provisioned for this team');
  if (!s.keys.length) return no(428, 'Team has no accepted user-role member with an SSH key');
  const o = s.offers.find((x) => x.Specs.gpus[0].count === want.count && (!want.model || x.Specs.gpus[0].model?.toLowerCase() === want.model.toLowerCase()));
  if (!o || o.Quantity === 0) return no(404, 'No available virtual machine matching requested specifications');
  if (s.balance - (o.OnDemandPrice * o.MinimumReservationMinutes) / 60 < 1000) return no(402, 'Insufficient balance to provision virtual machine');
  // A server already running this team's machines while it has room, as a scheduler packs them; otherwise a
  // free server; otherwise best fit: the server with the fewest free GPUs that still has room.
  const need = want.count;
  let h = s.vms.map((v) => hostOf(s, v.host)).find((x) => freeSlots(x) >= need);
  h ??= s.hosts.find((x) => freeSlots(x) === 8);
  h ??= s.hosts.filter((x) => freeSlots(x) >= need).sort((a, b) => freeSlots(a) - freeSlots(b))[0];
  if (!h) return no(404, 'No available virtual machine matching requested specifications');
  o.Quantity--;
  s.nextIP++;
  s.nextPort++;
  const v: VMRec = {
    name: `enc1-${hex(3)}`,
    deployment_id: crypto.randomUUID(),
    description: '',
    ip_address: `10.20.${1 + Math.floor(s.nextIP / 250)}.${s.nextIP % 250}`,
    status: 'ready',
    ssh_access: { ip_address: '198.51.100.17', port: s.nextPort },
    specs: o.Specs,
    price: o.OnDemandPrice,
    host: h.name,
    slots: [],
    created: now,
    readyAt: now,
    runningAt: now + 4000,
    powered: false,
  };
  for (let i = 0; i < 8 && v.slots.length < need; i++) if (h.slots[i] === '') ((h.slots[i] = v.name), v.slots.push(i));
  if (req.user_data_url) {
    v.status = 'rebuild_queued';
    v.readyAt = v.runningAt = now + 25000;
  }
  s.vms.push(v);
  return ok(vmJSON(v));
}

function vmRoute(s: State, m: string, v: VMRec, action: string, q: URLSearchParams, body: unknown, now: number): DemoResponse {
  if (!action && m === 'GET') return ok(vmJSON(v));
  if (!action && m === 'PATCH') {
    v.description = String((body as { description?: string })?.description ?? '');
    return { status: 204 };
  }
  if (!action && m === 'DELETE') {
    const held = now - v.created;
    if (held < VM_MINIMUM_MS && q.get('force') !== 'true')
      return no(400, `minimum reservation time not met (${Math.floor((VM_MINIMUM_MS - held) / 60000) + 1} min left); pass force=true to delete anyway, the minimum charge is not refunded`);
    if (held < VM_MINIMUM_MS) s.balance -= (v.price * (VM_MINIMUM_MS - held)) / 3600_000; // the rest of the minimum is still charged
    s.vms = s.vms.filter((x) => x !== v);
    const h = hostOf(s, v.host);
    for (const i of v.slots) h.slots[i] = '';
    for (const o of s.offers) if (o.Specs.gpus[0].count === v.specs.gpus[0].count) o.Quantity++;
    return { status: 204 };
  }
  if (action === 'state' && m === 'GET') return ok({ state: v.powered ? 'running' : v.runningAt ? 'starting' : 'shut off', host: v.host });
  if (m === 'POST' && ['start', 'reboot', 'hard-reset'].includes(action)) {
    v.powered = false;
    v.runningAt = now + 3000;
    return { status: 204 };
  }
  if (m === 'POST' && (action === 'stop' || action === 'shutdown')) {
    v.powered = false;
    v.runningAt = 0;
    return { status: 204 };
  }
  if (m === 'POST' && action === 'rebuild') {
    v.status = 'rebuilding';
    v.powered = false;
    v.readyAt = v.runningAt = now + 20000;
    return { status: 202 };
  }
  return no(404, 'not found in sample data');
}

function reserve(s: State, now: number): DemoResponse {
  const h = s.hosts.find((x) => freeSlots(x) === 8);
  if (!h) return no(404, 'no bare metal server of that type is available');
  const price = 339 * 8;
  if (s.balance - 1000 < price * 8) return no(402, 'insufficient balance for the minimum reservation');
  s.nextPort++;
  const sv: ServerRec = {
    name: h.name,
    deployment_id: crypto.randomUUID(),
    description: '',
    ip_address: `10.20.9.${10 + s.metal.length}`,
    ssh_access: { ip_address: '198.51.100.18', port: s.nextPort },
    price,
    created: now,
    installAt: now,
    off: false,
  };
  h.slots = h.slots.map(() => sv.name);
  s.metal.push(sv);
  return ok(metalJSON(sv, now), 201);
}

function metalRoute(s: State, m: string, sv: ServerRec, action: string, q: URLSearchParams, body: unknown, now: number): DemoResponse {
  if (!action && m === 'GET') return ok(metalJSON(sv, now));
  if (!action && m === 'PATCH') {
    sv.description = String((body as { description?: string })?.description ?? '');
    return { status: 204 };
  }
  if (!action && m === 'DELETE') {
    const held = now - sv.created;
    if (held < METAL_MINIMUM_MS && q.get('force') !== 'true')
      return no(400, `minimum reservation time not met (${Math.floor((METAL_MINIMUM_MS - held) / 60000) + 1} min left); pass force=true to release anyway, the minimum charge is not refunded`);
    if (held < METAL_MINIMUM_MS) s.balance -= (sv.price * (METAL_MINIMUM_MS - held)) / 3600_000;
    s.metal = s.metal.filter((x) => x !== sv);
    const h = hostOf(s, sv.name);
    h.slots = h.slots.map(() => '');
    return { status: 204 };
  }
  if (action === 'power' && m === 'GET') return ok({ state: sv.off ? 'Off' : 'On' });
  if (action.startsWith('power/') && m === 'POST') {
    sv.off = action === 'power/graceful_shutdown' || action === 'power/force_shutdown';
    return { status: 204 };
  }
  if (action === 'reinstall' && m === 'POST') {
    sv.installAt = now;
    sv.off = false;
    return { status: 202 };
  }
  return no(404, 'not found in sample data');
}

/** Forgets the sample data (Settings, or leaving sample data). */
export function resetDemo() {
  state = undefined;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
