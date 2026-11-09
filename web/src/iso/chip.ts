// A small drawing of one MI300X package, for the inspector: four I/O dies in a 2 x 2 grid, two compute
// dies (XCDs) stacked on each, and eight HBM3 stacks, four down each side (AMD, Hot Chips 2024).
// The page lights the XCDs as the machine boots and the HBM once it is ready.
import * as k from './kit';

const S = k.solidSvg;

export function buildChip(w: number, h: number) {
  const pkg = { x: 0, y: 0, w: 64, d: 46, r: 1.2 };
  const P = k.fitProjection(k.boxCorners(pkg, 0, 6), w, h, { pad: 6, azimuth: 40, elevation: 38 });
  const items: { key: number; svg: string }[] = [];
  const put = (p: k.Point3, svg: string) => items.push({ key: k.depthOf(p, P), svg });

  const caps: k.Point3[] = [];
  for (let i = 0; i < 26; i++) caps.push([2 + i * 2.4, 2, 1.6], [2 + i * 2.4, pkg.d - 2, 1.6]);
  const substrate = S(k.slabOf(pkg, 0, 1.6, P, 3, 0.5), { tone: 'mid', inner: k.dotsSvg(k.pointsAt(caps, P), { size: 0.5, tone: 'lo' }) });
  // the interposer the dies sit on
  const ip = { x: 6, y: 5, w: 52, d: 36, r: 0.6 };
  const interposer = S(k.slabOf(ip, 1.6, 0.8, P, 2, 0.3), { tone: 'lo', crease: 'none' });

  // HBM3: four a side
  for (const side of [0, 1]) {
    for (let i = 0; i < 4; i++) {
      const hx = side === 0 ? 7.5 : 49;
      const hy = 6.5 + i * 8.6;
      put([hx + 3.75, hy + 3.6, 3], `<g class="hbm" data-hbm="${side * 4 + i}">${S(k.slabOf({ x: hx, y: hy, w: 7.5, d: 7.2, r: 0.4 }, 2.4, 3.4, P, 2, 0.3), { tone: 'mid' })}</g>`);
    }
  }
  // four IODs, each with two XCDs on top
  let xcd = 0;
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const ix = 17.5 + gx * 14.8;
      const iy = 7 + gy * 16.4;
      put([ix + 7, iy + 7.8, 2.6], S(k.slabOf({ x: ix, y: iy, w: 14.2, d: 15.6, r: 0.3 }, 2.4, 0.9, P, 2, 0.2), { tone: 'lo', crease: 'faint' }));
      for (let j = 0; j < 2; j++) {
        const xx = ix + 0.9 + j * 6.4;
        put([xx + 2.9, iy + 7.8, 4], `<g class="xcd" data-xcd="${xcd++}">${S(k.slabOf({ x: xx, y: iy + 1.2, w: 5.8, d: 13.2, r: 0.2 }, 3.3, 0.8, P, 2, 0.2), { tone: 'hi' })}</g>`);
      }
    }
  }
  items.sort((a, b) => a.key - b.key);
  return `${substrate}${interposer}${items.map((i) => i.svg).join('')}`;
}
