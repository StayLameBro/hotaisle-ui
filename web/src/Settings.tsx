import { api, type Status, type Team } from './api';
import { IMAGES, usePrefs, type Image, type Theme } from './prefs';

function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsView({ status, teams, team, onTeam, onDemo }: { status: Status; teams: Team[]; team: Team; onTeam: (h: string) => void; onDemo: (on: boolean) => void }) {
  const [p, set] = usePrefs();
  const notifyOn = async (on: boolean) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const r = await Notification.requestPermission();
      if (r !== 'granted') return set({ notify: false });
    }
    set({ notify: on });
  };
  return (
    <div className="settings">
      <section className="group">
        <h2 className="group-h">New machines start with</h2>
        <div className="field">
          <span className="field-l">Size</span>
          <Seg label="Default size" value={p.gpus} onChange={(v) => set({ gpus: v })} options={[1, 2, 4, 8].map((n) => ({ value: n, label: `${n} GPU${n > 1 ? 's' : ''}` }))} />
        </div>
        <div className="field">
          <label className="field-l" htmlFor="def-image">
            Image
          </label>
          <select id="def-image" value={p.image} onChange={(e) => set({ image: e.target.value as Image })}>
            {(Object.keys(IMAGES) as Image[]).map((k) => (
              <option key={k} value={k}>
                {IMAGES[k].name}
              </option>
            ))}
          </select>
        </div>
        {p.image === 'custom' && (
          <div className="field">
            <label className="field-l" htmlFor="def-url">
              Cloud-init link
            </label>
            <input id="def-url" type="url" placeholder="https://…" value={p.customURL} onChange={(e) => set({ customURL: e.target.value })} />
          </div>
        )}
      </section>

      <section className="group">
        <h2 className="group-h">Look and sound</h2>
        <div className="field">
          <span className="field-l">Theme</span>
          <Seg<Theme> label="Theme" value={p.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </div>
        <label className="check">
          <input type="checkbox" checked={p.sound} onChange={(e) => set({ sound: e.target.checked })} />
          <span>Key sounds, and a chime when a machine is ready</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.notify} onChange={(e) => void notifyOn(e.target.checked)} />
          <span>Desktop notification when a machine is ready</span>
        </label>
      </section>

      <section className="group">
        <h2 className="group-h">Keyboard</h2>
        <dl className="keys-list">
          <dt>
            <kbd>1</kbd> <kbd>2</kbd> <kbd>4</kbd> <kbd>8</kbd>
          </dt>
          <dd>Pick a size</dd>
          <dt>
            hold <kbd>L</kbd>
          </dt>
          <dd>Launch</dd>
          <dt>
            <kbd>C</kbd>
          </dt>
          <dd>Copy the SSH command of your newest machine</dd>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>Go back</dd>
        </dl>
      </section>

      <section className="group">
        <h2 className="group-h">Account</h2>
        {teams.length > 1 && (
          <div className="field">
            <label className="field-l" htmlFor="team">
              Team
            </label>
            <select id="team" value={team.handle} onChange={(e) => onTeam(e.target.value)}>
              {teams.map((t) => (
                <option key={t.handle} value={t.handle}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={status.demo} onChange={(e) => onDemo(e.target.checked)} />
          <span>Use sample data instead of my account</span>
        </label>
        <p className="muted small">
          {status.demo
            ? 'Sample data is a built-in copy of the API, running in this tab. Nothing is billed.'
            : status.kind === 'email'
              ? 'Signed in with an emailed link.'
              : 'Signed in with an API key.'}{' '}
          hotaisle-ui {status.version}, community-built on the public Hot Aisle API.
        </p>
        {status.signed_in && !status.demo && (
          <button
            className="btn"
            onClick={() => {
              void api.signOut().finally(() => location.reload());
            }}
          >
            Sign out
          </button>
        )}
      </section>
    </div>
  );
}
