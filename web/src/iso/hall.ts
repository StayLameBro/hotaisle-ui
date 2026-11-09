// The figure: a row of racks seen from the hot aisle, the side Hot Aisle is named after.
// Each rack holds four Dell PowerEdge XE9680 servers (6U) and a top-of-rack switch, with blanking panels
// in the empty units and three power distribution units down each side (Hot Aisle runs six per rack).
// Seen from the rear, an XE9680 has six power supplies and its I/O across the top 2U and ten GPU fan
// modules across the bottom 4U (Dell XE9680 Technical Guide, figure 3). To service the GPUs, the fan
// wall comes off and the GPU tray slides out of the rear (Dell XE9680 Installation and Service Manual).
// That is the pose used for the servers your machines run on.
//
// The tray is drawn to the OAM spec: a 417 x 585 mm universal baseboard carrying eight 102 x 165 mm
// OAM modules in two rows of four, each under a finned heatsink. Units are centimetres. x runs along
// the row, y comes out of the racks toward you (into the hot aisle), z is up. Rack rears sit at y = 0.
//
// Live parts carry data attributes, so the page can move them without rebuilding:
//   [data-tray="<host>"]   the GPU tray of a server, translated along +y to slide it out
//   [data-cage="<host>"]   its fan wall, moved out and up out of the way before the tray comes out
//   [data-gpu="<host>/<slot>"]  one OAM module and its heatsink
//   [data-idled="<host>"]  the server's System ID light, lit for servers running your machines
//   [data-part]            what the pointer is over
// Fans: the drawing is static, so it is painted once. The fans of every server in the row are handed
// to the page as positions (Hall.fans), and the page spins each on its own GPU layer, which costs no
// repainting. Only the fan walls of your servers, which move, keep their blades in the drawing.
import * as k from './kit';

type P3 = k.Point3;
const S = k.solidSvg;
const L = k.lineSvg;

export const AZIMUTH = 58;
export const ELEVATION = 36;

const RACKS = [-2, -1, 0, 1, 2];
const PITCH = 80; // rack width (800 mm racks: room for three PDUs a side)
const SERVER = { w: 48.2, h: 26.67, x0: 15.9 }; // 6U, 482 mm wide, offset inside its rack
const BASE = 10; // plinth under the lowest server
const SLOTS = 4; // XE9680s per rack
const SWITCH_Z = BASE + SLOTS * SERVER.h + 4.4;
const TOP = 206; // top of the rack frame
const DEPTH = 110; // how far the cabinets run back from their rear posts
const BAY = { x0: 0.7, x1: 47.5, z0: 0.5, z1: 17.4 }; // the 4U GPU bay at the bottom of the rear, server-local
const TRAY = { w: 45.6, len: 64, pull: 54, frame: 12.6 };
const UBB = { w: 41.7, d: 58.5 };
const OAM = { w: 10.2, d: 16.5 };
const SINK = { h: 13 }; // module top to fin-stack top: about 145 mm with the module and handle
/** The fan wall is a box 8 cm deep. On your servers it is drawn as the front of the GPU tray, a drawer front. */
const CAGE_DEPTH = 8;
/** A GPU fan module's face: size, pitch along the wall, and the half-size of its grille. */
const MOD = { w: 9.1, h: 8.3, pitch: 9.4, gx: 4.05, gy: 2.95 };

export type Slot = { rack: number; level: number };
/**
 * Where servers holding your machines are drawn, in order: mid-height in the centre rack first, then the
 * same height in the racks on either side, then the row above. Your next server is the free one nearest
 * those you have, never one across an empty rack. Neighbours sit side by side rather than stacked, because
 * an open drawer would hide the server right under it.
 */
export const SLOT_ORDER: Slot[] = [
  { rack: 0, level: 1 },
  { rack: 1, level: 1 },
  { rack: -1, level: 1 },
  { rack: 0, level: 2 },
  { rack: 1, level: 2 },
  { rack: -1, level: 2 },
  { rack: 2, level: 1 },
  { rack: -2, level: 1 },
]

export type Frame = [number, number, number, number];
/**
 * One spinning fan, for the GPU layer. `m` maps the fan's own face coordinates onto the drawing (a, b, c, d, e, f):
 * centimetres for a GPU fan module (kind 0, drawn with its square grille), the guard's radius for a round
 * power supply or switch fan (kinds 1 and 2). `cage` is the index of the fan wall it rides on, or -1.
 */
export type Fan = { m: number[]; kind: 0 | 1 | 2; spin: number; phase: number; cage: number };
export type Hall = {
  /** The row: static. */
  svg: string;
  defs: string;
  /** Your servers' fan walls and GPU trays, drawn over the fans. */
  front: string;
  fans: Fan[];
  /** Your servers, in the order their fan walls are indexed by Fan.cage. */
  cages: string[];
  /** Screen vectors of one centimetre along y (out of the rack) and z (up). */
  perY: k.Flat;
  perZ: k.Flat;
  /** The view box that frames each host's pulled-out tray, and one that takes in the whole row. */
  hosts: Record<string, Frame>;
  /** Where a server's name tag points: the top of its drawer front, drawer in. Add perY × pull for the drawer. */
  anchors: Record<string, [number, number]>;
  overview: Frame;
  /** The view box that frames several hosts with their drawers out, clear of the inspector. */
  frameOf: (hosts: string[]) => Frame;
};

const plan = (x: number, y: number, w: number, d: number, r = 0.3): k.Plan => ({ x, y, w, d, r });
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * Small shapes on a face, merged into one path per kind (class). A server face has a few hundred of them;
 * as separate elements they make every frame of a camera move expensive, as one path each they cost little.
 */
class Shapes {
  private d = new Map<string, string[]>();
  rect(cls: string, x: number, y: number, w: number, h: number, r = 0) {
    const q = Math.min(r, w / 2, h / 2);
    const list = this.d.get(cls) ?? this.d.set(cls, []).get(cls)!;
    if (q <= 0) list.push(`M${fmt(x)} ${fmt(y)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}z`);
    else list.push(`M${fmt(x + q)} ${fmt(y)}h${fmt(w - 2 * q)}a${fmt(q)} ${fmt(q)} 0 0 1 ${fmt(q)} ${fmt(q)}v${fmt(h - 2 * q)}a${fmt(q)} ${fmt(q)} 0 0 1 ${fmt(-q)} ${fmt(q)}h${fmt(2 * q - w)}a${fmt(q)} ${fmt(q)} 0 0 1 ${fmt(-q)} ${fmt(-q)}v${fmt(2 * q - h)}a${fmt(q)} ${fmt(q)} 0 0 1 ${fmt(q)} ${fmt(-q)}z`);
    return this;
  }
  circle(cls: string, cx: number, cy: number, r: number) {
    const list = this.d.get(cls) ?? this.d.set(cls, []).get(cls)!;
    list.push(`M${fmt(cx - r)} ${fmt(cy)}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0z`);
    return this;
  }
  /** In drawing order: the kinds listed first are painted first. */
  svg(order: string[]) {
    const keys = [...order.filter((k) => this.d.has(k)), ...[...this.d.keys()].filter((k) => !order.includes(k))];
    return keys.map((k) => `<path class="${k}" d="${this.d.get(k)!.join('')}"/>`).join('');
  }
}
const FACE_ORDER = ['fan-face', 'fan-hole', 'psu-face', 'io', 'grille', 'recess', 'inlet', 'grip', 'tab', 'latch', 'port', 'pin'];

/** A rectangle in the plane y = const, as a path. */
function faceY(x0: number, x1: number, z0: number, z1: number, y: number, P: k.Projection) {
  return k.pathOf([k.iso([x0, y, z0], P), k.iso([x1, y, z0], P), k.iso([x1, y, z1], P), k.iso([x0, y, z1], P)], true);
}

/** Swept fan blades around the origin, in a face's own 2D coordinates. */
export function blades(r: number, count: number) {
  const out: string[] = [];
  const hub = r * 0.32;
  for (let b = 0; b < count; b++) {
    const a0 = (b / count) * Math.PI * 2;
    const pt = (rr: number, a: number) => `${fmt(Math.cos(a) * rr)} ${fmt(Math.sin(a) * rr)}`;
    const sweep = (Math.PI * 2) / count;
    out.push(`M${pt(hub, a0)}Q${pt(r * 0.75, a0 + sweep * 0.25)} ${pt(r * 0.96, a0 + sweep * 0.7)}L${pt(r * 0.96, a0 + sweep * 1.05)}Q${pt(r * 0.66, a0 + sweep * 0.78)} ${pt(hub, a0 + sweep * 0.56)}Z`);
  }
  return `<path d="${out.join('')}"/>`;
}


export function buildHall(w: number, h: number, inset: { left: number; top: number; right: number; bottom: number }, trays: { host: string; slot: Slot }[]): Hall {
  // One projection for the whole row; the page pans and zooms by moving the view box.
  const P: k.Projection = { origin: [0, 0], scale: 4, azimuth: AZIMUTH, elevation: ELEVATION };
  const at = (rack: number, level: number) => ({ x: rack * PITCH + SERVER.x0, z: BASE + level * SERVER.h });
  const trayAt = new Map(trays.map((t) => [`${t.slot.rack}/${t.slot.level}`, t.host]));
  // A fan on a rear face (the plane y = 0), centred at (x, z). Its face coordinates run along the row and down.
  const fans: Fan[] = [];
  const cages: string[] = [];
  const along = k.axisVector(P, [1, 0, 0]);
  const down = k.axisVector(P, [0, 0, -1]);
  const spot = (x: number, z: number, kind: Fan['kind'], scale = 1, cage = -1) => {
    const [cx, cy] = k.iso([x, 0, z], P);
    const n = fans.length;
    // speeds and starting angles vary a little, so a wall of fans never turns in lockstep
    const spin = kind === 0 ? 0.62 + ((n * 37) % 11) * 0.02 : 0.38 + ((n * 17) % 7) * 0.018;
    const m = [along[0] * scale, along[1] * scale, down[0] * scale, down[1] * scale, cx, cy].map((v) => Math.round(v * 10000) / 10000);
    fans.push({ m, kind, spin, phase: ((n * 61) % 97) / 97, cage });
  };

  const ax = k.axisVector(P, [1, 0, 0]);
  const ay = k.axisVector(P, [0, 1, 0]);
  const az = k.axisVector(P, [0, 0, -1]);
  const pm = (u: k.Flat, v: k.Flat) => `matrix(${[u[0], u[1], v[0], v[1], 0, 0].map((n) => Math.round(n * 10000) / 10000).join(' ')})`;
  const trayDefs =
    // fin edges seen on a face across the airflow (plane y) and along it (plane x): a 2.6 mm pitch
    `<pattern id="fins-y" patternUnits="userSpaceOnUse" width="20" height="0.26" patternTransform="${pm(ax, az)}"><rect class="fin-edge" width="20" height="0.085"/></pattern>` +
    `<pattern id="fins-x" patternUnits="userSpaceOnUse" width="20" height="0.26" patternTransform="${pm(ay, az)}"><rect class="fin-edge" width="20" height="0.085"/></pattern>` +
    // the base band's vertical fins
    `<pattern id="vfins-y" patternUnits="userSpaceOnUse" width="0.32" height="20" patternTransform="${pm(ax, az)}"><rect class="fin-edge" width="0.1" height="20"/></pattern>` +
    `<pattern id="vfins-x" patternUnits="userSpaceOnUse" width="0.32" height="20" patternTransform="${pm(ay, az)}"><rect class="fin-edge" width="0.1" height="20"/></pattern>` +
    // the tray walls are perforated
    `<pattern id="perf-x" patternUnits="userSpaceOnUse" width="0.9" height="0.9" patternTransform="${pm(ay, az)}"><circle class="perf" cx="0.45" cy="0.45" r="0.2"/></pattern>`;
  const faceX = (x: number, y0: number, y1: number, z0: number, z1: number) => k.pathOf([k.iso([x, y0, z0], P), k.iso([x, y1, z0], P), k.iso([x, y1, z1], P), k.iso([x, y0, z1], P)], true);
  const faceYp = (y: number, x0: number, x1: number, z0: number, z1: number) => faceY(x0, x1, z0, z1, y, P);
  const topQuad = (x: number, y: number, w: number, d: number, z: number) => k.onTop([[x, y], [x + w, y], [x + w, y + d], [x, y + d]], z, P, true);

  const back: string[] = [];
  const trayLayers: { host: string; rack: number; level: number; svg: string }[] = [];

  // ---------------------------------------------------------------- the aisle floor: 600 mm tiles
  const x0 = RACKS[0] * PITCH - 40;
  const x1 = (RACKS[RACKS.length - 1] + 1) * PITCH + 40;
  const tiles: string[] = [];
  for (let y = 0; y <= 180; y += 60) tiles.push(k.lineOnTop([x0, y], [x1, y], 0, P));
  for (let x = Math.ceil(x0 / 60) * 60; x <= x1; x += 60) tiles.push(k.lineOnTop([x, 0], [x, 180], 0, P));
  back.push(`<g data-part="floor"><path class="floor" d="${k.onTop([[x0, 0], [x1, 0], [x1, 180], [x0, 180]], 0, P, true)}"/>${L(tiles.join(''), { tone: 'faint' })}</g>`);

  // ---------------------------------------------------------------- racks, left to right (nearer as x grows)
  for (const rack of RACKS) {
    const rx = rack * PITCH;
    // frame upright on the rack's left, shared with the rack before it
    back.push(S(k.slabOf(plan(rx - 0.7, -3, 1.4, 3, 0.2), 0, TOP + 6, P, 2, 0.3), { tone: 'mid', crease: 'faint' }));
    // three zero-U PDUs down each side, with their outlet columns and a meter at the top
    for (const px of [rx + 1.6, rx + 5.6, rx + 9.6, rx + 66.8, rx + 70.8, rx + 74.8]) {
      const pd = plan(px, -5.4, 3.2, 5.4, 0.3);
      const outlets: P3[] = [];
      for (let z = 22; z < 190; z += 6.4) outlets.push([px + 1.6, 0, z]);
      const inner = k.dotsSvg(k.pointsAt(outlets, P), { size: 0.9, tone: 'lo' }) + L(faceY(px + 0.6, px + 2.6, 194, 199, 0, P), { tone: 'lo' });
      back.push(`<g data-part="pdu">${S(k.slabOf(pd, 4, TOP - 4, P, 2, 0.3), { tone: 'mid', crease: 'faint', inner })}</g>`);
    }
    // the rack's rear posts, with their square holes
    for (const [p0, p1] of [[13.2, 15.2], [64.8, 66.8]]) {
      const holes: P3[] = [];
      for (let z = 6; z < TOP - 2; z += 4.445 / 3) holes.push([rx + (p0 + p1) / 2, 0, z]);
      back.push(S(k.slabOf(plan(rx + p0, -3, p1 - p0, 3, 0.15), 2, TOP - 2, P, 2, 0.3), { tone: 'mid', crease: 'faint', inner: k.dotsSvg(k.pointsAt(holes, P), { size: 0.5, tone: 'lo' }) }));
    }
    // the cabinet's roof, running back over the servers (cabinets are about 1.2 m deep), with two brush
    // strip openings where cables come down, and the plinth
    const roof = plan(rx, -DEPTH, PITCH, DEPTH, 0.3);
    const brushes = [12, 52].map((bx) => k.onTop([[rx + bx, -DEPTH + 18], [rx + bx + 16, -DEPTH + 18], [rx + bx + 16, -DEPTH + 26], [rx + bx, -DEPTH + 26]], TOP + 4, P, true)).join('');
    back.push(`<g data-part="cabinet">${S(k.slabOf(roof, TOP, 4, P, 2, 0.3), { tone: 'mid', crease: 'faint', inner: `<path class="brush" d="${brushes}"/>` })}</g>`);
    // the end of the row: a cabinet side panel, the whole depth and height
    if (rack === RACKS[RACKS.length - 1]) back.push(`<g data-part="cabinet">${S(k.slabOf(plan(rx + PITCH - 1.2, -DEPTH, 1.2, DEPTH, 0.2), 0, TOP, P, 1, 0.3), { tone: 'mid', crease: 'faint' })}</g>`);
    back.push(S(k.slabOf(plan(rx + 13.2, -6, 53.6, 6, 0.3), 0, BASE - 0.3, P, 2, 0.4), { tone: 'lo', crease: 'faint' }));
    // top-of-rack switch, seen from its rear: two power supplies and its fans
    const sw = at(rack, 0).x;
    const swFace = k.slabOf(plan(sw, -1.4, SERVER.w, 1.4, 0.2), SWITCH_Z, 8.6, P, 2, 0.4);
    let swFans = '';
    for (let i = 0; i < 5; i++) {
      swFans += `<circle class="fan-hole" cx="${fmt(20.2 + i * 5.4)}" cy="4.3" r="2.1"/>`;
      spot(sw + 20.2 + i * 5.4, SWITCH_Z + 8.6 - 4.3, 2, 2.1);
    }
    back.push(`<g data-part="switch">${S(swFace, { tone: 'mid', crease: 'faint', inner: `<g transform="${k.sideMatrix([sw, 0], SWITCH_Z + 8.6, P, 'left')}">${swFans}<rect x="2" y="2" width="6.4" height="4.6" rx="0.3" class="psu-face"/><rect x="${fmt(SERVER.w - 8.4)}" y="2" width="6.4" height="4.6" rx="0.3" class="psu-face"/></g>` })}</g>`);
    // over the switch: the fiber patch panel (MPO connectors with green boots, as in Hot Aisle's rack photos)
    // and a cable manager; above them, blanking panels, so hot air can't loop back to the front
    const pz = SWITCH_Z + 8.9;
    const patch = k.slabOf(plan(sw, -1.6, SERVER.w, 1.6, 0.2), pz, 8.9 - 0.2, P, 2, 0.3);
    const boots: P3[] = [];
    for (let i = 0; i < 12; i++) boots.push([sw + 6 + i * 3.2, 0, pz + 5.6], [sw + 6 + i * 3.2, 0, pz + 3]);
    const pm = k.sideMatrix([sw, 0], pz + 8.7, P, 'left');
    back.push(`<g data-part="patch">${S(patch, { tone: 'mid', crease: 'faint', inner: `<g transform="${pm}"><rect class="port" x="4.6" y="1.6" width="${fmt(SERVER.w - 9.2)}" height="5.4" rx="0.3"/></g><path class="boots" d="${boots.map((b) => { const [cx, cy] = k.iso(b, P); return `M${fmt(cx - 1.1)} ${fmt(cy)}a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0`; }).join('')}"/>` })}</g>`);
    const cz = pz + 8.9;
    back.push(`<g data-part="blank">${S(k.slabOf(plan(sw, -2.6, SERVER.w, 2.6, 0.3), cz, 4.245, P, 2, 0.3), { tone: 'mid', crease: 'faint', inner: `<g transform="${k.sideMatrix([sw, 0], cz + 4.245, P, 'left')}"><rect class="port" x="3" y="1.6" width="${fmt(SERVER.w - 6)}" height="1.1" rx="0.5"/></g>` })}</g>`);
    // blanking panels: a few large ones, each with one shallow groove and its four screws
    const bz0 = cz + 4.445;
    const per = (TOP - bz0) / 3;
    for (let i = 0; i < 3; i++) {
      const z0 = bz0 + i * per;
      const screws: P3[] = [[sw + 1.2, 0, z0 + 1.2], [sw + SERVER.w - 1.2, 0, z0 + 1.2], [sw + 1.2, 0, z0 + per - 1.4], [sw + SERVER.w - 1.2, 0, z0 + per - 1.4]];
      back.push(`<g data-part="blank">${S(k.slabOf(plan(sw, -0.8, SERVER.w, 0.8, 0.15), z0 + 0.1, per - 0.2, P, 2, 0.3), { tone: 'mid', crease: 'faint', inner: L(k.segment([sw + 4, 0, z0 + per / 2], [sw + SERVER.w - 4, 0, z0 + per / 2], P), { tone: 'faint' }) + k.dotsSvg(k.pointsAt(screws, P), { size: 0.5, tone: 'mid' }) })}</g>`);
    }
    for (let level = 0; level < SLOTS; level++) back.push(serverRear(rack, level, trayAt.get(`${rack}/${level}`)));
  }

  // ---------------------------------------------------------------- overhead: a ladder rack along the row
  {
    const lz = TOP + 30;
    const ly0 = -78;
    const ly1 = -48;
    const lx0 = RACKS[0] * PITCH - 20;
    const lx1 = (RACKS[RACKS.length - 1] + 1) * PITCH + 10;
    const parts: string[] = [];
    // hanger rods up toward the ceiling
    for (let xx = lx0 + 30; xx < lx1; xx += 160) for (const yy of [ly0, ly1]) parts.push(L(k.segment([xx, yy, lz + 4], [xx, yy, lz + 90], P), { tone: 'lo' }));
    // the side rails, the rungs between them, and the fiber lying on the rungs
    parts.push(S(k.slabOf(plan(lx0, ly0 - 1, lx1 - lx0, 1, 0.1), lz, 4, P, 1, 0.1), { tone: 'mid', crease: 'none' }));
    for (let xx = lx0 + 15; xx < lx1; xx += 30) parts.push(S(k.slabOf(plan(xx, ly0, 1.6, ly1 - ly0, 0.1), lz, 1, P, 1, 0.1), { tone: 'mid', crease: 'none' }));
    parts.push(S(k.slabOf(plan(lx0, ly0 + 7, lx1 - lx0, 12, 2), lz + 1, 2.4, P, 3, 0.8), { tone: 'lo', crease: 'none', className: 'fiber' }));
    parts.push(S(k.slabOf(plan(lx0, ly1, lx1 - lx0, 1, 0.1), lz, 4, P, 1, 0.1), { tone: 'mid', crease: 'none' }));
    back.push(`<g data-part="ladder">${parts.join('')}</g>`);
  }

  // ---------------------------------------------------------------- one server, seen from the rear
  // Face coordinates: u along the row from the server's left edge, v down from its top, in centimetres.
  // Ten GPU fan modules, two rows of five, across the lower 4U (Dell figure 3). Each is a light frame with
  // an orange pull tab in a strip along the top, a dense square grille over the fan, and two feet below.
  // The grille and the fan behind it are drawn by the GPU layer; the drawing keeps the frame.
  function fanWall(face: { x: number; top: number }, cage = -1, sh = new Shapes(), yFace = 0) {
    const holes: string[] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 5; col++) {
        const fx = 0.7 + col * MOD.pitch;
        const fy = 8.9 + 0.45 + row * 8.6;
        const cx = fx + MOD.w / 2;
        const cy = fy + 4.25;
        sh.rect('fan-face', fx, fy, MOD.w, MOD.h, 0.35);
        sh.rect('fan-hole', cx - MOD.gx, cy - MOD.gy, MOD.gx * 2, MOD.gy * 2, 0.15);
        sh.rect('tab', cx - 1.3, fy + 0.28, 2.6, 0.8, 0.3);
        sh.rect('latch', fx + 7.7, fy + 0.3, 0.75, 0.75, 0.12).rect('latch', fx + 0.6, fy + 7.55, 0.9, 0.45, 0.1).rect('latch', fx + MOD.w - 1.5, fy + 7.55, 0.9, 0.45, 0.1);
        spot(face.x + cx, face.top - cy, 0, 1, cage);
        const q = [
          [cx - MOD.gx, cy - MOD.gy],
          [cx + MOD.gx, cy - MOD.gy],
          [cx + MOD.gx, cy + MOD.gy],
          [cx - MOD.gx, cy + MOD.gy],
        ].map(([u, v]) => k.iso([face.x + u, yFace, face.top - v], P));
        holes.push(k.pathOf(q, true));
      }
    }
    return { svg: sh.svg(FACE_ORDER), holes: holes.join('') };
  }
  // The upper 2U (figure 3): PSU2 and PSU3 on the top row with the boot card, then PSU4 and PSU5;
  // below them PSU1, the vent over the I/O (LOM, OCP NIC, iDRAC, USB, VGA) and PSU6.
  function upperBand(face: { x: number; top: number }, sh: Shapes) {
    const psu = (px: number, py: number) => {
      spot(face.x + px + 2.05, face.top - (py + 2.0), 1, 1.5);
      sh.rect('psu-face', px, py, 9.3, 4, 0.3)
        .circle('fan-hole', px + 2.05, py + 2, 1.5)
        .rect('grip', px + 3.85, py + 0.45, 0.85, 3.1, 0.3)
        .rect('inlet', px + 5.15, py + 0.75, 2.6, 2.5, 0.45)
        .circle('pin', px + 5.95, py + 1.7, 0.18)
        .circle('pin', px + 6.95, py + 1.7, 0.18)
        .rect('pin', px + 6.3, py + 2.35, 0.3, 0.45)
        .rect('tab', px + 8.25, py + 0.95, 0.6, 2.1, 0.25);
    };
    psu(1.9, 0.3);
    psu(11.6, 0.3);
    // BOSS-N1 boot card, with its own release tab
    sh.rect('io', 21.3, 0.3, 4.2, 4, 0.3).rect('tab', 22.9, 0.6, 1, 0.55, 0.2).rect('port', 21.8, 1.6, 1, 2.2, 0.15).rect('port', 24, 1.6, 1, 2.2, 0.15);
    psu(26, 0.3);
    psu(36, 0.3);
    psu(1.9, 4.5);
    // the vent over the I/O, and the ports: LOM, OCP NIC, iDRAC, USB, VGA
    sh.rect('io', 11.6, 4.5, 24.1, 4, 0.3).rect('grille', 11.9, 4.75, 23.5, 1.9, 0.15);
    for (let i = 0; i < 2; i++) sh.rect('port', 12.4 + i * 1.7, 7, 1.3, 1.1, 0.12);
    for (let i = 0; i < 3; i++) sh.rect('port', 16.6 + i * 2.2, 7, 1.8, 1.1, 0.15);
    sh.rect('port', 24.6, 7, 1.3, 1.1, 0.12).rect('port', 26.6, 7.1, 0.9, 0.9, 0.12).rect('port', 28.2, 7.1, 0.9, 0.9, 0.12).rect('port', 29.9, 7.05, 2.6, 1, 0.3);
    psu(36, 4.5);
  }
  function serverRear(rack: number, level: number, host?: string) {
    const { x, z } = at(rack, level);
    const top = z + SERVER.h;
    const face = { x, top: top - 0.15 };
    const body = k.slabOf(plan(x, -2, SERVER.w, 2, 0.2), z + 0.15, SERVER.h - 0.3, P, 2, 0.4);
    const m = k.sideMatrix([x, 0], face.top, P, 'left');
    const ours = host !== undefined;
    const sh = new Shapes();
    upperBand(face, sh);
    if (ours) sh.rect('recess', BAY.x0, SERVER.h - 0.15 - BAY.z1, BAY.x1 - BAY.x0, BAY.z1 - BAY.z0);
    const faceSvg = ours ? sh.svg(FACE_ORDER) : fanWall(face, -1, sh).svg;
    const idled = `<circle class="idled" data-idled="${host ?? ''}" cx="34.2" cy="7.55" r="0.5"/>`;
    const svg = `<g data-part="${ours ? 'server-yours' : 'server'}" data-host="${host ?? ''}">${S(body, { tone: 'mid', crease: 'faint', inner: `<g transform="${m}">${faceSvg}${idled}</g>` })}</g>`;
    if (ours) {
      // Your server's fan wall is the front of its GPU tray: they come out together, like a drawer, and go back
      // in together. (On the real server Dell has you lift the fan wall off first; drawn attached, the motion
      // reads as what it is: pulling the GPUs out to look at them.) The grilles are cut out of the drawer, so the
      // fans the GPU layer draws underneath show through and travel with it.
      const ci = cages.push(host!) - 1;
      const yFace = TRAY.pull;
      const cw = fanWall(face, ci, new Shapes(), yFace);
      const mf = k.sideMatrix([x, yFace], face.top, P, 'left');
      const frontPlan = plan(x + BAY.x0, yFace - CAGE_DEPTH, BAY.x1 - BAY.x0, CAGE_DEPTH, 0.3);
      const fanFront = S(k.slabOf(frontPlan, z + BAY.z0, BAY.z1 - BAY.z0, P, 2, 0.4), { tone: 'mid', inner: `<g transform="${mf}">${cw.svg}</g>` });
      trayLayers.push({ host: host!, rack, level, svg: trayFor(host!, x, z, fanFront, cw.holes) });
    }
    return svg;
  }

  // ---------------------------------------------------------------- the GPU tray
  // Drawn from Dell's photograph of the MI300X tray (XE9680 Technical Guide, figure 8): a silver tray with
  // tall perforated side walls and a hinged lever across its end; the baseboard; and eight OAM modules,
  // four across and two deep, in line with the airflow. Each wears a tower heatsink: a short band of
  // vertical fins on a copper base, then a tall stack of thin horizontal fins with copper heat pipes rising
  // through it, under a black top plate with ten screws, two labels and a bar handle. In front of the
  // GPUs, the bare board carries a black lifting handle and a small heatsinked chip.
  function trayFor(host: string, x: number, z: number, fanFront: string, holes: string) {
    // Built fully out (pulled TRAY.pull cm); the page translates it back by (pull - d) along y. The fan wall
    // is its front, so the tray proper ends CAGE_DEPTH behind that.
    const tx = x + (SERVER.w - TRAY.w) / 2;
    const front = TRAY.pull - CAGE_DEPTH;
    const ty = front - TRAY.len;
    const z0 = z + BAY.z0 + 0.2;
    const items: { key: number; svg: string }[] = [];
    const put = (p: P3, svg: string, bias = 0) => items.push({ key: k.depthOf(p, P) + bias, svg });
    const wallH = 14.6;

    // the tray floor and the baseboard on it
    const floor = plan(tx, ty, TRAY.w, TRAY.len, 0.3);
    const ubb = plan(tx + (TRAY.w - UBB.w) / 2, ty + 2, UBB.w, UBB.d, 0.4);
    const bz = z0 + 0.75; // top of the board
    const comps: P3[] = [];
    for (let i = 0; i < 16; i++) comps.push([ubb.x + 2 + i * 2.4, front - 5.2, bz], [ubb.x + 3.2 + i * 2.4, front - 6.6, bz]);
    const vrms = [0, 1, 2, 3, 4, 5].map((i) => S(k.slabOf(plan(ubb.x + 3 + i * 1.6, front - 8.9, 1.1, 1.1, 0.1), bz, 0.5, P, 1, 0), { tone: 'lo', crease: 'none' })).join('');
    const base =
      S(k.slabOf(floor, z0, 0.45, P, 2, 0.3), { tone: 'mid', crease: 'faint', className: 'metal' }) +
      `<g data-part="baseboard">${S(k.slabOf(ubb, z0 + 0.45, 0.3, P, 2, 0), { tone: 'lo', crease: 'none', className: 'board', inner: k.dotsSvg(k.pointsAt(comps, P), { size: 0.38, tone: 'mid' }) })}${vrms}</g>`;

    // a tall side wall: silver, perforated, with three rectangular windows and a row of screws along the top
    const wall = (wx: number) => {
      const wp = plan(wx, ty, 0.3, TRAY.len, 0.05);
      const xf = wx + 0.31;
      const wins = [6, 20, 34].map((d) => faceX(xf, front - d - 9, front - d, z0 + 3.6, z0 + wallH - 3.4)).join('');
      const screws: P3[] = Array.from({ length: 9 }, (_, i) => [xf, front - 3 - i * 6.6, z0 + wallH - 1.2] as P3);
      return S(k.slabOf(wp, z0, wallH, P, 1, 0.15), {
        tone: 'mid',
        className: 'metal',
        inner: `<path class="perf-face" d="${faceX(xf, ty + 1, front - 1, z0 + 1.2, z0 + 3)}"/><path class="cutout" d="${wins}"/>` + k.dotsSvg(k.pointsAt(screws, P), { size: 0.42, tone: 'mid' }),
      });
    };

    // eight OAM modules under tower heatsinks, two rows of four; the rows sit toward the back of the tray
    const rowFront = front - 9.2;
    const rowY = [rowFront - OAM.d * 2 - 0.6, rowFront - OAM.d];
    const colX = [0, 1, 2, 3].map((i) => ubb.x + 0.55 + i * (OAM.w + 0.05));
    rowY.forEach((oy, row) => {
      colX.forEach((ox, col) => {
        const slot = row * 4 + col;
        const oam = plan(ox, oy, OAM.w, OAM.d, 0.2);
        const sp = plan(ox + 0.12, oy + 0.12, OAM.w - 0.24, OAM.d - 0.24, 0.25);
        const s0 = bz + 0.6; // on the module
        const band = s0 + 1.7; // top of the vertical-fin band
        const sTop = s0 + SINK.h; // top of the fin stack
        const xr = sp.x + sp.w; // the face along the airflow you can see (+x)
        const yf = sp.y + sp.d; // the face across it (+y)
        const stack = k.slabOf(sp, band, sTop - band, P, 2, 0.15);
        const lower = k.slabOf(sp, s0, band - s0, P, 2, 0.1);
        const pipes = [0.24, 0.5, 0.76].map((f) => k.segment([sp.x + sp.w * f, yf, band], [sp.x + sp.w * f, yf, sTop - 0.2], P)).join('') + [0.33, 0.67].map((f) => k.segment([xr, sp.y + sp.d * f, band], [xr, sp.y + sp.d * f, sTop - 0.2], P)).join('');
        const fins =
          `<path class="sink-face" d="${faceYp(yf, sp.x, xr, band, sTop)}${faceX(xr, sp.y, yf, band, sTop)}"/>` +
          `<path fill="url(#fins-y)" d="${faceYp(yf, sp.x, xr, band, sTop)}"/><path fill="url(#fins-x)" d="${faceX(xr, sp.y, yf, band, sTop)}"/>` +
          `<path class="pipe" d="${pipes}"/>`;
        const vfins = `<path class="sink-face" d="${faceYp(yf, sp.x, xr, s0, band)}${faceX(xr, sp.y, yf, s0, band)}"/><path fill="url(#vfins-y)" d="${faceYp(yf, sp.x, xr, s0, band)}"/><path fill="url(#vfins-x)" d="${faceX(xr, sp.y, yf, s0, band)}"/>` + `<path class="copper" d="${faceYp(yf, sp.x, xr, s0, s0 + 0.32)}${faceX(xr, sp.y, yf, s0, s0 + 0.32)}"/>`;
        // the top plate: black, ten copper screws, two white labels and a bar handle along its length
        const plate = plan(sp.x, sp.y, sp.w, sp.d, 0.25);
        const pTop = sTop + 0.3;
        const scr: P3[] = [];
        for (const [fx, fy] of [[0.1, 0.06], [0.9, 0.06], [0.1, 0.94], [0.9, 0.94], [0.1, 0.36], [0.9, 0.36], [0.1, 0.66], [0.9, 0.66], [0.5, 0.12], [0.5, 0.88]]) scr.push([sp.x + sp.w * fx, sp.y + sp.d * fy, pTop]);
        const labels = `<path class="label" d="${topQuad(sp.x + 1, sp.y + sp.d * 0.56, sp.w - 2, 1.15, pTop)}${topQuad(sp.x + 1.4, sp.y + sp.d * 0.2, sp.w * 0.42, 0.85, pTop)}"/>`;
        const hx = sp.x + sp.w / 2 - 0.22;
        const h0 = sp.y + sp.d * 0.3;
        const h1 = sp.y + sp.d * 0.7;
        const handle =
          S(k.slabOf(plan(hx, h0, 0.44, 0.44, 0.1), pTop, 1.5, P, 1, 0), { tone: 'mid', crease: 'none', className: 'metal' }) +
          S(k.slabOf(plan(hx, h1 - 0.44, 0.44, 0.44, 0.1), pTop, 1.5, P, 1, 0), { tone: 'mid', crease: 'none', className: 'metal' }) +
          S(k.slabOf(plan(hx, h0, 0.44, h1 - h0, 0.2), pTop + 1.5, 0.42, P, 1, 0.1), { tone: 'mid', crease: 'none', className: 'metal' });
        const led = k.iso([sp.x + sp.w - 1, yf, s0 + 0.95], P);
        const svg =
          `<g class="gpu" data-gpu="${host}/${slot}" data-part="gpu">` +
          S(k.slabOf(oam, bz, 0.6, P, 2, 0), { tone: 'lo', crease: 'none', className: 'board' }) +
          S(lower, { tone: 'lo', crease: 'none', inner: vfins }) +
          S(stack, { tone: 'hi', crease: 'faint', inner: fins + `<path class="heat side" d="${faceYp(yf, sp.x, xr, band, sTop)}${faceX(xr, sp.y, yf, band, sTop)}"/>` }) +
          `<g class="sink-top">${S(k.slabOf(plate, sTop, 0.3, P, 2, 0.15), { tone: 'hi', crease: 'none', inner: `<path class="heat" d="${topQuad(sp.x, sp.y, sp.w, sp.d, pTop)}"/>` + labels + k.dotsSvg(k.pointsAt(scr, P), { size: 0.36, tone: 'mid' }) })}</g>` +
          handle +
          `<circle class="led" cx="${fmt(led[0])}" cy="${fmt(led[1])}" r="0.9"/>` +
          `</g>`;
        put([ox + OAM.w / 2, oy + OAM.d / 2, s0 + 4], svg);
      });
    });

    // on the bare board in front of the GPUs: the black lifting handle, and a small heatsinked chip beside it
    const uy = front - 6.4;
    const ux = ubb.x + UBB.w * 0.36;
    const lift =
      S(k.slabOf(plan(ux, uy, 1, 1.3, 0.2), bz, 9.4, P, 1, 0.1), { tone: 'lo', className: 'black' }) +
      S(k.slabOf(plan(ux + 6.2, uy, 1, 1.3, 0.2), bz, 9.4, P, 1, 0.1), { tone: 'lo', className: 'black' }) +
      S(k.slabOf(plan(ux, uy, 7.2, 1.3, 0.3), bz + 9.4, 1.1, P, 2, 0.2), { tone: 'lo', className: 'black' });
    put([ux + 3.6, uy + 0.6, bz + 5], `<g data-part="lift">${lift}</g>`, 2);
    const chipAt = plan(ux - 3.6, uy - 0.4, 2.4, 2.4, 0.1);
    const chipFins = [0, 1, 2, 3, 4, 5].map((i) => k.segment([chipAt.x + 0.2 + i * 0.4, chipAt.y + 2.4, bz + 0.5], [chipAt.x + 0.2 + i * 0.4, chipAt.y + 2.4, bz + 1.5], P)).join('');
    put([chipAt.x + 1.2, chipAt.y + 1.2, bz + 1], `<g data-part="retimer">${S(k.slabOf(chipAt, bz, 1.5, P, 1, 0.1), { tone: 'mid', className: 'metal', inner: L(chipFins, { tone: 'lo' }) })}</g>`);

    items.sort((a, b) => a.key - b.key);
    const svg = `<g data-part="tray">${base}${wall(tx)}</g>${items.map((i) => i.svg).join('')}<g data-part="tray">${wall(tx + TRAY.w - 0.3)}</g><g data-part="fans">${fanFront}</g>`;
    const id = cssId(host);
    // the mask covers the drawer and no more: a moving masked group is redrawn offscreen every frame
    const box = k.boxCorners(plan(x, ty - 2, SERVER.w, TRAY.pull - ty + 4), z - 1, z + BAY.z1 + 4).map((c) => k.iso(c, P));
    const mx = Math.min(...box.map((b) => b[0]));
    const my = Math.min(...box.map((b) => b[1]));
    const mw = Math.max(...box.map((b) => b[0])) - mx;
    const mh = Math.max(...box.map((b) => b[1])) - my;
    const mr = `x="${fmt(mx)}" y="${fmt(my)}" width="${fmt(mw)}" height="${fmt(mh)}"`;
    const mask = `<mask id="holes-${id}" maskUnits="userSpaceOnUse" ${mr}><rect ${mr} fill="#fff"/><path d="${holes}" fill="#000"/></mask>`;

    // The clip: the bay opening extruded out into the aisle, so whatever is still inside the server stays hidden.
    const corners: P3[] = [];
    for (const yy of [0, TRAY.pull + 30]) for (const [bx, bz2] of [[BAY.x0, BAY.z0], [BAY.x1, BAY.z0], [BAY.x1, BAY.z1], [BAY.x0, BAY.z1]]) corners.push([x + bx, yy, z + bz2]);
    const hull = k.pathOf(hullOf(corners.map((c) => k.iso(c, P))), true);
    return `<clipPath id="clip-${id}"><path d="${hull}"/></clipPath>${mask}<g clip-path="url(#clip-${id})"><g data-tray="${host}"><g mask="url(#holes-${id})">${svg}</g></g></g>`;
  }

  // ---------------------------------------------------------------- framing
  const fit = (points: P3[], pad: Partial<typeof inset> = inset): Frame => {
    const flat = points.map((c) => k.iso(c, P));
    const xs = flat.map((b) => b[0]);
    const ys = flat.map((b) => b[1]);
    const [a0, a1, b0, b1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const l = pad.left ?? 0;
    const t = pad.top ?? 0;
    const W = w - l - (pad.right ?? 0);
    const H = h - t - (pad.bottom ?? 0);
    const scale = Math.max((a1 - a0) / W, (b1 - b0) / H);
    const cx = (a0 + a1) / 2;
    const cy = (b0 + b1) / 2;
    const vx = cx - (W / 2) * scale - l * scale;
    const vy = cy - (H / 2) * scale - t * scale;
    return [vx, vy, w * scale, h * scale];
  };
  const hosts: Hall['hosts'] = {};
  const boxes: Record<string, P3[]> = {};
  const anchors: Hall['anchors'] = {};
  for (const t of trays) {
    const { x, z } = at(t.slot.rack, t.slot.level);
    anchors[t.host] = k.iso([x + (BAY.x0 + BAY.x1) / 2, 0, z + BAY.z1], P) as [number, number];
    boxes[t.host] = k.boxCorners(plan(x - 4, -2, SERVER.w + 8, TRAY.pull + 2), z - 2, z + SERVER.h + 2);
    hosts[t.host] = fit(boxes[t.host]);
  }
  const overview = fit(k.boxCorners(plan(RACKS[0] * PITCH, -DEPTH, RACKS.length * PITCH, DEPTH + 90), 0, TOP + 40), { left: 24, top: 24, right: 24, bottom: 24 });

  const defs = `<pattern id="mesh" width="0.7" height="0.7" patternUnits="userSpaceOnUse"><path d="M0 0.35H0.7M0.35 0V0.7"/></pattern>`;
  const body = `<g class="rack-row">${back.join('')}</g>`;
  trayLayers.sort((a, b) => a.level - b.level || a.rack - b.rack);
  const front = `<defs>${trayDefs}</defs>` + trayLayers.map((t) => `<g class="host-layer" data-layer="${t.host}">${t.svg}</g>`).join('');
  const frameOf = (list: string[]): Frame => {
    const pts = list.flatMap((h) => boxes[h] ?? []);
    return pts.length ? fit(pts) : overview;
  };
  return { svg: body, defs, front, fans, cages, frameOf, perY: k.axisVector(P, [0, 1, 0]), perZ: k.axisVector(P, [0, 0, 1]), hosts, anchors, overview };
}

export const cssId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

function hullOf(points: k.Flat[]): k.Flat[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: k.Flat, a: k.Flat, b: k.Flat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: k.Flat[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: k.Flat[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The pull, in centimetres, at which a tray is fully out. */
export const PULL = TRAY.pull;
