import { getPrefs } from './prefs';

// Small synthesized sounds, so the keys feel like keys. No audio files; nothing plays unless the
// person has interacted with the page, and Settings turns it all off.
let ctx: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (!getPrefs().sound) return undefined;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return undefined;
    ctx = new C();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function env(c: AudioContext, peak: number, attack: number, decay: number, at = c.currentTime) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  g.connect(c.destination);
  return g;
}

function noise(c: AudioContext, ms: number, freq: number, peak: number, at = c.currentTime) {
  const len = Math.floor((c.sampleRate * ms) / 1000);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 1.1;
  const g = c.createGain();
  g.gain.value = peak;
  src.connect(bp).connect(g).connect(c.destination);
  src.start(at);
}

function tone(c: AudioContext, from: number, to: number, peak: number, decay: number, at = c.currentTime, type: OscillatorType = 'sine') {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, at);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, at + decay);
  o.connect(env(c, peak, 0.004, decay, at));
  o.start(at);
  o.stop(at + decay + 0.05);
}

export const sound = {
  /** A round key going down. */
  key() {
    const c = audio();
    if (!c) return;
    noise(c, 14, 2600, 0.22);
    tone(c, 190, 120, 0.09, 0.05);
  },
  /** A small key. */
  tick() {
    const c = audio();
    if (!c) return;
    noise(c, 8, 3800, 0.12);
  },
  /** Launch confirmed: a soft, low thunk. */
  thunk() {
    const c = audio();
    if (!c) return;
    noise(c, 18, 1800, 0.2);
    tone(c, 120, 62, 0.28, 0.22);
  },
  /** A machine is ready: two gentle notes. */
  chime() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime;
    tone(c, 880, 880, 0.05, 0.55, t, 'triangle');
    tone(c, 1318.5, 1318.5, 0.045, 0.7, t + 0.11, 'triangle');
  },
  /** Released: one note, falling. */
  drop() {
    const c = audio();
    if (!c) return;
    tone(c, 392, 262, 0.06, 0.32, c.currentTime, 'triangle');
  },
};
