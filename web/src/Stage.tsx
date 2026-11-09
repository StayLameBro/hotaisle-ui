import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildChip } from './iso/chip';
import { bezier, type View } from './camera';
import { FanLayer } from './iso/fanGL';
import { buildHall, PULL, SLOT_ORDER, type Hall, type Slot } from './iso/hall';
import type { Signal } from './signal';

/** What one of your machines is doing, as the drawing shows it. */
export type StageMode = 'choose' | 'claimed' | 'booting' | 'ready' | 'off' | 'ended';
export type StageMachine = { name: string; gpus: number; mode: StageMode; since?: number; host?: string };
export type StageState = {
  machines: StageMachine[]; // in launch order
  focus?: string; // the machine in focus: its server's tray is out
  preview?: number; // GPUs you are choosing, shown on a server with room
  readout: string;
  specTitle: string;
  spec: [string, string][];
};

export const NEW = '__new__'; // a server with room, for a machine whose server the API hasn't named yet
/** GPU slots fill from the front row, nearest end first: the ones you can see best. */
const FILL = [7, 6, 5, 4, 3, 2, 1, 0];
const WARM = 0.62;

/**
 * Where a new machine of n GPUs is drawn: next to your other machines, on the first of your servers with
 * room for it, as schedulers pack them; on a fresh server once those are full. The API names the real
 * server once the machine exists, and the drawing moves there if it differs.
 */
export function placeNew(machines: StageMachine[], n: number) {
  const used = new Map<string, number>();
  for (const m of machines) if (m.mode !== 'ended' && m.host && m.host !== NEW) used.set(m.host, (used.get(m.host) ?? 0) + m.gpus);
  for (const [h, u] of used) if (u + n <= 8) return h;
  return NEW;
}

type Owned = { machine: StageMachine; index: number };
type TagMode = 'ready' | 'starting' | 'off' | 'new';
type Tag = { host: string; names: string[]; gpus: number; mode: TagMode; focus: boolean; adding: number };
const TAG_STATE: Record<TagMode, string> = { ready: 'ready', starting: 'starting', off: 'off', new: 'once you launch' };
/** Which GPUs of each server belong to which of your machines. The API says which server; the slots are ours to draw. */
function layout(st: StageState) {
  const hosts = new Map<string, StageMachine[]>();
  for (const m of st.machines) {
    const h = m.host ?? NEW;
    if (!hosts.has(h)) hosts.set(h, []);
    hosts.get(h)!.push(m);
  }
  const preview = st.preview != null && !st.focus;
  const previewHost = preview ? placeNew(st.machines, st.preview!) : undefined;
  if (previewHost && !hosts.has(previewHost)) hosts.set(previewHost, []);
  const owned = new Map<string, Owned>(); // "host/slot" -> owner
  let previewSlots: number[] = [];
  for (const [h, ms] of hosts) {
    let next = 0;
    for (const m of ms) {
      if (m.mode === 'ended') continue;
      for (let i = 0; i < m.gpus && next < 8; i++) owned.set(`${h}/${FILL[next++]}`, { machine: m, index: i });
    }
    // an ended machine keeps its slots while its GPUs cool, unless someone is now using them
    for (const m of ms) {
      if (m.mode !== 'ended') continue;
      for (let i = 0; i < m.gpus && next < 8; i++) owned.set(`${h}/${FILL[next++]}`, { machine: m, index: i });
    }
    if (h === previewHost) previewSlots = FILL.filter((s) => !owned.has(`${h}/${s}`)).slice(0, st.preview ?? 0);
  }
  const focusMachine = st.machines.find((m) => m.name === st.focus);
  const focusHost = focusMachine ? (focusMachine.host ?? NEW) : (previewHost ?? [...hosts.keys()][0] ?? NEW);
  if (!hosts.has(focusHost)) hosts.set(focusHost, []);
  // Drawers out: every server with your machines on it (ended ones too, while their GPUs cool), and the one
  // a new machine would go to. The camera frames those, and while you choose a size the next free server
  // as well, so picking sizes never moves it: only the drawer that would hold the new machine comes out.
  // The camera goes to the machine you are looking at: its server, or, choosing a new machine, the server
  // it will go to. A size that fits next to your machines stays there; one that needs a server of its own
  // flies you to it. Your other servers keep their drawers out, and their tags point the way to them.
  const shown = preview ? previewHost! : focusHost;
  const frame = [shown];
  // One drawer out at a time: the server you are looking at. Pulled-out drawers stacked in one rack would
  // hide each other's GPUs; the tags show where the rest of your machines are.
  const out = [shown];
  // The next free server always keeps its place in the drawing (its drawer in, until it is needed), so
  // opening and closing the order never rebuilds the drawing in the middle of a move.
  if (!hosts.has(NEW)) hosts.set(NEW, []);
  // A tag on each of your servers, saying whose machines are on it and how they are doing.
  const tags: Tag[] = [];
  for (const [h, ms] of hosts) {
    const live = ms.filter((m) => m.mode !== 'ended');
    if (!live.length) continue;
    const mode: TagMode = live.some((m) => m.mode === 'booting' || m.mode === 'claimed') ? 'starting' : live.some((m) => m.mode === 'ready') ? 'ready' : 'off';
    tags.push({ host: h, names: live.map((m) => m.name), gpus: live.reduce((a, m) => a + m.gpus, 0), mode, focus: !preview && live.some((m) => m.name === st.focus), adding: h === previewHost ? st.preview! : 0 });
  }
  if (previewHost && !tags.some((t) => t.host === previewHost)) tags.push({ host: previewHost, names: [], gpus: 0, mode: 'new', focus: true, adding: st.preview! });
  return { hosts: [...hosts.keys()], owned, previewSlots, focusHost, focusMachine, out, frame, tags };
}

/** The view that takes in all of these servers, each with its drawer out. */
const framing = (hall: Hall, hosts: string[]): View => hall.frameOf(hosts) as View;

const PARTS: Record<string, string> = {
  gpu: 'AMD Instinct MI300X under its tower heatsink: 192 GB of HBM3 at 5.3 TB/s, 304 compute units, 750 W',
  baseboard: 'GPU baseboard (UBB 2.0, 417 × 585 mm). Every GPU links to the other seven over Infinity Fabric, 128 GB/s each pair',
  tray: 'GPU tray, pulled out of the rear of the server with its fan wall. It weighs about 30 kg; Dell has two people lift it',
  lift: 'Lifting handle on the baseboard',
  retimer: 'PCIe retimer under its own small heatsink, one of the links between the GPUs and the CPUs',
  fans: 'Ten GPU fan modules, the front of the tray. Together the server moves about 1,200 CFM of air into the hot aisle',
  server: 'Dell PowerEdge XE9680, seen from the rear: six power supplies over ten GPU fans. Inside: 8 MI300X, 2 Xeon CPUs, 2 TB of memory',
  pdu: 'Power distribution unit. Hot Aisle runs six per rack',
  switch: 'Top-of-rack network switch',
  blank: 'Blanking panels fill empty rack space, so hot exhaust cannot loop back to the cold side',
  cabinet: 'Rack cabinet, about 1.2 m deep. The servers face the cold aisle on the other side; you are in the hot aisle',
  patch: 'Fiber patch panel: MPO connectors with green boots, carrying the 400G GPU network (eight NICs per server)',
  ladder: 'Overhead ladder rack, carrying single-mode fiber between racks and to the network switches',
};

type Glide = { from: number; to: number; start: number; dur: number; ease: (t: number) => number };

export function Stage({ state, hold, entrance }: { state: StageState; hold: Signal<number>; entrance: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const front = useRef<SVGSVGElement>(null);
  const fanCanvas = useRef<HTMLCanvasElement>(null);
  const fanLayer = useRef<FanLayer | null>(null);
  const chip = useRef<SVGSVGElement>(null);
  const insp = useRef<HTMLDivElement>(null);
  const inspIn = useRef<HTMLDivElement>(null);
  const inspBox = useRef<number[] | null>(null);
  const tagSize = useRef(new Map<string, [number, number]>());
  const [size, setSize] = useState<{ w: number; h: number }>();
  const [hover, setHover] = useState('');
  const lay = layout(state);

  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => setSize((s) => (s && Math.abs(s.w - el.clientWidth) < 1 && Math.abs(s.h - el.clientHeight) < 1 ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Tray and fan-wall positions survive a rebuild (window resized, a server added), so nothing snaps.
  const kept = useRef(new Map<string, { pull: { x: number; v: number }; glide: Glide | null; to: number }>());
  // Each server keeps the place it was first given, so nothing jumps between racks as machines come and go.
  // The next free server (NEW) holds the free place nearest yours. When the API names a server new to the
  // drawing (a machine you just launched, or your machines' servers as the page loads), that server takes
  // over NEW's place, drawer and all, and NEW moves to the next free place: the machine stays where you
  // watched it go, and nothing slides out twice.
  const slots = useRef(new Map<string, number>());
  const hostKey = lay.hosts.join('|');
  const trays = useMemo(() => {
    const map = slots.current;
    for (const h of [...map.keys()]) if (!lay.hosts.includes(h)) map.delete(h);
    const free = () => {
      const used = new Set(map.values());
      const i = SLOT_ORDER.findIndex((_, j) => !used.has(j));
      return i < 0 ? map.size % SLOT_ORDER.length : i;
    };
    for (const h of lay.hosts) {
      if (h === NEW || map.has(h)) continue;
      if (map.has(NEW)) {
        map.set(h, map.get(NEW)!);
        map.delete(NEW);
        // a copy: the drawing being replaced may still run a frame with the old drawer's motion
        const motion = kept.current.get(NEW);
        if (motion && !kept.current.has(h)) kept.current.set(h, { pull: { ...motion.pull }, glide: motion.glide && { ...motion.glide }, to: motion.to });
        kept.current.delete(NEW);
      } else map.set(h, free());
    }
    if (lay.hosts.includes(NEW) && !map.has(NEW)) map.set(NEW, free());
    return lay.hosts.map((h) => ({ host: h, slot: SLOT_ORDER[map.get(h)!] as Slot }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey]);

  const narrow = (size?.w ?? 0) < 720;
  const hall = useMemo(() => {
    if (!size || size.w < 100 || size.h < 100) return undefined;
    const inset = narrow ? { left: 12, top: 12, right: 12, bottom: 40 } : { left: 336, top: 28, right: 28, bottom: 56 };
    return buildHall(size.w, size.h, inset, trays);
  }, [size, trays, narrow]);
  const chipSvg = useMemo(() => buildChip(260, 112), []);


  // each tag's size, for keeping it inside the plate; measured only when what it says changes
  const tagKey = JSON.stringify(lay.tags);
  useLayoutEffect(() => {
    box.current?.querySelectorAll<HTMLElement>('[data-tag]').forEach((el) => tagSize.current.set(el.dataset.tag!, [el.offsetWidth, el.offsetHeight]));
  }, [tagKey, narrow]);

  const live = useRef({ st: state, lay });
  live.current = { st: state, lay };
  // The drawing's loop sleeps when nothing is moving, and every change of state wakes it.
  const wake = useRef(() => {});
  useLayoutEffect(() => wake.current());
  const first = useRef(entrance);
  const camSpring = useRef<{ cx: { x: number; v: number }; cy: { x: number; v: number }; lw: { x: number; v: number }; aspect: number } | null>(null);
  const camKept = useRef<number[] | null>(null);
  const arrived = useRef(false); // the camera has reached your servers once; the tags come up then
  const frameKept = useRef('');
  const startCam = useMemo(() => {
    if (!hall) return [0, 0, 1, 1];
    const target = framing(hall, lay.frame);
    if (first.current && entrance) return hall.overview;
    const kept = camKept.current;
    return kept && Math.abs(kept[2] / kept[3] - target[2] / target[3]) < 0.01 ? kept : target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hall]);

  useEffect(() => {
    const root = svg.current;
    const fr = front.current;
    const canvas = fanCanvas.current;
    const plate = box.current;
    if (!hall || !root || !fr || !canvas || !plate) return;
    // the fans: one GPU layer for the whole row, made once and given each new drawing's fans
    if (!fanLayer.current) {
      try {
        fanLayer.current = new FanLayer(canvas);
      } catch (e) {
        // without WebGL 2 the fans are drawn still, by the drawing itself
        console.warn('Fan layer unavailable:', (e as Error).message);
        fanLayer.current = null;
      }
    }
    const fl = fanLayer.current?.ok ? fanLayer.current : null;
    plate.classList.toggle('gl', !!fl);
    // without the GPU layer there are no fans to show through the drawers' grilles: keep them solid
    if (!fl) fr.querySelectorAll('[mask]').forEach((m) => m.removeAttribute('mask'));
    fl?.setFans(hall.fans);
    fl?.resize(plate.clientWidth, plate.clientHeight);
    fl?.setColors(plate);
    const cageIndex = new Map(hall.cages.map((h, i) => [h, i]));
    const W = plate.clientWidth;
    const H = plate.clientHeight;
    // follow the theme
    const recolor = () => fl?.setColors(plate);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', recolor);
    const themeWatch = new MutationObserver(() => requestAnimationFrame(recolor));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    // only spin while the drawing is on screen
    let onScreen = true;
    const seen = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      if (onScreen) wake.current();
    });
    seen.observe(plate);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const gpus = new Map<string, SVGGElement>();
    fr.querySelectorAll<SVGGElement>('[data-gpu]').forEach((g) => gpus.set(g.dataset.gpu!, g));
    const heat = new Map<string, { x: number; v: number }>();
    gpus.forEach((_, id) => heat.set(id, { x: 0, v: 0 }));
    // Each of your servers' drawers (fan wall in front, GPU tray behind) glides out and back on a timed curve.
    // Its motion is kept outside the drawing, so a rebuild mid-glide doesn't restart it.
    const servers = Object.keys(hall.hosts).map((host) => {
      const m = kept.current.get(host) ?? { pull: { x: 0, v: 0 }, glide: null, to: -1 };
      kept.current.set(host, m);
      return Object.assign(m, { host, tray: fr.querySelector<SVGGElement>(`[data-tray="${host}"]`) });
    });
    const drawerOut = bezier(0.22, 0.9, 0.24, 1); // a firm pull, then a long glide to a stop
    const drawerIn = bezier(0.45, 0, 0.2, 1);
    const idleds = [...root.querySelectorAll<SVGCircleElement>('[data-idled]')];
    const xcds = [...(chip.current?.querySelectorAll<SVGGElement>('[data-xcd]') ?? [])];
    const hbms = [...(chip.current?.querySelectorAll<SVGGElement>('[data-hbm]') ?? [])];
    // Arriving, the camera starts on the whole row and travels in to your servers; the drawers come out as it lands.
    const target0: View = framing(hall, live.current.lay.frame);
    const arriving = first.current && !still.matches;
    // after a resize the old view box means nothing, so start from the new frame; otherwise keep the camera where it is
    const sameScale = camKept.current && Math.abs(camKept.current[2] / camKept.current[3] - target0[2] / target0[3]) < 0.01;
    const cam = (arriving ? hall.overview : sameScale ? camKept.current! : target0).map((v) => ({ x: v, v: 0 }));
    first.current = false;
    let last = 0;
    let frame = 0;
    let lastTarget: View = target0;
    // The camera frames your servers, and moves only when that set changes (a machine on a new server, the
    // last one on a server gone, the order opened or closed). It rides critically damped springs on its
    // centre and on the log of its width: zoom changes at an even perceived rate, nothing overshoots, and
    // when the target changes mid-move (the API naming a new machine's server, say) it bends toward the new
    // one without stopping first.
    const aspectOf = target0[3] / target0[2];
    const lens = (v: number[]) => ({ cx: { x: v[0] + v[2] / 2, v: 0 }, cy: { x: v[1] + v[3] / 2, v: 0 }, lw: { x: Math.log(v[2]), v: 0 } });
    // the camera's springs outlive a rebuild of the drawing, speed and all, unless the plate changed shape
    const keptCam = camSpring.current;
    const camS = keptCam && !arriving && Math.abs(keptCam.aspect - aspectOf) < 0.01 ? keptCam : { ...lens(cam.map((c) => c.x)), aspect: aspectOf };
    camSpring.current = camS;
    const arriveAt = arriving ? performance.now() + 160 : 0;
    const perf: number[] | null = location.hash === '#perf' ? ((window as unknown as { __frames: number[] }).__frames = []) : null;
    // A critically damped spring: no overshoot, no wobble, and it keeps its speed when the target moves.
    // It reports whether it is still moving; close enough, it lands exactly, so the loop can rest.
    const settle = (s: { x: number; v: number }, target: number, dt: number, seconds: number, eps = 1e-3) => {
      if (still.matches || (Math.abs(target - s.x) < eps && Math.abs(s.v) < eps * 4)) {
        const was = s.x !== target;
        s.x = target;
        s.v = 0;
        return was;
      }
      const w = 1 / seconds;
      for (let i = 0; i < 4; i++) {
        s.v += (w * w * (target - s.x) - 2 * w * s.v) * (dt / 4);
        s.x += s.v * (dt / 4);
      }
      return true;
    };
    // Only touch the drawing when a value really changes: every write repaints the whole figure.
    const written = new WeakMap<Element, Map<string, string>>();
    const put = (el: Element | null, name: string, value: string) => {
      if (!el) return;
      let m = written.get(el);
      if (!m) written.set(el, (m = new Map()));
      if (m.get(name) === value) return;
      m.set(name, value);
      if (name.startsWith('--')) (el as SVGElement).style.setProperty(name, value);
      else if (name.startsWith('style:')) (el as HTMLElement).style.setProperty(name.slice(6), value);
      else el.setAttribute(name, value);
    };
    // The loop: while something moves, it moves the drawing; while the fans turn, it draws them. With
    // neither (reduced motion, or the drawing scrolled away), it stops until something wakes it.
    let sleeping = false;
    let active = true;
    let restFrames = 0;
    wake.current = () => {
      active = true;
      restFrames = 0;
      if (!sleeping) return;
      sleeping = false;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    const unhold = hold.sub(() => wake.current());
    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      if (active) {
        restFrames = step(now, dt) ? 0 : restFrames + 1;
        if (restFrames > 2) active = false;
      }
      const spin = !!fl && !still.matches && onScreen;
      if (fl && (spin || active)) fl.draw(still.matches ? 0 : now / 1000);
      if (!active && !spin) {
        sleeping = true;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const step = (now: number, dt: number) => {
      const { st, lay } = live.current;
      const p = hold.get();
      let moving = false;
      // Between a new server appearing and the drawing being rebuilt with it, this drawing doesn't know
      // it: hold the camera's course rather than aim at the whole row for a frame.
      const known = lay.frame.every((h) => h in hall.hosts);
      const t = known ? framing(hall, lay.frame) : lastTarget;
      lastTarget = t;
      frameKept.current = lay.frame.join('|');
      const T = lens(t);
      const w = Math.exp(camS.lw.x);
      // arriving, a beat of stillness, then a slower, longer move in from the whole row
      const tau = arriveAt && now < arriveAt + 1700 ? 0.42 : 0.3;
      if (now >= arriveAt) {
        if (settle(camS.cx, T.cx.x, dt, tau, w * 1e-4)) moving = true;
        if (settle(camS.cy, T.cy.x, dt, tau, w * 1e-4)) moving = true;
        if (settle(camS.lw, T.lw.x, dt, tau, 1e-4)) moving = true;
      } else moving = true;
      const cw = Math.exp(camS.lw.x);
      const ch = cw * aspectOf;
      const view = [camS.cx.x - cw / 2, camS.cy.x - ch / 2, cw, ch];
      cam.forEach((c, i) => (c.x = view[i]));
      // the drawers come out as the camera arrives, not while it is still far off
      const settled = Math.abs(camS.lw.x - T.lw.x) < 0.25 && Math.hypot(camS.cx.x - T.cx.x, camS.cy.x - T.cy.x) < cw * 0.2;
      if (perf && moving) perf.push(dt * 1000);
      // #perf also logs each drawer's travel, frame by frame, to catch a drawer going out twice
      if (perf) ((window as unknown as { __pulls?: string[] }).__pulls ??= []).push(`${Math.round(now)} ${servers.map((s) => `${s.host}:${s.pull.x.toFixed(0)}`).join(' ')}`);
      const vb = cam.map((c) => c.x.toFixed(2)).join(' ');
      put(root, 'viewBox', vb);
      put(fr, 'viewBox', vb);
      fl?.setCamera(cam.map((c) => c.x));
      camKept.current = cam.map((c) => c.x);
      // the drawers: out for your servers, in for the rest. Several starting together go out one after another.
      const [yx, yy] = hall.perY;
      // A drawer comes out once the camera has arrived, and once moving out it carries on even if the
      // camera is sent somewhere close by: only leaving the drawing's focus sends it back in.
      const outNow = new Set(lay.out);
      if (settled) arrived.current = true;
      let started = 0;
      for (const s of servers) {
        const target = outNow.has(s.host) && (settled || s.to === PULL) ? PULL : 0;
        if (target !== s.to) {
          const goingOut = target > s.pull.x;
          const dist = Math.abs(target - s.pull.x) / PULL;
          s.glide = { from: s.pull.x, to: target, start: now + (goingOut ? started++ * 90 : 0), dur: (goingOut ? 820 : 600) * Math.max(0.45, Math.sqrt(dist)), ease: goingOut ? drawerOut : drawerIn };
          s.to = target;
        }
        if (s.glide) {
          const g = s.glide;
          const k = still.matches ? 1 : Math.min(1, Math.max(0, (now - g.start) / g.dur));
          s.pull.x = g.from + (g.to - g.from) * g.ease(k);
          moving = true;
          if (k >= 1) s.glide = null;
        }
        const off = s.pull.x - PULL;
        if (s.tray) put(s.tray, 'transform', `translate(${(yx * off).toFixed(2)} ${(yy * off).toFixed(2)})`);
        fl?.setOffset(cageIndex.get(s.host) ?? -1, yx * s.pull.x, yy * s.pull.x);
      }
      // The tags ride on their servers' drawers. One whose server is out of view waits at the edge of the
      // plate, pointing toward it; tags never cover the inspector or each other.
      const sc = Math.min(W / view[2], H / view[3]);
      const ox = (W - view[2] * sc) / 2 - view[0] * sc;
      const oy = (H - view[3] * sc) / 2 - view[1] * sc;
      const ins = inspBox.current;
      const placed: number[][] = [];
      plate.querySelectorAll<HTMLElement>('[data-tag]').forEach((el) => {
        const host = el.dataset.tag!;
        const a = hall.anchors[host];
        if (!a) return;
        // The tag is fixed to its drawer's front and moves with it, in the same frame as the drawer itself.
        const pull = kept.current.get(host)?.pull.x ?? 0;
        const px = (a[0] + yx * pull) * sc + ox;
        const py = (a[1] + yy * pull) * sc + oy;
        const [tw, th] = tagSize.current.get(host) ?? [160, 44];
        const M = 14;
        const x = px - tw / 2;
        const y = py - 14 - th;
        const clampX = (v: number) => Math.min(W - M - tw, Math.max(M, v));
        const clampY = (v: number) => Math.min(H - 40 - th, Math.max(M, v));
        let cx = clampX(x);
        let cy = clampY(y);
        const hits = (b: number[], pad: number) => cx < b[0] + b[2] + pad && cx + tw > b[0] - pad && cy < b[1] + b[3] + pad && cy + th > b[1] - pad;
        if (ins && hits(ins, 10)) {
          if (ins[0] + ins[2] + 10 + tw <= W - M) cx = ins[0] + ins[2] + 10;
          else cy = clampY(ins[1] + ins[3] + 10);
        }
        for (const b of placed) if (hits(b, 6)) cy = clampY(b[1] + b[3] + 6);
        placed.push([cx, cy, tw, th]);
        const off = Math.abs(cx - x) > 2 || Math.abs(cy - y) > 2;
        // Placed by fractions of a pixel, always: snapped to whole pixels it would shimmy as x and y stepped
        // on different frames, and hop when it came to rest. Not on its own GPU layer, so its text is
        // drawn sharp wherever it lands.
        const at = (v: number) => v.toFixed(2);
        put(el, 'style:transform', `translate(${at(cx)}px, ${at(cy)}px)`);
        put(el, 'data-off', String(off));
        if (off) put(el, '--a', `${Math.atan2(py - (cy + th / 2), px - (cx + tw / 2)).toFixed(2)}rad`);
        put(el, 'data-shown', String(still.matches || arrived.current));
      });
      // GPUs: whose they are, how warm, what the light says
      gpus.forEach((el, id) => {
        const host = id.slice(0, id.lastIndexOf('/'));
        const slot = Number(id.slice(id.lastIndexOf('/') + 1));
        const own = lay.owned.get(id);
        const pv = host === lay.focusHost ? lay.previewSlots.indexOf(slot) : -1;
        const m = own?.machine;
        const live = !!m && m.mode !== 'ended';
        let target = 0;
        let led = 'off';
        if (m) {
          const age = m.since ? (Date.now() - m.since) / 1000 : 0;
          if (m.mode === 'claimed') target = 0.22;
          if (m.mode === 'booting') target = 0.14 + (WARM - 0.14) * (1 - Math.exp(-Math.max(0, age - own!.index * 0.5) / 24));
          if (m.mode === 'ready') target = WARM;
          led = m.mode === 'booting' || m.mode === 'claimed' ? 'blink' : m.mode === 'ready' ? 'on' : 'off';
        }
        const claimed = pv >= 0 && p > (pv + 0.5) / Math.max(1, lay.previewSlots.length);
        if (claimed) target = 0.22;
        const h = heat.get(id)!;
        if (settle(h, target, dt, m?.mode === 'ended' || m?.mode === 'off' ? 1.4 : claimed ? 0.1 : 0.8)) moving = true;
        put(el, '--h', h.x.toFixed(2));
        const who = live ? (m!.name === st.focus ? 'focus' : 'mine') : pv >= 0 ? 'preview' : '';
        if (el.dataset.who !== who) el.dataset.who = who;
        if (el.dataset.led !== led) el.dataset.led = led;
      });
      const running = new Set(st.machines.filter((m) => m.mode !== 'ended' && m.host).map((m) => m.host!));
      idleds.forEach((c) => {
        const on = String(running.has(c.dataset.idled ?? ''));
        if (c.dataset.on !== on) c.dataset.on = on;
      });
      // the chip close-up: compute dies come up as the machine boots, memory once it is ready
      const fm = lay.focusMachine;
      const prog = !fm ? 0 : fm.mode === 'ready' ? 1 : fm.mode === 'booting' ? 1 - Math.exp(-((Date.now() - (fm.since ?? Date.now())) / 1000) / 16) : 0;
      const litX = Math.round(prog * 8);
      xcds.forEach((g, i) => {
        const on = String(i < litX);
        if (g.dataset.on !== on) g.dataset.on = on;
      });
      hbms.forEach((g) => {
        const on = String(fm?.mode === 'ready');
        if (g.dataset.on !== on) g.dataset.on = on;
      });
      // a booting machine warms on a clock, so it keeps the loop awake
      if (fm?.mode === 'booting' || st.machines.some((m) => m.mode === 'booting' || m.mode === 'claimed')) moving = true;
      return moving;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      unhold();
      seen.disconnect();
      themeWatch.disconnect();
      scheme.removeEventListener('change', recolor);
      wake.current = () => {};
    };
  }, [hall, hold]);

  const onMove = (e: React.PointerEvent) => {
    const el = (e.target as Element).closest<SVGElement>('[data-part]');
    const part = el?.dataset.part ?? '';
    let text = part ? (PARTS[part] ?? '') : '';
    if (part === 'gpu' && el) {
      const own = lay.owned.get(el.dataset.gpu!);
      if (own && own.machine.mode !== 'ended') {
        const n = own.machine.gpus;
        text = `GPU ${own.index} of ${own.machine.name}. MI300X, 192 GB HBM3 at 5.3 TB/s.${n > 1 ? ` Linked to your other ${n - 1} GPU${n > 2 ? 's' : ''} over Infinity Fabric, 128 GB/s each pair` : ''}`;
      } else if (el.dataset.who === 'preview') text = `Would be one of your GPUs once you launch. ${PARTS.gpu}`;
      else text = "MI300X. Not yours: another customer's, or free";
    }
    if (part === 'server-yours' && el) {
      const host = el.dataset.host ?? '';
      const ms = state.machines.filter((m) => (m.host ?? NEW) === host && m.mode !== 'ended').map((m) => m.name);
      text = host === NEW ? 'The next server with room, where a new machine would go' : `Server ${host}, running ${ms.join(' and ') || 'nothing of yours now'}${host === lay.focusHost ? '' : '. Click to show it'}`;
    }
    box.current?.querySelectorAll('[data-hover]').forEach((n) => n !== el && n.removeAttribute('data-hover'));
    if (el && part === 'gpu') el.setAttribute('data-hover', '');
    setHover(text);
  };
  const onLeave = () => {
    box.current?.querySelectorAll('[data-hover]').forEach((n) => n.removeAttribute('data-hover'));
    setHover('');
  };
  const onClick = (e: React.MouseEvent) => {
    const el = (e.target as Element).closest<SVGElement>('[data-part="server-yours"]');
    const host = el?.dataset.host;
    if (!host || host === lay.focusHost) return;
    const m = state.machines.find((x) => (x.host ?? NEW) === host && x.mode !== 'ended');
    if (m) window.dispatchEvent(new CustomEvent('stage-focus', { detail: m.name }));
  };

  // The inspector's length follows what it describes; it glides there instead of snapping.
  useLayoutEffect(() => {
    const outer = insp.current;
    const inner = inspIn.current;
    if (!outer || !inner) return;
    const fit = () => {
      outer.style.height = `${inner.offsetHeight}px`;
      inspBox.current = [outer.offsetLeft, outer.offsetTop, outer.offsetWidth, inner.offsetHeight];
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [narrow]);

  return (
    <section className={`stage ${entrance ? 'entering' : ''}`} aria-label="Drawing of the servers">
      <div className="plate" ref={box} onPointerMove={onMove} onPointerLeave={onLeave} onClick={onClick}>
        {hall && (
          <>
            <svg
              ref={svg}
              className="iso-svg fig"
              viewBox={startCam.join(' ')}
              role="img"
              aria-label={`A row of Dell PowerEdge XE9680 servers seen from the hot aisle, with a GPU tray pulled out. ${state.readout}`}
              dangerouslySetInnerHTML={{ __html: `<defs>${hall.defs}</defs>${hall.svg}` }}
            />
            <canvas ref={fanCanvas} className="fans" aria-hidden="true" />
            <svg ref={front} className="iso-svg fig front" viewBox={startCam.join(' ')} aria-hidden="true" dangerouslySetInnerHTML={{ __html: hall.front }} />
          </>
        )}
        {!narrow && (
          <div className="inspector" ref={insp}>
            <div className="insp-in" ref={inspIn}>
              <svg ref={chip} className="iso-svg chip" viewBox="0 0 260 112" aria-hidden="true" dangerouslySetInnerHTML={{ __html: chipSvg }} />
              <p className="spec-t">{state.specTitle}</p>
              <dl>
                {state.spec.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}
        <div className="tags">
          {lay.tags.map((t) => {
            const name = t.mode === 'new' ? 'Your new machine' : t.names.length > 1 ? `${t.names[0]} and ${t.names.length - 1} more` : t.names[0];
            const gpus = t.mode === 'new' ? `${t.adding} of 8 GPUs` : `${t.gpus} of 8 GPUs`;
            const extra = t.mode !== 'new' && t.adding ? `, +${t.adding} new` : '';
            const say = `${name}: ${gpus}, ${TAG_STATE[t.mode]}${extra}`;
            const go = () => window.dispatchEvent(new CustomEvent('stage-focus', { detail: t.names[0] }));
            return (
              <button
                key={t.host}
                type="button"
                className={`ytag ${t.mode}${t.focus ? ' focus' : ''}`}
                data-tag={t.host}
                data-shown="false"
                title={t.names.length > 1 ? t.names.join(', ') : undefined}
                aria-label={t.mode === 'new' || t.focus ? say : `${say}. Show it`}
                tabIndex={t.mode === 'new' || t.focus ? -1 : 0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (t.mode !== 'new' && !t.focus) go();
                }}
              >
                <i className="ytag-arrow" aria-hidden="true" />
                <i className="ytag-dot" aria-hidden="true" />
                <span className="ytag-name">{name}</span>
                <span className="ytag-sub">
                  {gpus}, {TAG_STATE[t.mode]}
                  {extra}
                </span>
              </button>
            );
          })}
        </div>
        <span className={`corner bl ${hover ? 'gone' : ''}`}>Point at any part to see what it is</span>
        <span className="corner br">
          <span key={hover || state.readout} className="swap">
            {hover || state.readout}
          </span>
        </span>
      </div>
    </section>
  );
}
