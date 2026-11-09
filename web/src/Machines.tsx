import { useEffect, useRef, useState } from 'react';
import { api, APIError, type Ended, type MachineRecord, type Team, type VM, type VMState } from './api';
import { duration, gb, hoursOr, money, sshCommand, sshURL } from './format';
import { Lcd } from './Lcd';
import { vtName } from './motion';
import { IMAGES, RELEASE_CHOICES } from './prefs';
import { sound } from './sound';
import type { StageMode } from './Stage';
import { CopyButton, HoldButton, useToast } from './ui';

export type Phase = 'building' | 'starting' | 'running' | 'off' | 'paused' | 'unavailable' | 'releasing' | 'unknown';

export function phaseOf(vm: VM, st?: VMState, releasing?: boolean): Phase {
  if (releasing) return 'releasing';
  if (vm.status === 'rebuild_queued' || vm.status === 'rebuilding') return 'building';
  if (vm.status === 'unavailable') return 'unavailable';
  const s = st?.state?.toLowerCase();
  if (!s) return 'unknown';
  if (s === 'running') return 'running';
  if (s === 'installing') return 'building';
  if (s === 'failed') return 'unavailable';
  if (s.includes('shut') || s === 'stopped' || s === 'off') return 'off';
  if (s === 'paused') return 'paused';
  return 'starting';
}

export const stageModeOf = (p: Phase): StageMode =>
  p === 'running' ? 'ready' : p === 'off' || p === 'paused' || p === 'unavailable' ? 'off' : p === 'releasing' ? 'ended' : 'booting';

const HEAD: Record<Phase, [string, string]> = {
  building: ['Setting up', 'Running your cloud-init file. This takes a few minutes.'],
  starting: ['Booting', 'Warming up. Usually under a minute.'],
  unknown: ['Booting', 'Warming up. Usually under a minute.'],
  running: ['Ready', 'Copy the command below to log in.'],
  off: ['Powered off', 'Still yours, and still billed, until you end it.'],
  paused: ['Paused', 'Still billed until you end it.'],
  unavailable: ['Unavailable', "Hot Aisle can't reach this machine right now."],
  releasing: ['Ending', 'Billing stops in a moment.'],
};

export const settled = (p: Phase) => p === 'running' || p === 'off' || p === 'unavailable';

/** Re-render every `ms`. */
export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** 1:12:05, or 4:07 under an hour. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
};
/** For the LCD meters: always H:MM:SS, so the digits never shift as time passes. */
const meter = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${String(h).padStart(1, ' ')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};
/** Dollars on an LCD: a fixed six places, unlit digits in front, like a taxi meter. */
export const dollars = (cents?: number) => (cents == null ? '  -.--' : (cents / 100).toFixed(2).padStart(6, ' '));
const at = (t: string | number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (t: string | number) => {
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return at(t);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** The GPUs of a machine as small squares that warm up with it, the same heat as the drawing. */
export function Chips({ n, mode }: { n: number; mode: StageMode | 'none' }) {
  return (
    <span className={`chips c-${mode}`} aria-hidden="true">
      {Array.from({ length: Math.max(1, Math.min(8, n)) }, (_, i) => (
        <i key={i} style={{ ['--i' as string]: i }} />
      ))}
    </span>
  );
}

type TripProps = {
  team: Team;
  vm: VM;
  state?: VMState;
  record?: MachineRecord;
  price?: number;
  minimumMin: number;
  host?: string;
  expanded: boolean;
  morph: boolean;
  onFocus: () => void;
  onChanged: () => void;
  onEnded: (e: Ended) => void;
  onRecord: (p: { release_in_minutes: number }) => Promise<void>;
};

export function Trip(props: TripProps) {
  const { team, vm, state, record, price, minimumMin, host: server, expanded, morph, onFocus, onChanged, onEnded, onRecord } = props;
  const toast = useToast();
  const [ending, setEnding] = useState(false);
  const [panel, setPanel] = useState<null | 'end' | 'rebuild' | 'timer'>(null);
  const [menu, setMenu] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(vm.description ?? '');
  const [editing, setEditing] = useState(false);
  const phase = phaseOf(vm, state, ending);
  const prev = useRef<Phase>(phase);
  const menuRef = useRef<HTMLDivElement>(null);
  const now = useNow(1000);
  const launched = record?.launched_at ? new Date(record.launched_at).getTime() : undefined;
  const g = vm.gpus?.[0];
  const gpus = g ? `${g.count}× ${g.model ?? 'GPU'}` : '';
  const underMin = launched != null && now - launched < minimumMin * 60000;
  const minCost = price ? money((price * minimumMin) / 60) : '';

  useEffect(() => {
    if (prev.current !== 'running' && phase === 'running' && prev.current !== 'unknown') sound.chime();
    prev.current = phase;
  }, [phase]);
  useEffect(() => setNote(vm.description ?? ''), [vm.description]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // this Escape closed the menu; it doesn't also go back
      setMenu(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);
  useEffect(() => {
    if (!expanded) setPanel(null);
  }, [expanded]);

  const act = async (label: string, fn: () => Promise<void>, ok: string) => {
    setMenu(false);
    setBusy(label);
    try {
      await fn();
      toast(ok);
      onChanged();
    } catch (e) {
      toast(`${label} didn't work. ${(e as Error).message}`, 'err');
    } finally {
      setBusy('');
    }
  };

  const end = async (forced: boolean) => {
    setBusy('End');
    try {
      await api.release(team.handle, vm.name, forced);
      setEnding(true);
      const ran = launched ? Date.now() - launched : undefined;
      const billedMs = ran != null ? Math.max(ran, minimumMin * 60000) : undefined;
      window.setTimeout(
        () =>
          onEnded({
            team: team.handle,
            name: vm.name,
            gpus,
            ran_ms: ran,
            started_at: record?.launched_at,
            server: server && server !== vm.name ? server : vm.metal ? vm.name : server,
            image: record?.image,
            price_cents: price,
            note: vm.description || undefined,
            metal: vm.metal,
            cpu_cores: vm.cpu_cores,
            ram_capacity: vm.ram_capacity,
            disk_capacity: vm.disk_capacity,
            ended_by: 'you',
            cents: billedMs != null && price ? (price * billedMs) / 3600_000 : undefined,
            minimum_applied: ran != null && ran < minimumMin * 60000,
            ended_at: new Date().toISOString(),
          }),
        250,
      );
    } catch (e) {
      const err = e as APIError;
      if (!forced && err.status >= 400 && err.status < 500 && /minimum|reservation/i.test(err.message)) setForce(true);
      else toast(`Couldn't end it. ${err.message}`, 'err');
    } finally {
      setBusy('');
    }
  };

  const setTimer = async (min: number) => {
    try {
      await onRecord({ release_in_minutes: min });
      setPanel(null);
    } catch (e) {
      toast(`Couldn't set auto-end. ${(e as Error).message}`, 'err');
    }
  };

  const copy = async (text: string, what: string) => {
    setMenu(false);
    try {
      await navigator.clipboard.writeText(text);
      sound.tick();
      toast(`Copied ${what}.`);
    } catch {
      window.prompt(`Copy ${what}:`, text);
    }
  };

  const saveNote = async () => {
    setEditing(false);
    if (note === (vm.description ?? '')) return;
    try {
      await api.describe(team.handle, vm.name, note);
      onChanged();
    } catch (e) {
      toast(`Couldn't save the note. ${(e as Error).message}`, 'err');
      setNote(vm.description ?? '');
    }
  };

  const ssh = vm.ssh_access;
  const ready = phase === 'running';
  const host = ssh ? ssh.dns_name || ssh.ip_address : '';
  const cloudInit = phase === 'building' || record?.image === 'vllm' || record?.image === 'custom';
  // a bare-metal server installs its operating system before its first boot
  const install = state?.install;
  const metalStep = !install ? 0 : ['booting_installer', 'installing_os', 'finalizing_os'].includes(install) ? 1 : ['first_boot', 'first_boot_tasks'].includes(install) ? 2 : install === 'installed' ? 3 : 0;
  const steps = vm.metal ? ['Assigned', 'Installing', 'First boot', 'Ready'] : cloudInit ? ['Assigned', 'Setting up', 'Booting', 'Ready'] : ['Assigned', 'Booting', 'Ready'];
  const current = ready ? steps.length : vm.metal ? metalStep : phase === 'building' ? 1 : steps.indexOf('Booting');
  const [head, sub] = vm.metal && phase === 'building' ? (['Installing', 'Hot Aisle is installing the operating system on your server. This takes a while.'] as const) : HEAD[phase];
  const ranMs = launched ? now - launched : undefined;
  const mode = stageModeOf(phase);
  const style = { ['--vt' as string]: morph ? 'launcher' : vtName('vm', vm.name) };

  if (!expanded)
    return (
      <button className="trip-row vt" style={style} onClick={onFocus} aria-label={`${vm.name}: ${head}. Show details`}>
        <Chips n={g?.count ?? 1} mode={mode} />
        <span className="tr-main">
          <b>{head}</b>
          <span className="mono">
            {vm.name}
            {vm.metal ? <span className="on-host">, the whole server</span> : server ? <span className="on-host"> on {server}</span> : null}
          </span>
        </span>
        <span className="tr-end">{ready && ranMs != null && price != null ? `${clock(ranMs)}, ${money((price * ranMs) / 3600_000)}` : gpus}</span>
      </button>
    );

  // Each panel's own share of the boot: the current step fills toward the next as time passes.
  const stepFill = ranMs != null ? 1 - Math.exp(-ranMs / 1000 / 22) : 0.3;

  return (
    <article className={`trip vt p-${phase}`} aria-label={`${vm.name}: ${head}`} style={style}>
      <div className="card-head">
        <div className="card-title">
          <h3>
            <Chips n={g?.count ?? 1} mode={mode} />
            {busy && busy !== 'End' ? `${busy}…` : head}
          </h3>
          {record?.last_error ? (
            <p>{record.last_error}</p>
          ) : ready ? (
            <p className="sub-act">
              <span>{record?.release_at ? `Ends on its own at ${at(record.release_at)}.` : sub}</span>
              <button className="btn-text" onClick={() => setPanel('timer')}>
                {record?.release_at ? 'Change' : 'Set auto-end'}
              </button>
            </p>
          ) : (
            <p>{sub}</p>
          )}
        </div>
        <div className="card-what">
          <b>{gpus}</b>
          {price != null && <span>{money(price)}/hr</span>}
        </div>
      </div>

      <div className="inst">
        <div className="meter-cell">
          <span className="meter-l">{ready ? 'Running' : 'Elapsed'}</span>
          <span className="meter-v">
            <Lcd className="md" value={meter(ranMs ?? 0)} still label={`${ready ? 'running for' : 'elapsed'} ${duration(ranMs ?? 0)}`} />
          </span>
        </div>
        {ready ? (
          <>
            <div className="meter-cell in">
              <span className="meter-l">So far</span>
              <span className="meter-v">
                <span className="cur">$</span>
                <Lcd className="md" value={dollars(price != null && ranMs != null ? (price * ranMs) / 3600_000 : undefined)} still label={price != null && ranMs != null ? `about ${money((price * ranMs) / 3600_000)} so far` : 'cost unknown'} />
              </span>
            </div>
          </>
        ) : (
          <ol className={`track ${steps.length > 3 ? 'many' : ''}`} style={{ ['--n' as string]: steps.length }} aria-label={`Step ${Math.min(current + 1, steps.length)} of ${steps.length}: ${steps[Math.min(current, steps.length - 1)]}`}>
            {steps.map((s, i) => (
              <li key={s} className={i < current ? 'done' : i === current ? 'now' : ''} style={i === current ? { ['--f' as string]: stepFill } : undefined}>
                <span className="bar" />
                <span className="lbl">{s}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className={`ssh lcd-panel ${ready ? 'ready' : ''}`}>
        {ssh ? <code>{sshCommand(ssh)}</code> : <span className="ssh-wait">The login command appears here.</span>}
        {ssh && <CopyButton text={sshCommand(ssh)} />}
      </div>

      <div className="run">
        <Timeline start={launched} end={record?.release_at ? Date.parse(record.release_at) : undefined} now={now} endLabel={record?.release_at ? `Ends ${at(record.release_at)}` : 'No auto-end'} />
        <Facts
          rows={[
            ['Server', server ? (vm.metal ? `${server}, the whole server` : server) : 'Being assigned'],
            ['Address', ssh ? `${host}, port ${ssh.port}` : 'Once it is assigned'],
            ['Image', IMAGES[(record?.image ?? 'standard') as keyof typeof IMAGES]?.name ?? (record?.image || 'Standard image')],
            ['Machine', machineLine(vm.cpu_cores, vm.ram_capacity, vm.disk_capacity)],
          ]}
        />
      </div>

      <div className="card-foot">
        {editing ? (
          <input
            className="note-in"
            autoFocus
            value={note}
            maxLength={200}
            placeholder="What is this machine for?"
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setNote(vm.description ?? '');
                setEditing(false);
              }
            }}
            aria-label="Note"
          />
        ) : (
          <span className="card-name">
            <span className="mono" title={server ? `Runs on server ${server}` : undefined}>
              {vm.name}
            </span>
            {note && (
              <button className="note" onClick={() => setEditing(true)} title="Edit note">
                {note}
              </button>
            )}
          </span>
        )}
        {phase === 'off' && (
          <button className="btn" disabled={!!busy} onClick={() => act('Powering on', () => api.power(team.handle, vm.name, 'start'), `${vm.name} is powering on.`)}>
            Power on
          </button>
        )}
        {ssh && phase !== 'off' && (
          <a className="btn" href={sshURL(ssh)} title="Opens your SSH app, Terminal on macOS">
            Open in Terminal
          </a>
        )}
        <div className="menu-wrap" ref={menuRef}>
          <button className="btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            More
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => { setMenu(false); setPanel('timer'); }}>
                {record?.release_at ? 'Change auto-end' : 'Set auto-end'}
              </button>
              {ssh && (
                <button role="menuitem" onClick={() => void copy(`Host ${vm.name}\n  HostName ${host}\n  Port ${ssh.port}\n  User hotaisle\n`, 'the SSH config entry')}>
                  Copy SSH config entry
                </button>
              )}
              {ssh && record?.image === 'vllm' && (
                <button role="menuitem" onClick={() => void copy(`ssh -N -L 8000:127.0.0.1:8000 -p ${ssh.port} hotaisle@${host}`, 'the vLLM port forward')}>
                  Copy vLLM port forward
                </button>
              )}
              <button role="menuitem" onClick={() => { setMenu(false); setEditing(true); }}>
                {note ? 'Edit note' : 'Add a note'}
              </button>
              <span className="menu-sep" />
              {phase !== 'off' && (
                <>
                  <button role="menuitem" disabled={phase === 'building'} onClick={() => act('Restarting', () => api.power(team.handle, vm.name, 'reboot'), `${vm.name} is restarting.`)}>
                    Restart
                  </button>
                  <button role="menuitem" disabled={phase === 'building'} onClick={() => act('Shutting down', () => api.power(team.handle, vm.name, 'shutdown'), `${vm.name} is shutting down. It stays yours, and billed, until you end it.`)}>
                    Shut down
                  </button>
                </>
              )}
              <button role="menuitem" className="danger" onClick={() => { setMenu(false); setPanel('rebuild'); }}>
                {vm.metal ? 'Reinstall from scratch…' : 'Rebuild from scratch…'}
              </button>
            </div>
          )}
        </div>
        <button className="btn end" disabled={!!busy} onClick={() => { setPanel(panel === 'end' ? null : 'end'); setForce(false); }}>
          End
        </button>
      </div>

      {panel && (
        <div className="sheet" key={panel} role="dialog" aria-label={panel === 'end' ? 'End this machine' : panel === 'timer' ? 'Auto-end' : 'Rebuild'}>
          {panel === 'timer' && (
            <>
              <p className="sheet-t">End {vm.name} automatically</p>
              <div className="choice" role="radiogroup" aria-label="End after">
                {RELEASE_CHOICES.map((c) => (
                  <button key={c.min} role="radio" aria-checked={false} onClick={() => { sound.tick(); void setTimer(c.min); }}>
                    {c.min ? `In ${c.label}` : 'Never'}
                  </button>
                ))}
              </div>
              <p className="muted small">Counted from now. Its disk is wiped when it ends. This app needs to be running.</p>
            </>
          )}
          {panel === 'end' && (
            <>
              <p className="sheet-t">End {vm.name}?</p>
              <p className="muted small">
                {force || underMin
                  ? `Its disk is wiped. ${vm.metal ? 'A server is' : 'Machines are'} billed for at least ${hoursOr(minimumMin)}, so ending now costs ${minCost ? `${minCost} in total` : `the full ${hoursOr(minimumMin)}`}.`
                  : 'Billing stops and its disk is wiped.'}
              </p>
              <HoldButton tone="danger" label={force ? 'Hold to end anyway' : 'Hold to end'} busyLabel="Ending" busy={busy === 'End'} onConfirm={() => end(force || underMin)} />
            </>
          )}
          {panel === 'rebuild' && (
            <>
              <p className="sheet-t">{vm.metal ? 'Reinstall the operating system?' : 'Rebuild from a fresh image?'}</p>
              <p className="muted small">Everything on its {vm.metal ? 'disks' : 'disk'} is deleted. You keep the {vm.metal ? 'server' : 'machine'} and its address.</p>
              <HoldButton
                tone="danger"
                label="Hold to rebuild"
                busyLabel="Rebuilding"
                busy={busy === 'Rebuilding'}
                onConfirm={() => {
                  setPanel(null);
                  void act('Rebuilding', () => api.rebuild(team.handle, vm.name), `${vm.name} is rebuilding.`);
                }}
              />
            </>
          )}
          <button className="btn-text sheet-x" onClick={() => setPanel(null)}>
            {panel === 'end' ? 'Keep it running' : 'Cancel'}
          </button>
        </div>
      )}
    </article>
  );
}

/** What you get when a trip ends: how long it ran and what it cost. Same frame as the card it replaces. */
export function ReceiptCard({ r, onDone }: { r: Ended; onDone?: () => void }) {
  return (
    <article className="trip receipt vt" style={{ ['--vt' as string]: vtName('vm', r.name) }} aria-label={`${r.name} ended`}>
      <div className="card-head">
        <div className="card-title">
          <h3>
            <Chips n={Number(r.gpus.split('×')[0]) || 1} mode="ended" />
            Ended
          </h3>
          <p>Billing stopped at {at(r.ended_at)}.</p>
        </div>
        <div className="card-what">
          <b>{r.gpus}</b>
        </div>
      </div>
      <div className="inst">
        <div className="meter-cell">
          <span className="meter-l">Ran for</span>
          <span className="meter-v">
            <Lcd className="md" value={meter(r.ran_ms ?? 0)} still label={r.ran_ms != null ? duration(r.ran_ms) : 'unknown'} />
          </span>
        </div>
        <div className="meter-cell">
          <span className="meter-l">Total, about</span>
          <span className="meter-v">
            <span className="cur">$</span>
            <Lcd className="md" value={dollars(r.cents)} still label={r.cents != null ? money(r.cents) : 'unknown'} />
          </span>
        </div>
      </div>
      <div className="summary">{r.minimum_applied ? 'Includes the minimum charge.' : r.cents != null ? 'Billed by the minute.' : 'Launched outside this app, so the run time and cost are unknown.'}</div>
      <div className="run">
        <Timeline start={r.started_at ? Date.parse(r.started_at) : undefined} end={Date.parse(r.ended_at)} now={Date.parse(r.ended_at)} endLabel={`Ended ${at(r.ended_at)}`} />
        <Facts rows={runFacts(r)} />
      </div>
      <div className="card-foot">
        <span className="card-name">
          <span className="mono">{r.name}</span>
        </span>
        {onDone && (
          <button className="btn" onClick={onDone}>
            Done
          </button>
        )}
      </div>
    </article>
  );
}

/** A run from start to finish: when it began, how far along it is, and when it ends (auto-end) or ended. */
function Timeline({ start, end, now, endLabel }: { start?: number; end?: number; now: number; endLabel: string }) {
  if (!start) return null;
  const f = end && end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
  return (
    <div className="tl">
      <div className={`tl-bar ${end ? '' : 'open'}`}>
        <span style={{ ['--f' as string]: f }} />
      </div>
      <div className="tl-l">
        <span>Launched {at(start)}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd title={v}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const machineLine = (cores?: number, ram?: number, disk?: number) => (cores ? `${cores} cores, ${gb(ram ?? 0)} memory, ${gb(disk ?? 0)} disk` : '–');

/** What an ended run was: where it ran, on what, at what rate, and how it ended. */
export function runFacts(r: Ended): [string, string][] {
  return [
    ['Server', r.server ? (r.metal ? `${r.server}, the whole server` : r.server) : '–'],
    ['Image', r.image ? (IMAGES[r.image as keyof typeof IMAGES]?.name ?? r.image) : '–'],
    ['Rate', r.price_cents ? `${money(r.price_cents)} an hour` : '–'],
    // what was billed: the run, or the minimum if it ended inside it; and what each GPU cost
    ...(r.cents != null && r.price_cents ? ([['Billed', `${duration((r.cents / r.price_cents) * 3600_000)}${r.minimum_applied ? ', the minimum' : ''}`]] as [string, string][]) : []),
    ...(r.cents != null ? ([['Per GPU', money(r.cents / (Number(r.gpus.split('×')[0]) || 1))]] as [string, string][]) : []),
    ['Machine', machineLine(r.cpu_cores, r.ram_capacity, r.disk_capacity)],
    ['Ended', r.ended_by === 'auto-end' ? `On its own, by auto-end, ${day(r.ended_at)}` : `By you, ${day(r.ended_at)}`],
    ...(r.note ? ([['Note', r.note]] as [string, string][]) : []),
  ];
}

/** Earlier machines, newest first. */
export function History({ items, onOpen }: { items: Ended[]; onOpen?: (e: Ended) => void }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 4);
  return (
    <section className="group earlier" aria-label="Earlier machines">
      <h2 className="group-h">Earlier</h2>
      <ul className="rows">
        {shown.map((e) => (
          <li key={e.name + e.ended_at} className="vt" style={{ ['--vt' as string]: vtName('vm', e.name) }}>
            <button className="row-item hist act" onClick={() => onOpen?.(e)} aria-label={`${e.name}, ${e.gpus}: see this run`}>
              <span className="mono">{e.name}</span>
              <span className="muted">{e.gpus}</span>
              <span className="muted num">{e.ran_ms != null ? clock(e.ran_ms) : '–'}</span>
              <span className="num">{e.cents != null ? money(e.cents) : '–'}</span>
              <span className="muted when">{day(e.ended_at)}</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > 4 && (
        <button className="btn-text more" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}
