import type { GPU, SSHAccess, Specs } from './api';

export const money = (cents: number, digits = 2) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

export const perHour = (cents: number) => `${money(cents)}/h`;

const GiB = 2 ** 30;
export const gb = (bytes: number) => {
  // memory comes in binary units (2048 GiB is the "2 TB" on the spec sheet), disks in decimal ones
  if (bytes >= 1024 * GiB && bytes % GiB === 0) return `${+(bytes / (1024 * GiB)).toFixed(1)} TB`;
  if (bytes >= 1e12) return `${+(bytes / 1e12).toFixed(1)} TB`;
  return `${Math.round(bytes / GiB)} GB`;
};

// Per accelerator, from AMD's public spec sheets: memory (GB), memory type, peak bandwidth (TB/s), compute units.
const FACTS: Record<string, { mem: number; kind: string; bw: number; cu: number }> = {
  MI300X: { mem: 192, kind: 'HBM3', bw: 5.3, cu: 304 },
  MI325X: { mem: 256, kind: 'HBM3E', bw: 6, cu: 304 },
  MI350X: { mem: 288, kind: 'HBM3E', bw: 8, cu: 256 },
  MI355X: { mem: 288, kind: 'HBM3E', bw: 8, cu: 256 },
};
export const gpuFacts = (model?: string) => (model ? FACTS[model.toUpperCase()] : undefined);
export const hbm = (g?: GPU) => {
  const f = gpuFacts(g?.model);
  if (!f || !g) return '';
  const total = f.mem * g.count;
  return total >= 1024 ? `${+(total / 1024).toFixed(1)} TB ${f.kind}` : `${total} GB ${f.kind}`;
};

/** The spec sheet for a machine size: what the API says, plus the GPU's published numbers. */
export function specRows(s: Specs): [string, string][] {
  const g = s.gpus?.[0];
  const f = gpuFacts(g?.model);
  const rows: [string, string][] = [];
  if (g) rows.push(['GPUs', `${g.count}× ${g.manufacturer === 'AMD' || f ? 'AMD Instinct ' : ''}${g.model ?? 'GPU'}`]);
  if (g && f) {
    rows.push(['GPU memory', `${f.mem * g.count} GB ${f.kind}`]);
    rows.push(['Bandwidth', `${+(f.bw * g.count).toFixed(1)} TB/s`]);
    rows.push(['Compute units', (f.cu * g.count).toLocaleString('en-US')]);
  }
  if (s.cpu_cores) rows.push(['CPU', `${s.cpu_cores} cores${s.cpus?.model ? `, ${s.cpus.model}` : ''}`]);
  if (s.ram_capacity) rows.push(['Memory', gb(s.ram_capacity)]);
  if (s.disk_capacity) rows.push(['Disk', gb(s.disk_capacity)]);
  return rows;
}

export const gpuLabel = (s: Pick<Specs, 'gpus'>) => {
  const g = s.gpus?.[0];
  if (!g) return 'CPU only';
  return `${g.count}× ${g.model ?? 'GPU'}`;
};

export const gpuCount = (s: Pick<Specs, 'gpus'>) => s.gpus?.reduce((n, g) => n + g.count, 0) ?? 0;

export function duration(ms: number) {
  if (ms <= 0) return 'no time';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const u = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (d > 0) return h ? `${u(d, 'day')} ${u(h, 'hour')}` : u(d, 'day');
  if (h > 0) return mm ? `${u(h, 'hour')} ${u(mm, 'minute')}` : u(h, 'hour');
  return u(Math.max(mm, 1), 'minute');
}

export function sshCommand(a: SSHAccess, user = 'hotaisle') {
  const host = a.dns_name || a.ip_address;
  return `ssh -p ${a.port} ${user}@${host}`;
}

export function sshURL(a: SSHAccess, user = 'hotaisle') {
  const host = a.dns_name || (a.ip_address.includes(':') ? `[${a.ip_address}]` : a.ip_address);
  return `ssh://${user}@${host}:${a.port}`;
}

/** A name for an SSH key that never shows an email address (key comments often are one). */
export const keyLabel = (k: { comment?: string; type: string; fingerprint: string }) =>
  k.comment && !/\S+@\S+/.test(k.comment) ? k.comment : `${k.type.replace('ssh-', '')} ${k.fingerprint.replace('SHA256:', '').slice(0, 8)}`;

/** A minimum reservation, as people say it: "30 minutes", "8 hours". */
export const hoursOr = (min: number) => (min >= 60 && min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : `${min} minutes`);
