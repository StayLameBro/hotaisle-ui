import { useState } from 'react';
import { api, type LocalStatus } from './api';
import { CopyButton } from './ui';

/** First run: no API key yet. Two steps, or look around with sample data. */
export function Connect({ status, onConnected, onDemo }: { status: LocalStatus; onConnected: () => void; onDemo: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.saveToken(token);
      setToken('');
      onConnected();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <div className="lone">
        <span className="brand">Hot Aisle</span>
        <h1>Connect your account</h1>
        <p className="lede">You do this once. After that, a GPU machine is one press away.</p>

        <ol className="device steps">
          <li>
            <span className="step-n">1</span>
            <div className="step-b">
              <p>
                <b>Create an API key</b> in Hot Aisle's terminal app. If you're new to Hot Aisle, the same command creates your account.
              </p>
              <div className="cmd">
                <code>ssh admin.hotaisle.app</code>
                <CopyButton text="ssh admin.hotaisle.app" />
              </div>
              <p className="hint">In the app, press Esc, move up to your name, and open API keys.</p>
            </div>
          </li>
          <li>
            <span className="step-n">2</span>
            <form onSubmit={submit} className="step-b">
              <label htmlFor="token">
                <b>Paste the key</b>
              </label>
              <div className="pasterow">
                <input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
                <button className="btn primary" disabled={!token.trim() || busy}>
                  {busy ? 'Checking' : 'Connect'}
                </button>
              </div>
              {err && <p className="error">{err}</p>}
              <p className="hint">
                {status.hosted
                  ? "It's kept in this server's memory for your session only: never written to disk, never sent back to the page. Sign out in Settings to forget it."
                  : `It's saved in ${status.config_path}, where the hotaisle CLI keeps its key. It stays on this computer, and the web page never sees it.`}
              </p>
            </form>
          </li>
        </ol>

        <p className="hint">
          Not ready to connect?{' '}
          <button className="btn-text" onClick={onDemo}>
            Look around with sample data
          </button>
        </p>
      </div>
    </main>
  );
}
