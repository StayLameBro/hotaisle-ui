import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Ended, type LocalStatus, type MachineRecord, type Team, type User, type VM, type VMState } from './api';
import { Connect } from './Connect';
import { duration, money, specRows } from './format';
import { ImageView, KeysView, OrderView, sizesOf, type LaunchMeta, type Order } from './Launch';
import { Lcd } from './Lcd';
import { dollars, History, phaseOf, ReceiptCard, settled, stageModeOf, Trip } from './Machines';
import { transition } from './motion';
import { applyTheme, usePrefs } from './prefs';
import { SettingsView } from './Settings';
import { signal } from './signal';
import { NEW, placeNew, Stage, type StageMachine, type StageState } from './Stage';
import { usePoll, useToast } from './ui';

export function App() {
  const toast = useToast();
  const [prefs] = usePrefs();
  const [status, setStatus] = useState<LocalStatus>();
  const [me, setMe] = useState<{ user: User; teams: Team[] }>();
  const [teamHandle, setTeamHandle] = useState<string>();
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => applyTheme(prefs.theme), [prefs.theme]);

  const boot = useCallback(async () => {
    setLoadErr('');
    try {
      const st = await api.status();
      setStatus(st);
      if (!st.connected && !st.demo) {
        setMe(undefined);
        return;
      }
      const u = await api.user();
      setMe(u);
      const teams = u.teams.filter((t) => !t.invitation);
      setTeamHandle(teams.find((t) => t.handle === st.default_team)?.handle ?? (teams.length === 1 ? teams[0].handle : undefined));
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, []);
  useEffect(() => void boot(), [boot]);

  const setDemo = async (on: boolean) => {
    await api.setDemo(on);
    setMe(undefined);
    setTeamHandle(undefined);
    await boot();
  };
  const pickTeam = async (h: string) => {
    setTeamHandle(h);
    if (!status?.demo) await api.saveTeam(h).catch(() => undefined);
  };

  if (loadErr)
    return (
      <main className="center">
        <div className="lone">
          <h1>Can't reach Hot Aisle</h1>
          <p className="lede">{loadErr}</p>
          <div className="row">
            <button className="btn primary" onClick={() => void boot()}>
              Try again
            </button>
            {!status?.demo && (
              <button className="btn" onClick={() => void setDemo(true)}>
                Use sample data
              </button>
            )}
          </div>
        </div>
      </main>
    );
  if (!status || ((status.connected || status.demo) && !me))
    return (
      <main className="center">
        <span className="loading" aria-label="Loading" />
      </main>
    );
  if (!status.connected && !status.demo)
    return (
      <Connect
        status={status}
        onConnected={() => {
          toast('Connected.');
          void boot();
        }}
        onDemo={() => void setDemo(true)}
      />
    );

  const teams = me!.teams.filter((t) => !t.invitation);
  const team = teams.find((t) => t.handle === teamHandle);
  if (!team)
    return (
      <main className="center">
        <div className="lone">
          <h1>Which team pays?</h1>
          <p className="lede">
            {teams.length ? 'Machines are billed to a team. You can change this later in Settings.' : "This API key isn't on a team yet. Create or join one with ssh admin.hotaisle.app."}
          </p>
          <div className="picklist">
            {teams.map((t) => (
              <button key={t.handle} className="pickrow" onClick={() => void pickTeam(t.handle)}>
                <span>{t.name}</span>
                <span className="mono hint">{t.handle}</span>
              </button>
            ))}
          </div>
        </div>
      </main>
    );

  return <Console key={team.handle + (status.demo ? ':demo' : '')} status={status} teams={teams} team={team} onTeam={pickTeam} onDemo={setDemo} />;
}


type View = 'home' | 'order' | 'settings' | 'credits' | 'keys' | 'image' | 'run';
type Nav = 'forward' | 'back' | 'none';

const chevronLeft = (
  <svg viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
    <path d="M7 1L1 7l6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const chevronRight = (
  <svg viewBox="0 0 6 10" width="6" height="10" aria-hidden="true">
    <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Console({
  status, teams, team, onTeam, onDemo,
}: {
  status: LocalStatus;
  teams: Team[];
  team: Team;
  onTeam: (h: string) => void;
  onDemo: (on: boolean) => Promise<void>;
}) {
  const h = team.handle;
  const toast = useToast();
  const [prefs] = usePrefs();
  const [fast, setFast] = useState(true);
  const vms = usePoll(() => api.vms(h), fast ? 3000 : 15000, 'vms' + h);
  const offers = usePoll(() => api.offers(h), 30000, 'offers' + h);
  const balance = usePoll(() => api.balance(h), fast ? 8000 : 20000, 'bal' + h);
  const keys = usePoll(() => api.keys(), null, 'keys');
  const records = usePoll(() => api.records(h), 20000, 'rec' + h);
  const history = usePoll(() => api.history(h), null, 'hist' + h);
  const [states, setStates] = useState<Record<string, VMState | undefined>>({});
  const [launchedNow, setLaunchedNow] = useState<string>();
  const [receipts, setReceipts] = useState<(Ended & { at: number })[]>([]);
  const [focus, setFocus] = useState<string>();
  const wasReady = useRef<Record<string, boolean>>({});
  const guessHost = useRef<Record<string, string>>({});
  const machinesRef = useRef<StageMachine[]>([]);
  const recByName: Record<string, MachineRecord | undefined> = Object.fromEntries((records.data ?? []).map((r) => [r.name, r]));
  const list = vms.data ?? [];

  // ---------------------------------------------------------------- the order, kept while you look at keys or settings
  const [order, setOrderState] = useState<Order>(() => ({ count: prefs.gpus, image: prefs.image, customURL: prefs.customURL, releaseAfter: prefs.releaseAfter }));
  const setOrder = useCallback((o: Partial<Order>) => setOrderState((s) => ({ ...s, ...o })), []);
  // an earlier run, opened from the history to look back at it
  const [run, setRun] = useState<Ended>();
  const openRun = (e: Ended) => {
    setRun(e);
    push('run');
  };
  const hold = useMemo(() => signal(0), []);

  // ---------------------------------------------------------------- the panel: one view at a time, pushed and popped
  const [stack, setStack] = useState<View[]>(['home']);
  const view = stack[stack.length - 1];
  const rootIsOrder = list.length === 0 && receipts.length === 0;
  const go = useCallback((dir: Nav, change: () => void) => {
    document.documentElement.dataset.nav = dir;
    transition(change);
  }, []);
  const push = (v: View) => go('forward', () => setStack((s) => (s[s.length - 1] === v ? s : [...s.filter((x) => x !== v), v])));
  // Back from the first view goes nowhere, and starts no transition: one would swallow the next click.
  const depth = useRef(stack.length);
  depth.current = stack.length;
  const back = useCallback(() => {
    if (depth.current > 1) go('back', () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)));
  }, [go]);
  // With nothing running the order is the home view, so a pushed copy of it is redundant.
  useEffect(() => {
    if (rootIsOrder && stack.includes('order')) setStack((s) => s.filter((v) => v !== 'order'));
  }, [rootIsOrder, stack]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a menu that just closed on this Escape has claimed it (by then it is already gone from the page)
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.picker-menu, .menu, .sheet')) return;
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  // Forget records of machines that are gone.
  const names = list.map((v) => v.name).sort().join(' ');
  useEffect(() => {
    if (vms.data && records.data?.some((r) => !vms.data!.some((v) => v.name === r.name))) void api.prune(h, vms.data.map((v) => v.name)).then(records.refresh, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names, records.data]);

  // C copies the SSH command of the newest ready machine.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'c' || e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
      const vm = [...(vms.data ?? [])].reverse().find((v) => v.ssh_access && phaseOf(v, states[v.name]) === 'running');
      if (!vm?.ssh_access) return;
      const cmd = `ssh -p ${vm.ssh_access.port} hotaisle@${vm.ssh_access.dns_name || vm.ssh_access.ip_address}`;
      navigator.clipboard.writeText(cmd).then(() => toast(`Copied the SSH command for ${vm.name}.`), () => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vms.data, states, toast]);

  // Power state per machine, refreshed with every list poll.
  useEffect(() => {
    const l = vms.data;
    if (!l) return;
    let cancel = false;
    Promise.all(l.map((vm) => api.vmState(h, vm.name).then((s) => [vm.name, s] as const).catch(() => [vm.name, undefined] as const))).then((pairs) => {
      if (!cancel) setStates(Object.fromEntries(pairs));
    });
    return () => {
      cancel = true;
    };
  }, [vms.data, h]);

  // Poll fast while anything is changing; notify when a machine becomes ready.
  useEffect(() => {
    const l = vms.data;
    if (!l) return;
    setFast(l.some((vm) => !settled(phaseOf(vm, states[vm.name]))) || !!launchedNow);
    for (const vm of l) {
      const ready = phaseOf(vm, states[vm.name]) === 'running';
      if (ready && wasReady.current[vm.name] === false && prefs.notify && 'Notification' in window && Notification.permission === 'granted') {
        const cmd = vm.ssh_access ? `ssh -p ${vm.ssh_access.port} hotaisle@${vm.ssh_access.dns_name || vm.ssh_access.ip_address}` : '';
        new Notification(`${vm.name} is ready`, { body: cmd });
      }
      if (states[vm.name]) wasReady.current[vm.name] = ready;
    }
  }, [vms.data, states, launchedNow, prefs.notify]);

  const refreshAll = useCallback(() => {
    void vms.refresh();
    void balance.refresh();
    void offers.refresh();
  }, [vms, balance, offers]);

  // The order card becomes the new machine's card.
  const onLaunched = (vm: VM, meta: LaunchMeta) => {
    wasReady.current[vm.name] = false;
    // Until the API names its server, draw the new machine where it was previewed: next to your others.
    const guess = placeNew(machinesRef.current, vm.gpus?.[0]?.count ?? 1);
    if (guess !== NEW) guessHost.current[vm.name] = guess;
    void api
      .record({ team: h, name: vm.name, launched: true, image: meta.image, price_cents: meta.price, gpus: `${vm.gpus?.[0]?.count ?? 1}× ${vm.gpus?.[0]?.model ?? 'MI300X'}`, metal: !!vm.metal, ...(meta.releaseAfter ? { release_in_minutes: meta.releaseAfter } : {}) })
      .then(() => records.refresh(), () => toast("Couldn't save this machine's launch time, so its timer and cost won't show.", 'err'));
    go('none', () => {
      vms.setData((l) => [...(l ?? []).filter((x) => x.name !== vm.name), vm]);
      setLaunchedNow(vm.name);
      setFocus(vm.name);
      setStack(['home']);
      hold.set(0);
    });
    window.setTimeout(() => setLaunchedNow(undefined), 900);
    refreshAll();
  };
  // Ending a machine turns its card into a receipt, and the receipt joins the history.
  const onEnded = (e: Ended) => {
    // the receipt takes the ended card's place in the list, so nothing around it moves
    const at = (vms.data ?? []).findIndex((x) => x.name === e.name);
    go('none', () => {
      vms.setData((l) => (l ?? []).filter((x) => x.name !== e.name));
      setReceipts((rs) => [...rs.filter((x) => x.name !== e.name), { ...e, at: at < 0 ? 0 : at + rs.length }]);
    });
    void api.addHistory(e).then(() => history.refresh(), () => undefined);
    refreshAll();
  };
  const dismiss = (name: string) =>
    go('none', () => {
      setReceipts((rs) => rs.filter((x) => x.name !== name));
      if (focus === name) setFocus(undefined);
    });
  const onRecord = async (name: string, patch: { release_in_minutes: number }) => {
    await api.record({ team: h, name, ...patch });
    await records.refresh();
  };

  const b = balance.data;
  const runout = b?.estimated_runout_time ? new Date(b.estimated_runout_time).getTime() - Date.now() : undefined;
  const gpusAtWork = list.reduce((n, v) => n + (v.gpus?.[0]?.count ?? 0), 0);
  // hours and minutes, padded so the readout keeps its width: "  27:14"
  const lasts = (ms: number) => {
    const m = Math.max(0, Math.floor(ms / 60000));
    return `${Math.min(9999, Math.floor(m / 60))}:${String(m % 60).padStart(2, '0')}`.padStart(7, ' ');
  };
  const canBuy = team.effective_roles.includes('purchaser') || team.effective_roles.includes('owner');
  const loaded = (vms.data !== undefined || vms.error) && (offers.data !== undefined || offers.error);
  const sizes = sizesOf(offers.data);
  const offerFor = (n?: number, model?: string) => sizes.find((o) => o.Specs.gpus?.[0]?.count === n && (!model || o.Specs.gpus?.[0]?.model === model));
  const priceOf = (vm: VM) => recByName[vm.name]?.price_cents || offerFor(vm.gpus?.[0]?.count, vm.gpus?.[0]?.model)?.OnDemandPrice;
  const shownNames = new Set([...list.map((v) => v.name), ...receipts.map((r) => r.name)]);
  const earlier = (history.data ?? []).filter((e) => !shownNames.has(e.name));

  // ---------------------------------------------------------------- what the drawing shows
  // Every machine on the server the API says it runs on. Ended ones keep theirs while their GPUs cool.
  const hostOf = useRef<Record<string, string>>({});
  for (const vm of list) if (states[vm.name]?.host) hostOf.current[vm.name] = states[vm.name]!.host;
  const serverOf = (name: string) => hostOf.current[name] ?? guessHost.current[name];
  const orderContext = rootIsOrder || stack.includes('order');
  const focused = list.find((v) => v.name === focus) ?? (receipts.some((r) => r.name === focus) ? undefined : list[list.length - 1]);
  const focusedReceipt = !focused ? (receipts.find((r) => r.name === focus) ?? receipts[0]) : undefined;
  const stageMachines: StageMachine[] = [
    ...list.map((vm) => {
      const rec = recByName[vm.name];
      return { name: vm.name, gpus: vm.gpus?.[0]?.count ?? 1, mode: stageModeOf(phaseOf(vm, states[vm.name])), since: rec?.launched_at ? new Date(rec.launched_at).getTime() : undefined, host: serverOf(vm.name) };
    }),
    ...receipts.map((r) => ({ name: r.name, gpus: Number(r.gpus.split('×')[0]) || 1, mode: 'ended' as const, host: serverOf(r.name) })),
  ];
  machinesRef.current = stageMachines;
  let stage: StageState;
  if (orderContext) {
    const o = offerFor(order.count);
    const n = order.count;
    stage = {
      machines: stageMachines,
      preview: n,
      readout: `${n} of this server's 8 GPUs ${n === 1 ? 'is' : 'are'} yours once you launch`,
      specTitle: o ? `${n}× ${o.Specs.gpus?.[0]?.model ?? 'MI300X'}` : 'Loading sizes',
      spec: o ? [...specRows(o.Specs), ['Share', `${n} of 8 GPUs on one server`], ...(o.OnDemandPrice != null ? ([['Price', `${money(o.OnDemandPrice)} an hour`]] as [string, string][]) : [])] : [],
    };
  } else if (focused) {
    const phase = phaseOf(focused, states[focused.name]);
    const n = focused.gpus?.[0]?.count ?? 1;
    const mode = stageModeOf(phase);
    const host = serverOf(focused.name);
    const addr = focused.ssh_access ? focused.ssh_access.dns_name || focused.ssh_access.ip_address : '';
    const neighbours = list.filter((v) => v.name !== focused.name && host && serverOf(v.name) === host).map((v) => v.name);
    stage = {
      machines: stageMachines,
      focus: focused.name,
      readout:
        mode === 'booting'
          ? `${phase === 'building' ? 'Setting up' : 'Booting'}. Your GPUs are warming up`
          : mode === 'ready'
            ? `${focused.name} is ready. ${n} GPU${n > 1 ? 's' : ''} at work`
            : `${focused.name} is ${phase === 'off' ? 'powered off' : phase}`,
      specTitle: focused.name,
      spec: [
        ...specRows(focused),
        ...(host ? ([['Server', neighbours.length ? `${host}, shared with ${neighbours.join(', ')}` : host]] as [string, string][]) : []),
        ...(addr ? ([['Address', addr]] as [string, string][]) : []),
        ...(priceOf(focused) ? ([['Price', `${money(priceOf(focused)!)} an hour`]] as [string, string][]) : []),
      ],
    };
  } else if (focusedReceipt) {
    stage = {
      machines: stageMachines,
      focus: focusedReceipt.name,
      readout: `${focusedReceipt.name} has ended. Its GPUs are cooling down`,
      specTitle: focusedReceipt.name,
      spec: [['GPUs', focusedReceipt.gpus], ['Ran for', focusedReceipt.ran_ms != null ? duration(focusedReceipt.ran_ms) : 'unknown'], ['Total, about', focusedReceipt.cents != null ? money(focusedReceipt.cents) : 'unknown']],
    };
  } else {
    stage = { machines: stageMachines, readout: 'Nothing running', specTitle: 'MI300X', spec: [] };
  }

  // Clicking one of your servers in the drawing brings its machine into focus.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      go(stack.length > 1 ? 'back' : 'none', () => {
        setFocus(name);
        setStack(['home']);
      });
    };
    window.addEventListener('stage-focus', onFocus);
    return () => window.removeEventListener('stage-focus', onFocus);
  }, [go, stack.length]);
  // The page arrives once, in one sequence; after that, things move only when you act.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    if (!loaded) return;
    const id = window.setTimeout(() => setEntering(false), 1600);
    return () => window.clearTimeout(id);
  }, [loaded]);

  // ---------------------------------------------------------------- panel views
  const homeTitle = rootIsOrder ? 'Rent a GPU machine' : list.length > 1 ? `Your machines (${list.length})` : 'Your machines';
  const titles: Record<View, string> = { home: homeTitle, order: 'New machine', settings: 'Settings', credits: 'Add credits', keys: 'SSH keys', image: 'Your cloud-init file', run: run ? run.name : 'Earlier run' };
  const running = list.filter((v) => phaseOf(v, states[v.name]) === 'running').length;

  const orderView = (
    <OrderView
        team={team}
        offers={offers.data}
        balance={b}
        keys={keys.data}
        vmCount={list.length}
        order={order}
        setOrder={setOrder}
        hold={hold}
        onKeys={() => push('keys')}
        onImage={() => push('image')}
      onLaunched={onLaunched}
    >
      {view === 'home' && <History items={earlier.slice(0, 3)} onOpen={openRun} />}
    </OrderView>
  );

  let body: React.ReactNode;
  let sub: string | undefined;
  let action: React.ReactNode = null;
  if (view === 'home' && rootIsOrder) {
    sub = 'Pick a size, hold the button, and SSH in a minute later.';
    body = orderView;
  } else if (view === 'home') {
    sub = list.length === 0 ? 'Nothing running.' : `${running} of ${list.length} ready${b && b.hourly_rate > 0 ? `, ${money(b.hourly_rate)} an hour in all` : ''}.`;
    body = (
      <>
        <div className="cards">
          {(() => {
            const cards: { at: number; node: React.ReactNode }[] = [];
            let i = 0;
            const slots = [...receipts].sort((a, b) => a.at - b.at);
            for (const vm of list) {
              while (slots.length && slots[0].at <= i) {
                const r = slots.shift()!;
                cards.push({ at: i++, node: <ReceiptCard key={'r' + r.name} r={r} onDone={() => dismiss(r.name)} /> });
              }
              const o = offerFor(vm.gpus?.[0]?.count, vm.gpus?.[0]?.model);
              cards.push({
                at: i++,
                node: (
                  <Trip
                    key={vm.deployment_id || vm.name}
                    team={team}
                    vm={vm}
                    state={states[vm.name]}
                    record={recByName[vm.name]}
                    price={priceOf(vm)}
                    minimumMin={o?.MinimumReservationMinutes ?? 30}
                    host={serverOf(vm.name)}
                    expanded={focused?.name === vm.name}
                    morph={launchedNow === vm.name}
                    onFocus={() => go('none', () => setFocus(vm.name))}
                    onChanged={refreshAll}
                    onEnded={(e) => {
                      setFocus(e.name);
                      onEnded(e);
                    }}
                    onRecord={(p) => onRecord(vm.name, p)}
                  />
                ),
              });
            }
            for (const r of slots) cards.push({ at: i++, node: <ReceiptCard key={'r' + r.name} r={r} onDone={() => dismiss(r.name)} /> });
            return cards.map((c) => c.node);
          })()}
        </div>
        <History items={earlier} onOpen={openRun} />
        <div className="foot">
          {/* the account at a glance, in the same instruments as the cards: fixed widths, so nothing shifts as they change */}
          <div className="cluster" aria-label="Account">
            <div className="meter-cell">
              <span className="meter-l">GPUs at work</span>
              <span className="meter-v">
                <Lcd className="sm" value={String(gpusAtWork).padStart(2, ' ')} label={`${gpusAtWork} GPUs at work`} />
              </span>
            </div>
            <div className="meter-cell">
              <span className="meter-l">Per hour</span>
              <span className="meter-v">
                <span className="cur">$</span>
                <Lcd className="sm" value={dollars(b?.hourly_rate)} label={b ? `${money(b.hourly_rate)} an hour` : 'unknown'} />
              </span>
            </div>
            <div className="meter-cell">
              <span className="meter-l">{b && b.hourly_rate > 0 && runout != null ? 'Balance lasts' : 'Balance'}</span>
              <span className="meter-v">
                {b && b.hourly_rate > 0 && runout != null ? (
                  <>
                    <Lcd className="sm" value={lasts(runout)} label={`about ${duration(runout)}`} />
                    <span className="unit">h</span>
                  </>
                ) : (
                  <>
                    <span className="cur">$</span>
                    <Lcd className="sm" value={dollars(b?.available_balance)} label={b ? money(b.available_balance) : 'unknown'} />
                  </>
                )}
              </span>
            </div>
          </div>
          <button className="btn primary big new" onClick={() => push('order')}>
            <span className="plus" aria-hidden="true" />
            New machine
          </button>
        </div>
      </>
    );
  } else if (view === 'order') {
    sub = 'Pick a size, hold the button, and SSH in a minute later.';
    body = orderView;
  } else if (view === 'settings') {
    body = <SettingsView status={status} teams={teams} team={team} onTeam={onTeam} onDemo={(on) => void onDemo(on)} />;
  } else if (view === 'credits') {
    body = (
      <CreditsView
        team={h}
        gpuHour={Math.min(...sizes.filter((o) => o.Specs.gpus?.[0]?.count === 1 && o.OnDemandPrice).map((o) => o.OnDemandPrice!))}
        onDone={() => {
          void balance.refresh();
          back();
        }}
      />
    );
  } else if (view === 'run' && run) {
    // an earlier run, all of it: what it was, where it ran, what it cost, and the same again in one press
    sub = `${run.gpus}, ended ${new Date(run.ended_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
    const n = Number(run.gpus.split('×')[0]) || 1;
    body = (
      <>
        <div className="cards">
          <ReceiptCard r={run} />
        </div>
        <div className="foot">
          <button
            className="btn primary big"
            onClick={() => {
              setOrder({ count: n, ...(run.image === 'standard' || run.image === 'vllm' ? { image: run.image } : {}) });
              go('forward', () => setStack(['home', 'order']));
            }}
          >
            Launch the same again
          </button>
        </div>
      </>
    );
  } else if (view === 'keys') {
    sub = 'Every machine you launch accepts these keys.';
    body = (
      <>
        <KeysView keys={keys.data} refresh={keys.refresh} hosted={!!status.hosted && !status.demo} />
        <div className="foot">
          <button className="btn big" onClick={back}>
            Done
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <ImageView
        value={order.customURL}
        onSave={(url) => {
          setOrder({ customURL: url, image: 'custom' });
          back();
        }}
      />
    );
  }

  return (
    <div className={`app ${entering ? 'entering' : ''}`}>
      <header className="top">
        <nav className="crumbs" aria-label="Where you are">
          <button className="brand" onClick={() => stack.length > 1 && go('back', () => setStack(['home']))} disabled={stack.length === 1}>
            Hot Aisle
          </button>
          {stack.map((v, i) =>
            i === 0 ? null : (
              <span key={v} className="crumb">
                <span className="sep" aria-hidden="true">
                  {chevronRight}
                </span>
                {i === stack.length - 1 ? (
                  <span aria-current="page">{titles[v]}</span>
                ) : (
                  <button onClick={() => go('back', () => setStack((s) => s.slice(0, i + 1)))}>{v === 'home' ? homeTitle : titles[v]}</button>
                )}
              </span>
            ),
          )}
        </nav>
        <span className="grow" />
        {status.demo && (
          <button className="tag" onClick={() => push('settings')} title="Showing sample data. Change in Settings.">
            Sample data
          </button>
        )}
        <div className={`money ${runout != null && runout < 6 * 3600_000 ? 'low' : ''}`}>
          <span className="money-amt">{b ? money(b.available_balance) : ' '}</span>
          <span className="money-sub">{!b ? ' ' : b.hourly_rate > 0 ? `${money(b.hourly_rate)}/hr, lasts ${runout != null ? duration(runout) : '…'}` : 'Balance'}</span>
        </div>
        {canBuy && (
          <button className={`btn ${view === 'credits' ? 'on' : ''}`} onClick={() => (view === 'credits' ? back() : push('credits'))}>
            Add credits
          </button>
        )}
        <button className={`btn icon ${view === 'settings' ? 'on' : ''}`} onClick={() => (view === 'settings' ? back() : push('settings'))} aria-label="Settings" aria-pressed={view === 'settings'} title="Settings">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M3 5.25h8.6a2.5 2.5 0 0 1 4.8 0H17v1.5h-.6a2.5 2.5 0 0 1-4.8 0H3zm11 .75a1 1 0 1 0 0 .01zM3 13.25h.6a2.5 2.5 0 0 1 4.8 0H17v1.5H8.4a2.5 2.5 0 0 1-4.8 0H3zm3 .75a1 1 0 1 0 0 .01z" />
          </svg>
        </button>
      </header>

      <div className="panes">
        <aside className="panel">
          <div className="pv" key={view === 'home' ? `home-${rootIsOrder}` : view} style={{ viewTransitionName: 'panel' }}>
            <header className="pv-head">
              <div className="pv-title">
                {stack.length > 1 && (
                  <button className="back-btn" onClick={back} aria-label={`Back to ${stack[stack.length - 2] === 'home' ? homeTitle : titles[stack[stack.length - 2]]}`} title="Back (Esc)">
                    {chevronLeft}
                  </button>
                )}
                <h1>{titles[view]}</h1>
                {action}
              </div>
              {sub !== undefined && <p className="pv-sub">{sub}</p>}
            </header>
            {(vms.error || offers.error) && (
              <p className="banner">
                {(vms.error || offers.error)!.message}{' '}
                <button className="btn-text" onClick={refreshAll}>
                  Try again
                </button>
              </p>
            )}
            <div className="pv-body">{loaded ? body : <div className="placeholder" aria-busy="true" />}</div>
          </div>
        </aside>
        <Stage state={stage} hold={hold} entrance={entering} />
      </div>
    </div>
  );
}

function CreditsView({ team, gpuHour, onDone }: { team: string; gpuHour: number; onDone: () => void }) {
  const toast = useToast();
  const [amt, setAmt] = useState(100);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const dollars = custom ? Number(custom) : amt;
  const valid = Number.isFinite(dollars) && dollars >= 20 && dollars <= 999999;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.buyCredits(team, Math.round(dollars * 100));
      if (r.demo_credited) {
        toast(`Added ${money(dollars * 100, 0)} of sample credit.`);
        onDone();
        return;
      }
      setUrl(r.checkout_url);
      window.open(r.checkout_url, '_blank', 'noopener');
    } catch (e) {
      toast(`Couldn't open checkout. ${(e as Error).message}`, 'err');
    } finally {
      setBusy(false);
    }
  };
  if (url)
    return (
      <div className="stack">
        <p>Checkout opened in a new tab. Your balance updates once Stripe confirms the payment.</p>
        <a className="btn" href={url} target="_blank" rel="noopener noreferrer">
          Open checkout again
        </a>
        <button className="btn primary big" onClick={onDone}>
          Done
        </button>
      </div>
    );
  return (
    <div className="stack">
      <div className="amounts" role="radiogroup" aria-label="Amount">
        {[50, 100, 250, 500].map((v) => (
          <button key={v} role="radio" aria-checked={!custom && amt === v} className={!custom && amt === v ? 'on' : ''} onClick={() => { setAmt(v); setCustom(''); }}>
            <b>${v}</b>
            <span>{Number.isFinite(gpuHour) ? `about ${Math.floor((v * 100) / gpuHour)} GPU hours` : ' '}</span>
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-l">Other</span>
        <span className="dollar">
          $<input inputMode="decimal" value={custom} placeholder="20 or more" onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))} />
        </span>
      </label>
      <p className="muted small">{!valid ? 'The minimum is $20. ' : ''}You pay on Stripe's page; this app never sees your card.</p>
      <div className="foot">
        <button className="btn primary big" disabled={!valid || busy} onClick={go}>
          {busy ? 'Opening checkout…' : valid ? `Continue to checkout, ${money(dollars * 100, 0)}` : 'Continue to checkout'}
        </button>
      </div>
    </div>
  );
}
