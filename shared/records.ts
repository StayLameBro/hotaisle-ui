// What the app remembers about machines that the Hot Aisle API doesn't keep: when each was launched, with
// which image and at what price, when to end it automatically, and a short history of machines that have
// ended (how long they ran and about what they cost).
//
// Plain data and pure functions, so the same logic runs in the Worker's per-account Durable Object and in the
// browser for sample data.

export type Machine = {
  team: string;
  name: string;
  launched_at?: string;
  image?: string;
  price_cents?: number;
  release_at?: string;
  last_error?: string;
  /** The size as people say it ("4× MI300X"), kept for the history when auto-end ends it. */
  gpus?: string;
  /** A bare-metal server, ended through its own endpoint. */
  metal?: boolean;
};

export type Ended = {
  team: string;
  name: string;
  gpus: string;
  ran_ms?: number;
  cents?: number;
  minimum_applied?: boolean;
  ended_at: string;
  started_at?: string;
  server?: string;
  image?: string;
  price_cents?: number;
  note?: string;
  metal?: boolean;
  cpu_cores?: number;
  ram_capacity?: number;
  disk_capacity?: number;
  ended_by?: 'you' | 'auto-end';
};

export type RecordsState = { machines: Record<string, Machine>; history: Ended[] };

/** What the app sends to record a launch or set a timer. release_in_minutes: >0 sets, 0 clears, absent leaves. */
export type MachineUpdate = {
  team: string;
  name: string;
  launched?: boolean;
  image?: string;
  price_cents?: number;
  release_in_minutes?: number;
  gpus?: string;
  metal?: boolean;
};

/** How many ended machines are kept per team. */
export const HISTORY_LIMIT = 20;
/** Records of machines launched this recently are kept whatever a machine list says (it may predate them). */
export const PRUNE_GRACE_MS = 5 * 60_000;
/** Minimum billed time: 30 minutes for a virtual machine, 8 hours for bare metal. */
export const minimumMs = (metal?: boolean) => (metal ? 8 * 3600_000 : 30 * 60_000);

const key = (team: string, name: string) => `${team}/${name}`;

export const emptyRecords = (): RecordsState => ({ machines: {}, history: [] });

export function listMachines(s: RecordsState, team: string): Machine[] {
  return Object.values(s.machines)
    .filter((m) => m.team === team)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Validates an update; returns an error message, or nothing. */
export function checkUpdate(u: Partial<MachineUpdate>): string | undefined {
  if (!u || typeof u.team !== 'string' || !u.team || typeof u.name !== 'string' || !u.name) return 'body must name the team and the machine';
  if (u.release_in_minutes != null && (!Number.isFinite(u.release_in_minutes) || u.release_in_minutes < 0 || u.release_in_minutes > 60 * 24 * 14))
    return 'release_in_minutes must be between 0 and 20160';
  return undefined;
}

export function updateMachine(s: RecordsState, u: MachineUpdate, now = Date.now()): Machine {
  const k = key(u.team, u.name);
  const m: Machine = s.machines[k] ?? { team: u.team, name: u.name };
  if (u.launched && !m.launched_at) m.launched_at = new Date(now).toISOString();
  if (u.image) m.image = u.image;
  if (u.price_cents && u.price_cents > 0) m.price_cents = Math.round(u.price_cents);
  if (u.gpus) m.gpus = u.gpus;
  if (u.metal) m.metal = true;
  if (u.release_in_minutes != null) {
    if (u.release_in_minutes === 0) delete m.release_at;
    else m.release_at = new Date(now + u.release_in_minutes * 60_000).toISOString();
    delete m.last_error;
  }
  s.machines[k] = m;
  return m;
}

/** Forgets machines of a team that no longer exist, except ones launched in the last few minutes. */
export function pruneMachines(s: RecordsState, team: string, alive: string[], now = Date.now()): boolean {
  const keep = new Set(alive);
  let changed = false;
  for (const [k, m] of Object.entries(s.machines)) {
    if (m.launched_at && now - Date.parse(m.launched_at) < PRUNE_GRACE_MS) continue;
    if (m.team === team && !keep.has(m.name)) {
      delete s.machines[k];
      changed = true;
    }
  }
  return changed;
}

export function removeMachine(s: RecordsState, team: string, name: string) {
  delete s.machines[key(team, name)];
}

/** Machines whose auto-end time has come. */
export const dueMachines = (s: RecordsState, now = Date.now()) => Object.values(s.machines).filter((m) => m.release_at && Date.parse(m.release_at) <= now);

/** The next auto-end time, if any timer is set. */
export function nextRelease(s: RecordsState): number | undefined {
  const times = Object.values(s.machines)
    .filter((m) => m.release_at)
    .map((m) => Date.parse(m.release_at!));
  return times.length ? Math.min(...times) : undefined;
}

/** Records an ended machine, newest first, keeping HISTORY_LIMIT per team; the same machine twice replaces the first. */
export function addEnded(s: RecordsState, e: Ended) {
  const out = [e];
  let kept = 0;
  for (const h of s.history) {
    if (h.team === e.team && h.name === e.name) continue;
    if (h.team === e.team) {
      if (kept >= HISTORY_LIMIT - 1) continue;
      kept++;
    }
    out.push(h);
  }
  s.history = out;
}

export const historyOf = (s: RecordsState, team: string) => s.history.filter((h) => h.team === team);

/** The history entry for a machine auto-end just ended: run time, and its cost with the minimum applied. */
export function endedByTimer(m: Machine, now = Date.now()): Ended {
  const e: Ended = { team: m.team, name: m.name, gpus: m.gpus ?? '', ended_at: new Date(now).toISOString(), started_at: m.launched_at, image: m.image, price_cents: m.price_cents, metal: m.metal, ended_by: 'auto-end' };
  if (m.launched_at) {
    const ran = now - Date.parse(m.launched_at);
    let billed = ran;
    if (billed < minimumMs(m.metal)) {
      billed = minimumMs(m.metal);
      e.minimum_applied = true;
    }
    e.ran_ms = ran;
    if (m.price_cents) e.cents = (m.price_cents * billed) / 3600_000;
  }
  return e;
}

/** The API path that ends a machine. Bare metal goes through its own endpoint, with force: its minimum is charged either way. */
export function releasePath(team: string, name: string, metal?: boolean) {
  const t = `/teams/${encodeURIComponent(team)}`;
  return metal ? `${t}/bare_metal/${encodeURIComponent(name)}/?force=true` : `${t}/virtual_machines/${encodeURIComponent(name)}/`;
}

/**
 * Ends every machine whose time has come, through `release` (which calls the API and returns its status), and
 * records each in the history. A machine already gone (404) is just forgotten. Any other failure keeps the
 * timer, retries in a minute, and shows why on the machine. Never treats a failure as success.
 */
export async function fireTimers(s: RecordsState, release: (path: string) => Promise<{ status: number; message: string }>, now = Date.now()) {
  for (const m of dueMachines(s, now)) {
    let r: { status: number; message: string };
    try {
      r = await release(releasePath(m.team, m.name, m.metal));
    } catch (e) {
      r = { status: 0, message: (e as Error).message };
    }
    if (r.status === 200 || r.status === 202 || r.status === 204) {
      addEnded(s, endedByTimer(m, now));
      removeMachine(s, m.team, m.name);
    } else if (r.status === 404) {
      removeMachine(s, m.team, m.name);
    } else {
      m.release_at = new Date(now + 60_000).toISOString();
      m.last_error = `Auto-end didn't work (${r.status || 'no answer'}: ${r.message.slice(0, 200)}). Trying again every minute.`;
    }
  }
}
