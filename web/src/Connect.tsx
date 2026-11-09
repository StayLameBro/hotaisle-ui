import { useEffect, useState } from 'react';
import { api, type Status } from './api';
import { CopyButton } from './ui';

type Step = 'email' | 'waiting' | 'key';

/** Signing in: an emailed link (when Hot Aisle's API offers it) or an API key. Or look around with sample data. */
export function Connect({ status, onConnected, onDemo }: { status: Status; onConnected: () => void; onDemo: () => void }) {
  const [step, setStep] = useState<Step>(status.waiting_for_email ? 'waiting' : status.email_login ? 'email' : 'key');
  const [email, setEmail] = useState(status.waiting_for_email?.email ?? '');
  const [sentTo, setSentTo] = useState(status.waiting_for_email?.email ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // waiting for the emailed link: ask every few seconds; the page signs in by itself once it's opened
  useEffect(() => {
    if (step !== 'waiting') return;
    let stop = false;
    let timer = 0;
    const poll = async () => {
      try {
        const r = await api.emailWait();
        if (stop) return;
        if (r.done) return onConnected();
      } catch (e) {
        if (stop) return;
        setErr((e as Error).message);
        setStep('email');
        return;
      }
      timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [step, onConnected]);

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.emailStart(email.trim());
      setSentTo(r.email);
      setStep('waiting');
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const useKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.signInWithKey(key);
      setKey('');
      onConnected();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (s: Step) => {
    setErr('');
    setStep(s);
  };

  return (
    <main className="center">
      <div className="lone">
        <span className="brand">Hot Aisle</span>
        {step === 'email' && (
          <>
            <h1>Sign in</h1>
            <p className="lede">We'll email you a link. Open it, and this page signs in by itself.</p>
            <form onSubmit={sendLink} className="step-b">
              <label htmlFor="email">
                <b>Email address</b>
              </label>
              <div className="pasterow">
                <input id="email" type="email" autoComplete="email" autoFocus placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button className="btn primary" disabled={!email.trim() || busy}>
                  {busy ? 'Sending' : 'Email me a link'}
                </button>
              </div>
              {err && <p className="error">{err}</p>}
            </form>
            <p className="hint">
              <button className="btn-text" onClick={() => switchTo('key')}>
                Use an API key instead
              </button>
            </p>
          </>
        )}

        {step === 'waiting' && (
          <>
            <h1>Check your email</h1>
            <p className="lede">
              We sent a sign-in link to <b>{sentTo}</b>. Open it on any device; this page signs in as soon as you do.
            </p>
            <p className="hint">Waiting for the link to be opened…</p>
            <p className="hint">
              <button className="btn-text" onClick={() => switchTo('email')}>
                Use a different email
              </button>
            </p>
          </>
        )}

        {step === 'key' && (
          <>
            <h1>Sign in with an API key</h1>
            <p className="lede">Create a key in Hot Aisle's terminal app, then paste it here.</p>
            <ol className="device steps">
              <li>
                <span className="step-n">1</span>
                <div className="step-b">
                  <div className="cmd">
                    <code>ssh admin.hotaisle.app</code>
                    <CopyButton text="ssh admin.hotaisle.app" />
                  </div>
                  <p className="hint">Press Esc, move up to your name, and open API keys. New to Hot Aisle? The same command creates your account.</p>
                </div>
              </li>
              <li>
                <span className="step-n">2</span>
                <form onSubmit={useKey} className="step-b">
                  <label htmlFor="token">
                    <b>Paste the key</b>
                  </label>
                  <div className="pasterow">
                    <input id="token" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
                    <button className="btn primary" disabled={!key.trim() || busy}>
                      {busy ? 'Checking' : 'Sign in'}
                    </button>
                  </div>
                  {err && <p className="error">{err}</p>}
                  <p className="hint">It's kept by the server for your session, encrypted, and never sent back to this page.</p>
                </form>
              </li>
            </ol>
            {status.email_login && (
              <p className="hint">
                <button className="btn-text" onClick={() => switchTo('email')}>
                  Sign in with email instead
                </button>
              </p>
            )}
          </>
        )}

        <p className="hint">
          Not ready to sign in?{' '}
          <button className="btn-text" onClick={onDemo}>
            Look around with sample data
          </button>
        </p>
      </div>
    </main>
  );
}
