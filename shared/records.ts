// What the app remembers about machines that the Hot Aisle API doesn't keep: when each was launched, with
// which image and at what price, and a short history of machines that have ended (how long they ran and about
// what they cost).
//
// There is no auto-end. Hot Aisle's API can't schedule a shutdown, and an app-side timer could miss one and
// leave a machine billing, so the app never promises to end a machine on its own.
//
// Plain data and pure functions, so the same logic runs in the Worker's per-account Durable Object and in the
// browser for sample data.

export type Machine = {
  team: string;
  name: string;
  launched_at?: string;
  image?: string;
  price_cents?: number;
  /** The size as people say it ("4× MI300X"). */
  gpus?: string;
  /** A bare-metal server. */
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
  ended_by?: 'you';
};

export type RecordsState = { machines: Record<string, Machine>; history: Ended[] };

/** What the app sends to record a launch. */
export type MachineUpdate = {
  team: string;
  name: string;
  launched?: boolean;
  image?: string;
  price_cents?: number;
  gpus?: string;
  metal?: boolean;
};

/** How many ended machines are kept per team. */
export const HISTORY_LIMIT = 20;
/** Records of machines launched this recently are kept whatever a machine list says (it may predate them). */
export const PRUNE_GRACE_MS = 5 * 60_000;

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
