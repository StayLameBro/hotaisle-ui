import { useEffect, useMemo, useState } from 'react';
import { api, APIError, type Balance, type Offer, type SSHKey, type Team, type VM } from './api';
import { gb, hbm, hoursOr, keyLabel, money } from './format';
import { IMAGES, RELEASE_CHOICES, VLLM_URL, type Image } from './prefs';
import type { Signal } from './signal';
import { sound } from './sound';
import { HoldButton, Picker, useToast } from './ui';

export type Order = { count: number; image: Image; customURL: string; releaseAfter: number };
export type LaunchMeta = { image: Image; price?: number; releaseAfter: number };

const PLACEHOLDER = [1, 2, 4, 8];

/**
 * The sizes on offer, smallest first: virtual machines with 1, 2 or 4 GPUs, and a whole 8-GPU server as
 * bare metal. The whole server always has its row, so the list never changes length when stock does.
 */
export const sizesOf = (offers?: Offer[]) => {
  const list = (offers ?? []).filter((o) => o.Specs?.gpus?.length).sort((a, b) => a.Specs.gpus![0].count - b.Specs.gpus![0].count);
  if (offers && !list.some((o) => o.Specs.gpus![0].count === 8))
    list.push({ Quantity: 0, MinimumReservationMinutes: 480, metal: true, Specs: { cpu_cores: 0, ram_capacity: 0, disk_capacity: 0, gpus: [{ count: 8, manufacturer: 'AMD', model: 'MI300X' }] } });
  return list;
};


/** A span short enough for one line: "13 h 22 min", "2 days 4 h". */
const short = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return `${d} day${d > 1 ? 's' : ''}${h ? ` ${h} h` : ''}`;
  return h ? `${h} h ${m % 60} min` : `${m} min`;
};

/** Choosing a machine: a few clear options, the price up front, one button. */
export function OrderView({
  team, offers, balance, keys, vmCount, order, setOrder, hold, onKeys, onImage, onLaunched, children,
}: {
  team: Team;
  offers?: Offer[];
  balance?: Balance;
  keys?: SSHKey[];
  vmCount: number;
  order: Order;
  setOrder: (o: Partial<Order>) => void;
  hold: Signal<number>;
  onKeys: () => void;
  onImage: () => void;
  onLaunched: (vm: VM, meta: LaunchMeta) => void;
  children?: React.ReactNode;
}) {
  const toast = useToast();
  const sizes = useMemo(() => sizesOf(offers), [offers]);
  const [busy, setBusy] = useState(false);
  const { count, image, customURL, releaseAfter } = order;

  // Fall back to the nearest size in stock when the preferred one is gone.
  useEffect(() => {
    const cur = sizes.find((o) => o.Specs.gpus![0].count === count);
    if (sizes.length && (!cur || cur.Quantity === 0)) {
      const near = sizes.filter((o) => o.Quantity > 0).sort((a, b) => Math.abs(a.Specs.gpus![0].count - count) - Math.abs(b.Specs.gpus![0].count - count))[0];
      if (near) setOrder({ count: near.Specs.gpus![0].count });
    }
  }, [sizes, count, setOrder]);

  // 1, 2, 4 and 8 pick a size.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
      const n = Number(e.key);
      if (sizes.some((o) => o.Specs.gpus![0].count === n && o.Quantity > 0)) {
        sound.tick();
        setOrder({ count: n });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sizes, setOrder]);

  const offer = sizes.find((o) => o.Specs.gpus![0].count === count);
  const g = offer?.Specs.gpus?.[0];
  const price = offer?.OnDemandPrice;
  const minCharge = price != null && offer ? (price * offer.MinimumReservationMinutes) / 60 : undefined;
  const canOperate = team.effective_roles.includes('operator') || team.effective_roles.includes('owner');
  const atLimit = !!team.maximum_virtual_machines && vmCount >= team.maximum_virtual_machines;
  const noKey = keys != null && keys.length === 0;
  const userData = image === 'vllm' ? VLLM_URL : image === 'custom' ? customURL.trim() : '';
  const badURL = image === 'custom' && !/^https:\/\/\S+$/.test(userData);
  const spendable = balance ? balance.available_balance - (balance.minimum_balance ?? 0) : undefined;
  const lowBalance = spendable != null && minCharge != null && spendable < minCharge;

  let blocker = '';
  if (!canOperate) blocker = "Your API key can't launch machines on this team. It needs the operator role.";
  else if (atLimit) blocker = `This team can run ${team.maximum_virtual_machines} machines at once. End one to launch another.`;
  else if (noKey) blocker = 'Add an SSH key first. It is how you log in.';
  else if (offers && !sizes.some((o) => o.Quantity > 0)) blocker = 'Every size is taken right now. Check back in a few minutes.';
  else if (badURL && !offer?.metal) blocker = 'Add the https:// link to your cloud-init file.';
  else if (lowBalance) blocker = 'Your balance is below the minimum charge. Add credits to launch.';

  const launch = async () => {
    if (!offer || !g) return;
    setBusy(true);
    try {
      const vm = offer.metal ? await api.reserve(team.handle, offer) : await api.provision(team.handle, [{ count: g.count, manufacturer: g.manufacturer, model: g.model }], userData || undefined);
      onLaunched(vm, { image: offer.metal ? 'standard' : image, price, releaseAfter });
    } catch (e) {
      const err = e as APIError;
      const known: Record<number, string> = {
        402: 'Not enough balance for this machine. Add credits and try again.',
        404: 'That size was just taken. Pick another, or try again in a minute.',
        428: 'Hot Aisle needs an SSH key on your account first.',
      };
      toast(known[err.status] ?? `Launch failed. ${err.message}`, 'err');
      hold.set(0);
    } finally {
      setBusy(false);
    }
  };

  const rows = sizes.length ? sizes : undefined;
  return (
    <section className="order vt" aria-label="Launch a machine" style={{ ['--vt' as string]: 'launcher' }}>
      <div className="options" role="radiogroup" aria-label="Machine size">
        {(rows ?? PLACEHOLDER.map((n) => ({ Quantity: -1, MinimumReservationMinutes: 0, Specs: { cpu_cores: 0, ram_capacity: 0, disk_capacity: 0, gpus: [{ count: n, model: 'MI300X' }] } }) as Offer)).map((o) => {
          const og = o.Specs.gpus![0];
          const n = og.count;
          const loading = o.Quantity < 0;
          const out = o.Quantity === 0;
          const on = n === count && !loading;
          return (
            <button
              key={n}
              role="radio"
              aria-checked={on}
              aria-keyshortcuts={String(n)}
              disabled={loading || out}
              className={`opt ${on ? 'on' : ''} ${out ? 'out' : ''}`}
              onClick={() => {
                sound.tick();
                setOrder({ count: n });
              }}
            >
              <span className="opt-radio" aria-hidden="true" />
              <span className="opt-main">
                <span className="opt-name">
                  {n}× {og.model ?? 'MI300X'}
                </span>
                <span className="opt-sub">{loading ? ' ' : o.metal ? `Whole server: ${hbm(og)}${o.Specs.cpu_cores ? `, ${o.Specs.cpu_cores} cores, ${gb(o.Specs.ram_capacity)}` : ''}` : `${hbm(og) || `${n} GPU${n > 1 ? 's' : ''}`}, ${o.Specs.cpu_cores} cores, ${gb(o.Specs.ram_capacity)}`}</span>
              </span>
              <span className="opt-end">
                <span className="opt-price">
                  {loading ? <span className="dash">–</span> : <b>{o.OnDemandPrice != null ? money(o.OnDemandPrice) : '–'}</b>}
                  <span>/hr</span>
                </span>
                <span className={`opt-avail ${out ? 'none' : o.Quantity > 0 && o.Quantity <= 2 ? 'low' : ''}`}>{loading ? ' ' : out ? 'None free' : o.Quantity === 1 ? '1 left' : `${o.Quantity} free`}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="details">
        <Picker<Image>
          label="Image"
          fixed={offer?.metal ? "Hot Aisle's standard image" : undefined}
          value={image}
          onChange={(v) => {
            setOrder({ image: v });
            if (v === 'custom' && !customURL.trim()) onImage();
          }}
          options={(Object.keys(IMAGES) as Image[]).map((k) => ({ value: k, label: IMAGES[k].name, hint: IMAGES[k].note }))}
          footer={
            image === 'custom' ? (
              <button className="btn-text" onClick={onImage}>
                Change cloud-init link
              </button>
            ) : undefined
          }
        />
        <Picker<number>
          label="Auto-end"
          value={releaseAfter}
          onChange={(v) => setOrder({ releaseAfter: v })}
          options={RELEASE_CHOICES.map((c) => ({
            value: c.min,
            label: c.min ? `After ${c.min / 60} hour${c.min === 60 ? '' : 's'}` : 'Off',
            hint: c.min ? (price ? `About ${money((price * c.min) / 60)} in total` : undefined) : 'Runs until you end it',
          }))}
        />
        <button className={`picker-btn ${noKey ? 'attention' : ''}`} onClick={onKeys}>
          <span className="picker-l">SSH key</span>
          <span className="picker-v">{!keys ? 'Checking' : noKey ? 'Add one' : keys.length === 1 ? keyLabel(keys[0]) : `${keys.length} keys`}</span>
          <svg className="chev" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true">
            <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <section className="estimate group" aria-label="Estimate">
        <h2 className="group-h">Estimate</h2>
        <dl>
          {offer && price != null && minCharge != null ? (
            <>
              <dt>Minimum ({hoursOr(offer.MinimumReservationMinutes)})</dt>
              <dd>{money(minCharge)}</dd>
              <dt>An hour</dt>
              <dd>{money(price)}</dd>
              <dt>{releaseAfter ? `Until auto-end (${releaseAfter / 60} h)` : 'A working day (8 hours)'}</dt>
              <dd>{money((price * (releaseAfter || 480)) / 60)}</dd>
              <dt className="spare">A full day</dt>
              <dd className="spare">{money(price * 24)}</dd>
              <dt>Your balance covers</dt>
              <dd className="dim">{spendable != null && price > 0 ? `about ${short((spendable / (price + (balance?.hourly_rate ?? 0))) * 3600_000)}` : '–'}</dd>
            </>
          ) : (
            <>
              <dt>Loading prices</dt>
              <dd className="dim">–</dd>
            </>
          )}
        </dl>
      </section>
      {children}
      <div className="go foot">
        <HoldButton
          id="launch"
          hotkey="l"
          label={g ? `Hold to ${offer?.metal ? 'reserve' : 'launch'} ${g.count}× ${g.model ?? 'MI300X'}` : 'Hold to launch'}
          trailing={price != null ? `${money(price)}/hr` : undefined}
          busyLabel={offer?.metal ? 'Reserving' : 'Launching'}
          onConfirm={launch}
          onProgress={(p) => hold.set(p)}
          disabled={!!blocker || !offer}
          busy={busy}
          hint="Press and hold, or hold L. Billing starts once the machine is yours."
        />
        <p className={`fine ${blocker ? 'blocked' : ''}`}>
          {blocker ||
            (offer?.metal && minCharge != null
              ? `A whole server. Billed for at least ${hoursOr(offer.MinimumReservationMinutes)} (${money(minCharge)}), even if you end it sooner.`
              : offer
                ? <>Billed by the minute. Billing starts once the machine is yours.<span className="fine-min">{minCharge != null ? ` At least ${money(minCharge)}.` : ''}</span></>
                : ' ')}
        </p>
      </div>
    </section>
  );
}

/** SSH keys: the ones on the account; add one by pasting its public half. */
export function KeysView({ keys, refresh }: { keys?: SSHKey[]; refresh: () => Promise<void> }) {
  const toast = useToast();
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState('');

  const add = async (authorized: string, label: string) => {
    setBusy(label);
    try {
      await api.addKey(authorized.trim());
      await refresh();
      setPaste('');
      sound.tick();
      toast(`Added ${label}.`);
    } catch (e) {
      const err = e as APIError;
      toast(err.status === 409 ? 'That key is already on your account.' : err.status === 403 ? "Your API key can't add SSH keys. It needs the owner role." : `Couldn't add the key. ${err.message}`, 'err');
    } finally {
      setBusy('');
    }
  };

  const [removing, setRemoving] = useState('');
  const remove = async (k: SSHKey) => {
    setBusy('remove');
    try {
      await api.removeKey(k.fingerprint);
      await refresh();
      toast(`Removed ${keyLabel(k)}.`);
    } catch (e) {
      const err = e as APIError;
      toast(err.status === 403 ? "Your API key can't remove SSH keys. It needs the owner role." : `Couldn't remove the key. ${err.message}`, 'err');
    } finally {
      setBusy('');
      setRemoving('');
    }
  };

  return (
    <div className="stack">
      <div className="group">
        <h2 className="group-h">On your account</h2>
        {keys && keys.length > 0 ? (
          <ul className="rows">
            {keys.map((k) => (
              <li key={k.fingerprint} className={`row-item key ${removing === k.fingerprint ? 'confirm' : ''}`}>
                {removing === k.fingerprint ? (
                  <>
                    <span className="key-q">Remove {keyLabel(k)}? New machines won't accept it, and bare-metal servers stop accepting it at once.</span>
                    <span className="key-acts">
                      <button className="btn-text" onClick={() => setRemoving('')}>
                        Keep
                      </button>
                      <button className="btn-text danger" disabled={!!busy} onClick={() => void remove(k)}>
                        Remove
                      </button>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="mono">{keyLabel(k)}</span>
                    <span className="muted">{k.type.replace('ssh-', '')}</span>
                    <button className="btn-text key-x" onClick={() => setRemoving(k.fingerprint)} aria-label={`Remove ${keyLabel(k)}`}>
                      Remove
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None yet. Add one below; every machine you launch will accept it.</p>
        )}
      </div>
      <div className="group">
        <h2 className="group-h">Add a public key</h2>
        <div className="pasterow">
          <input placeholder="ssh-ed25519 AAAA…" value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Public key" spellCheck={false} />
          <button className="btn" disabled={!paste.trim() || !!busy} onClick={() => add(paste, 'your key')}>
            Add
          </button>
        </div>
        <p className="muted small">
          Paste the public half, the contents of <code>~/.ssh/id_ed25519.pub</code> (on a Mac: <code>pbcopy &lt; ~/.ssh/id_ed25519.pub</code>). No key yet? Create
          one with <code>ssh-keygen -t ed25519</code>.
        </p>
      </div>
    </div>
  );
}

/** The link to a cloud-init file, for the custom image. */
export function ImageView({ value, onSave }: { value: string; onSave: (url: string) => void }) {
  const [url, setUrl] = useState(value);
  const ok = /^https:\/\/\S+$/.test(url.trim());
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave(url.trim());
      }}
    >
      <p className="muted">It runs on first boot. Hot Aisle fetches it from this link, so it must be public over https.</p>
      <input className="url" type="url" autoFocus placeholder="https://example.com/user-data.yaml" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button className="btn primary big" disabled={!ok}>
        Use this file
      </button>
    </form>
  );
}
