// Typed calls to the Hot Aisle API, through the local hotaisle-ui server (which adds the token).
// Shapes follow https://admin.hotaisle.app/api/docs/swagger.json

export type GPU = { count: number; manufacturer?: string; model?: string };
export type Specs = {
  cpu_cores: number;
  ram_capacity: number;
  disk_capacity: number;
  gpus?: GPU[];
  cpus?: { count?: number; manufacturer?: string; model?: string; cores?: number; frequency?: number };
};
export type Offer = {
  Quantity: number;
  MinimumReservationMinutes: number;
  OnDemandPrice?: number; // US cents per hour
  Specs: Specs;
  /** A whole server, reserved as bare metal, rather than a virtual machine. */
  metal?: boolean;
  /** Bare metal is reserved by its full spec, as the API listed it. */
  rawSpecs?: unknown;
};
/** Where a bare-metal server is in its install, as the API reports it. */
export type InstallStage = 'shutting_down' | 'ac_reset' | 'bios_reset' | 'booting_installer' | 'installing_os' | 'finalizing_os' | 'first_boot' | 'first_boot_tasks' | 'installed' | 'failed';
export type SSHAccess = { ip_address: string; port: number; dns_name?: string };
export type VMStatus = 'ready' | 'rebuild_queued' | 'rebuilding' | 'unavailable';
export type VM = Specs & {
  name: string;
  deployment_id: string;
  description?: string;
  ip_address: string;
  status: VMStatus;
  ssh_access?: SSHAccess;
  /** A bare-metal server: the whole machine, eight GPUs. */
  metal?: boolean;
};
export type VMState = { state: string; host: string; install?: InstallStage };
export type Team = {
  handle: string;
  name: string;
  description?: string;
  maximum_virtual_machines?: number;
  roles: string[];
  effective_roles: string[];
  invitation?: boolean;
};
export type User = { name: string; email: string; created: string; email_auth_enabled: boolean };
export type Balance = {
  available_balance: number; // cents
  hourly_rate: number; // cents per hour
  estimated_runout_time?: string;
  minimum_balance?: number;
  virtual_machine_count: number;
  bare_metal_server_count: number;
};
export type SSHKey = { type: string; public_key: string; fingerprint: string; comment?: string };
/** Who is signed in, as the Worker sees it, and whether this tab is showing sample data. */
export type Status = {
  signed_in: boolean;
  kind?: 'key' | 'email' | 'passkey';
  /** An email sign-in waiting for its link to be opened. */
  waiting_for_email?: { email: string; expires_at: string };
  /** Email sign-in is available (Hot Aisle's API must publish it, and the Worker be told its paths). */
  email_login: boolean;
  passkeys: boolean;
  version: string;
  /** This tab is showing sample data: everything happens in the browser, nothing is billed. */
  demo: boolean;
};

/** What this app remembers about a machine (the API doesn't keep its launch time, image or price). */
export type MachineRecord = {
  team: string;
  name: string;
  launched_at?: string;
  image?: string;
  price_cents?: number;
};

/** A machine that has ended, as this app saw it. Kept with the account (or in the tab, for sample data). */
export type Ended = {
  team: string;
  name: string;
  gpus: string;
  ran_ms?: number;
  cents?: number;
  minimum_applied?: boolean;
  ended_at: string;
  // what the run was, for looking back at it
  started_at?: string;
  server?: string;
  image?: string;
  price_cents?: number;
  note?: string;
  metal?: boolean;
  cpu_cores?: number;
  ram_capacity?: number;
  disk_capacity?: number;
  ended_by?: 'you';
};

export class APIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- sample data
// It runs in the browser (demo/api.ts) and is loaded only when used. It starts from ?demo in the address, or
// from "Look around with sample data", and lasts for the tab.
const DEMO_KEY = 'hotaisle-ui:demo';
let demo = (() => {
  try {
    if (new URLSearchParams(location.search).has('demo')) sessionStorage.setItem(DEMO_KEY, '1');
    return sessionStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return new URLSearchParams(location.search).has('demo');
  }
})();
export const isDemo = () => demo;
export async function setDemo(on: boolean) {
  demo = on;
  try {
    if (on) sessionStorage.setItem(DEMO_KEY, '1');
    else sessionStorage.removeItem(DEMO_KEY);
  } catch {
    /* lasts until reload */
  }
  if (!on) (await import('./demo/api')).resetDemo();
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (demo && !path.startsWith('/auth/')) {
    const { demoFetch } = await import('./demo/api');
    const r = await demoFetch(method, path, body);
    if (r.status >= 400) throw new APIError(r.status, r.text ?? 'error');
    return r.body as T;
  }
  const res = await fetch(path, {
    method,
    headers: {
      'X-Requested-With': 'hotaisle-ui',
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.trim();
    try {
      const j = JSON.parse(msg);
      msg = j.message || j.error || j.detail || msg;
    } catch {
      /* plain text, as the API usually sends */
    }
    throw new APIError(res.status, msg || res.statusText);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const t = (team: string) => `/api/teams/${encodeURIComponent(team)}`;

// Bare metal: Hot Aisle rents whole 8-GPU servers through its own endpoints. The app shows them as
// machines like any other, so the calls below look up which kind a name is and use the right endpoint.
type MetalSpecs = { cpu_cores?: number; ram_capacity?: number; disk_capacity?: number; gpus?: GPU[]; cpus?: { count?: number; manufacturer?: string; model?: string; cores?: number; frequency?: number }[] };
type Metal = MetalSpecs & { name: string; deployment_id?: string; description?: string; ip_address?: string; ssh_access?: SSHAccess; specs?: MetalSpecs; os_status?: { os_install_status?: InstallStage } };
const metalNames = new Set<string>();
const isMetal = (name: string) => metalNames.has(name);
const m = (team: string, name: string) => `${t(team)}/bare_metal/${encodeURIComponent(name)}`;
function specsOf(s: MetalSpecs = {}): Specs {
  const c = s.cpus ?? [];
  const sockets = c.reduce((n, x) => n + (x.count ?? 1), 0);
  return {
    cpu_cores: s.cpu_cores ?? 0,
    ram_capacity: s.ram_capacity ?? 0,
    disk_capacity: s.disk_capacity ?? 0,
    gpus: s.gpus?.length ? s.gpus : [{ count: 8, manufacturer: 'AMD', model: 'MI300X' }],
    cpus: c.length ? { count: sockets || c.length, manufacturer: c[0].manufacturer, model: c[0].model, cores: c[0].cores, frequency: c[0].frequency } : undefined,
  };
}
function metalVM(b: Metal): VM {
  metalNames.add(b.name);
  return { ...specsOf(b.specs ?? b), name: b.name, deployment_id: b.deployment_id ?? b.name, description: b.description, ip_address: b.ip_address ?? '', status: 'ready', ssh_access: b.ssh_access, metal: true };
}
const POWER: Record<string, string> = { start: 'power_on', shutdown: 'graceful_shutdown', stop: 'force_shutdown', reboot: 'warm_reboot', 'hard-reset': 'cold_reboot' };

export const api = {
  status: async (): Promise<Status> => {
    const s = await call<Omit<Status, 'demo'>>('GET', '/auth/status').catch((e) => {
      // sample data works without the backend (a static preview, say)
      if (demo) return { signed_in: false, email_login: false, passkeys: false, version: 'dev' };
      throw e;
    });
    return { ...s, demo };
  },
  /** Signs in with an API key; the Worker checks it with Hot Aisle and keeps it out of the page. */
  signInWithKey: (key: string) => call<{ user: User; teams: Team[] }>('POST', '/auth/key', { key }),
  /** Emails a sign-in link. */
  emailStart: (email: string) => call<{ email: string; expires_at: string }>('POST', '/auth/email/start', { email }),
  /** Whether the emailed link has been opened yet; once it has, the session is signed in. */
  emailWait: () => call<{ done: boolean; user?: User; teams?: Team[] }>('POST', '/auth/email/wait'),
  signOut: () => call<{ ok: boolean }>('POST', '/auth/signout'),
  records: (team: string) => call<MachineRecord[]>('GET', `/records/machines?team=${encodeURIComponent(team)}`),
  record: (body: { team: string; name: string; launched?: boolean; image?: string; price_cents?: number; gpus?: string; metal?: boolean }) =>
    call<MachineRecord>('POST', '/records/machines', body),
  prune: (team: string, names: string[]) => call<void>('POST', '/records/machines/prune', { team, names }),
  history: (team: string) => call<Ended[]>('GET', `/records/history?team=${encodeURIComponent(team)}`),
  addHistory: (e: Ended) => call<{ ok: boolean }>('POST', '/records/history', e),

  user: () => call<{ user: User; teams: Team[] }>('GET', '/api/user/'),
  teams: () => call<Team[]>('GET', '/api/teams/'),
  keys: () => call<SSHKey[]>('GET', '/api/user/ssh_keys/'),
  addKey: (authorized_key: string) => call<SSHKey>('POST', '/api/user/ssh_keys/', { authorized_key }),
  removeKey: (fingerprint: string) => call<void>('DELETE', `/api/user/ssh_keys/${encodeURIComponent(fingerprint)}/`),
  balance: (team: string) => call<Balance>('GET', `${t(team)}/balance/`),
  /** Sizes you can launch: virtual machines (1, 2 or 4 GPUs) and whole bare-metal servers (8). */
  offers: async (team: string) => {
    const [vms, metal] = await Promise.all([
      call<Offer[]>('GET', `${t(team)}/virtual_machines/available/`),
      call<(Offer & { Specs: MetalSpecs })[] | null>('GET', `${t(team)}/bare_metal/available/`).catch(() => null),
    ]);
    return [...(vms ?? []), ...(metal ?? []).map((o) => ({ ...o, Specs: specsOf(o.Specs), metal: true, rawSpecs: o.Specs }))];
  },
  /** Your machines: virtual machines and bare-metal servers, as one list. */
  vms: async (team: string) => {
    const [vms, metal] = await Promise.all([call<VM[] | null>('GET', `${t(team)}/virtual_machines/`), call<Metal[] | null>('GET', `${t(team)}/bare_metal/`).catch(() => null)]);
    return [...(vms ?? []), ...(metal ?? []).map(metalVM)];
  },
  vmState: async (team: string, vm: string): Promise<VMState> => {
    if (!isMetal(vm)) return call<VMState>('GET', `${t(team)}/virtual_machines/${encodeURIComponent(vm)}/state/`);
    // a bare-metal server is its own host; it is up once its operating system is installed
    const [d, power] = await Promise.all([call<Metal>('GET', `${m(team, vm)}/`), call<{ state: string }>('GET', `${m(team, vm)}/power/`).catch(() => undefined)]);
    const install = d.os_status?.os_install_status;
    const state = install && install !== 'installed' ? (install === 'failed' ? 'failed' : 'installing') : power?.state === 'Off' ? 'off' : 'running';
    return { state, host: vm, install };
  },
  provision: (team: string, gpus: GPU[], user_data_url?: string) =>
    call<VM>('POST', `${t(team)}/virtual_machines/`, { gpus, ...(user_data_url ? { user_data_url } : {}) }),
  /** Reserve a whole server. Billed for its minimum (8 hours) up front. */
  reserve: async (team: string, offer: Offer) => metalVM(await call<Metal>('POST', `${t(team)}/bare_metal/`, { specs: offer.rawSpecs })),
  describe: (team: string, vm: string, description: string) =>
    call<void>('PATCH', isMetal(vm) ? `${m(team, vm)}/` : `${t(team)}/virtual_machines/${encodeURIComponent(vm)}/`, { description }),
  power: (team: string, vm: string, action: 'start' | 'shutdown' | 'stop' | 'reboot' | 'hard-reset') =>
    call<void>('POST', isMetal(vm) ? `${m(team, vm)}/power/${POWER[action]}/` : `${t(team)}/virtual_machines/${encodeURIComponent(vm)}/${action}/`),
  rebuild: (team: string, vm: string, user_data_url?: string) =>
    isMetal(vm) ? call<void>('POST', `${m(team, vm)}/reinstall/`) : call<void>('POST', `${t(team)}/virtual_machines/${encodeURIComponent(vm)}/rebuild/`, user_data_url ? { user_data_url } : {}),
  release: (team: string, vm: string, force = false) =>
    call<void>('DELETE', `${isMetal(vm) ? m(team, vm) : `${t(team)}/virtual_machines/${encodeURIComponent(vm)}`}/${force ? '?force=true' : ''}`),
  buyCredits: (team: string, cents: number) =>
    call<{ checkout_url: string; expires_at: string; demo_credited?: boolean }>('POST', `${t(team)}/purchase-credits/`, { cents }),
};
