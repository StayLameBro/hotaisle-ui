import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { sound } from './sound';

// ---------------------------------------------------------------- polling

/** Calls fn now and every `ms` while the tab is visible. ms = null pauses. */
export function usePoll<T>(fn: (() => Promise<T>) | null, ms: number | null, key: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Only the newest request may land, and a local setData outranks requests already in flight, so a slow
  // older response never puts back a list from before a launch or an end.
  const started = useRef(0);
  const applied = useRef(0);
  const run = useCallback(async () => {
    if (!fnRef.current) return;
    const mine = ++started.current;
    try {
      const v = await fnRef.current();
      if (mine < applied.current) return;
      applied.current = mine;
      setData(v);
      setError(undefined);
    } catch (e) {
      if (mine >= applied.current) setError(e as Error);
    }
  }, []);
  const setLocal = useCallback((v: T | undefined | ((prev: T | undefined) => T | undefined)) => {
    applied.current = ++started.current;
    setData(v);
  }, []);
  useEffect(() => {
    applied.current = ++started.current;
    setData(undefined);
    setError(undefined);
    if (!fnRef.current) return;
    void run();
  }, [key, run]);
  useEffect(() => {
    if (ms == null || !fnRef.current) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void run();
    }, ms);
    const onVis = () => document.visibilityState === 'visible' && void run();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms, key, run]);
  return { data, error, refresh: run, setData: setLocal };
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; text: string; tone: 'ok' | 'err' | 'info'; leaving?: boolean };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-3), { id, text, tone }]);
    window.setTimeout(() => dismiss(id), tone === 'err' ? 9000 : 4500);
  }, []);
  const dismiss = (id: number) => {
    setList((l) => l.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 220);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.tone} ${t.leaving ? 'leaving' : ''}`}>
            {t.text}
            <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- hold-to-confirm

/**
 * A button you press and hold to confirm something that costs money or deletes data.
 * Works with mouse, touch, and Space/Enter held down. The fill heats up as you hold.
 */
export function HoldButton({
  label, busyLabel, onConfirm, onProgress, ms = 700, tone = 'heat', disabled, busy, hint, id, hotkey, trailing,
}: {
  label: string;
  busyLabel?: string;
  onConfirm: () => void;
  onProgress?: (p: number) => void; // 0..1 while held; back to 0 if let go early
  ms?: number;
  tone?: 'heat' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
  id?: string;
  hotkey?: string; // hold this key anywhere on the page (outside text fields) to press the button
  trailing?: string; // shown at the right edge, e.g. the price
}) {
  // The hold is a charge: holding fills it at a steady rate, letting go drains it back (faster), and pressing
  // again carries on from wherever it is. The fill is drawn straight from the frame loop, not through React.
  const ref = useRef<HTMLButtonElement>(null);
  const level = useRef(0);
  const holding = useRef(false);
  const done = useRef(false);
  const raf = useRef(0);
  const last = useRef(0);
  const ticks = useRef(0);
  const [phase, setPhase] = useState<'idle' | 'holding' | 'done'>('idle');

  const loop = useCallback(
    (now: number) => {
      const dt = last.current ? Math.min(0.05, (now - last.current) / 1000) : 0;
      last.current = now;
      const was = level.current;
      level.current = Math.min(1, Math.max(0, was + (holding.current ? dt / (ms / 1000) : -dt / ((ms * 0.45) / 1000))));
      const l = level.current;
      ref.current?.style.setProperty('--p', l.toFixed(4));
      onProgress?.(l);
      // two soft ticks on the way: a third, and two thirds
      const t = Math.floor(l * 3);
      if (holding.current && t > ticks.current && t < 3) sound.tick();
      ticks.current = t;
      if (l >= 1 && holding.current) {
        holding.current = false;
        done.current = true;
        if (navigator.vibrate) navigator.vibrate(12);
        if (tone === 'danger') sound.drop();
        else sound.thunk();
        setPhase('done');
        onConfirm();
        // the fill flashes, then lets go
        window.setTimeout(() => {
          done.current = false;
          level.current = 0;
          ref.current?.style.setProperty('--p', '0');
          onProgress?.(0);
          setPhase('idle');
        }, 520);
        return;
      }
      if (!holding.current && l <= 0) {
        last.current = 0;
        setPhase('idle');
        return;
      }
      raf.current = requestAnimationFrame(loop);
    },
    [ms, onConfirm, onProgress, tone],
  );
  const begin = useCallback(() => {
    if (disabled || busy || holding.current || done.current) return;
    holding.current = true;
    setPhase('holding');
    if (!last.current) {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(loop);
    }
  }, [disabled, busy, loop]);
  const stop = useCallback(() => {
    holding.current = false;
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => {
    if (!hotkey) return;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== hotkey || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e) || document.querySelector('.scrim')) return;
      e.preventDefault();
      begin();
    };
    const up = (e: KeyboardEvent) => e.key.toLowerCase() === hotkey && stop();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [hotkey, begin, stop]);

  return (
    <button
      id={id}
      type="button"
      ref={ref}
      className={`hold ${tone} ${phase === 'holding' ? 'holding' : ''} ${phase === 'done' ? 'done' : ''} ${busy ? 'busy' : ''}`}
      disabled={disabled}
      aria-busy={busy}
      aria-description={hint ?? 'Press and hold to confirm'}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && stop()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-flash" aria-hidden="true" />
      {/* the three labels share one place and cross-fade, so the button never changes shape */}
      <span className="hold-label">
        <span data-on={!busy && phase === 'idle'}>{label}</span>
        <span data-on={!busy && phase !== 'idle'} aria-hidden={busy || phase === 'idle'}>
          {phase === 'done' ? busyLabel ?? 'Working' : 'Keep holding'}
        </span>
        <span data-on={!!busy} aria-hidden={!busy}>
          {busyLabel ?? 'Working'}
        </span>
      </span>
      {trailing && <span className="hold-trail">{trailing}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- copy

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className={`btn copy ${ok ? 'done' : ''} ${className}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          sound.tick();
          setOk(true);
          window.setTimeout(() => setOk(false), 1600);
        } catch {
          window.prompt('Copy this:', text);
        }
      }}
    >
      <span className="labels">
        <span aria-hidden={ok}>{label}</span>
        <span aria-hidden={!ok}>Copied</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({ title, onClose: close, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const onClose = useCallback(() => {
    setClosing(true);
    window.setTimeout(close, 170);
  }, [close]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button, select, textarea, [tabindex]')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className={`scrim ${closing ? 'closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-h">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- picker

export type PickerOption<T extends string | number> = { value: T; label: string; hint?: string };

/**
 * A compact "Label: value" control that opens a small menu in place. The menu floats over the page,
 * so opening it never moves anything else.
 */
export function Picker<T extends string | number>({
  label, value, options, onChange, footer, fixed,
}: {
  label: string;
  value: T;
  options: PickerOption<T>[];
  onChange: (v: T) => void;
  footer?: ReactNode;
  /** When set, the choice doesn't apply here: show this instead, and don't open. */
  fixed?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // this Escape closed the menu; it doesn't also go back
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <div className="picker" ref={ref}>
      <button type="button" className={`picker-btn ${open ? 'open' : ''}`} aria-haspopup="listbox" aria-expanded={open} disabled={!!fixed} onClick={() => setOpen((o) => !o)}>
        <span className="picker-l">{label}</span>
        <span className="picker-v">{fixed ?? cur?.label ?? String(value)}</span>
        <svg className="chev" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="picker-menu" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={String(o.value)}
              role="option"
              aria-selected={o.value === value}
              className={o.value === value ? 'on' : ''}
              onClick={() => {
                sound.tick();
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="pm-l">{o.label}</span>
              {o.hint && <span className="pm-h">{o.hint}</span>}
            </button>
          ))}
          {footer && <div className="pm-foot">{footer}</div>}
        </div>
      )}
    </div>
  );
}
