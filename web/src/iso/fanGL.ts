// Every fan in the row, drawn on the GPU in one call per frame.
//
// The drawing itself is static SVG, painted once. Fans are what move all the time, and in SVG a spinning
// blade makes the browser repaint everything around it, every frame. Here each fan is one instanced
// quad, and the fragment shader works out, per pixel, what is there: the dark duct, the blades (swept,
// turning), the hub, and the guard in front (the square grille of a GPU fan module, the cross of a power
// supply). Shapes are measured as distances, so edges stay sharp at any zoom and pixel density, and a
// frame costs a few microseconds of GPU time however many fans there are.
import type { Fan } from './hall';

const VS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 mABCD;
layout(location = 2) in vec2 mEF;
layout(location = 3) in vec4 info; // kind, seconds per turn, phase (0-1), fan wall index or -1
uniform vec3 cam;                  // drawing units to CSS pixels: scale, x offset, y offset
uniform vec2 size;                 // canvas size in CSS pixels
uniform vec2 offsets[8];           // where each fan wall has been moved, in drawing units
uniform float time;
uniform float wallTime[8];         // each fan wall's own clock: it slows to a stop while the wall is off
out vec2 local;
flat out int kind;
flat out float angle;
void main() {
  kind = int(info.x);
  // the quad: a GPU fan module's grille (centimetres), or a round fan's guard (radius 1)
  vec2 ext = kind == 0 ? vec2(4.05, 2.95) : vec2(1.0);
  local = corner * ext;
  vec2 user = vec2(mABCD.x * local.x + mABCD.z * local.y, mABCD.y * local.x + mABCD.w * local.y) + mEF;
  int ci = int(info.w);
  if (ci >= 0) user += offsets[ci];
  vec2 px = user * cam.x + cam.yz;
  vec2 clip = px / size * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float t = ci >= 0 ? wallTime[ci] : time;
  angle = 6.28318531 * fract(t / info.y + info.z);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 local;
flat in int kind;
flat in float angle;
uniform vec3 duct, blade, bladeHi, edge, hub, grille, grilleShade;

out vec4 color;

// Swept blades around the origin (radius 1). Returns coverage; d is the distance to the nearest edge.
float blades(vec2 p, float n, float r0, float r1, float sweep, float aa, out float d) {
  float rho = length(p);
  float sector = 6.28318531 / n;
  float th = atan(p.y, p.x) - angle - sweep * (rho - r0) / (r1 - r0);
  float t = mod(th, sector);
  float w = sector * 0.58;
  float across = min(t, w - t) * rho;
  float radial = min(rho - r0, r1 - rho);
  d = min(across, radial);
  return smoothstep(-aa, aa, d);
}

void main() {
  vec2 px = fwidth(local);
  float aa = max(px.x, px.y) * 0.75;
  vec3 c;
  if (kind == 0) {
    // a GPU fan module: an 80 mm fan behind a square grille
    vec2 p = local / 3.55;
    float a = aa / 3.55;
    float rho = length(p);
    c = duct;
    float d;
    float b = blades(p, 7.0, 0.3, 0.97, 0.9, a, d);
    // a fan only a few pixels across turns into a soft disc rather than flickering blades
    float tiny = smoothstep(0.06, 0.16, a);
    b = mix(b, 0.5 * step(0.3, rho) * step(rho, 0.97), tiny);
    c = mix(c, mix(blade, bladeHi, smoothstep(0.3, 1.0, rho) * 0.6), b);
    c = mix(c, edge, (1.0 - smoothstep(0.0, a * 1.4, abs(d))) * 0.85 * (1.0 - tiny));
    float h = smoothstep(a, -a, rho - 0.3);
    c = mix(c, hub, h);
    c = mix(c, edge, (1.0 - smoothstep(0.0, a * 1.4, abs(rho - 0.3))) * 0.8);
    // the grille: 8 x 6 square openings, bars about 1.8 mm, a little shading on their lower edge
    vec2 g = (local + vec2(4.05, 2.95)) / vec2(8.1, 5.9) * vec2(8.0, 6.0);
    vec2 gp = fwidth(g) * 0.75;
    vec2 f = abs(fract(g) - 0.5);
    float bw = 0.4;
    float barX = smoothstep(bw - gp.x, bw + gp.x, f.x);
    float barY = smoothstep(bw - gp.y, bw + gp.y, f.y);
    float bar = max(barX, barY);
    float under = smoothstep(bw - gp.y, bw + gp.y, abs(fract(g.y - 0.08) - 0.5)) * (1.0 - bar);
    // when an opening is only a few pixels across, the bars would alias and crawl as the camera moves:
    // fade them toward their average cover (about a third of the grille), as a mipmap would
    float lod = smoothstep(0.16, 0.38, max(gp.x, gp.y));
    bar = mix(bar, 0.36, lod);
    under *= 1.0 - lod;
    c = mix(c, grilleShade, under * 0.7);
    c = mix(c, grille, bar);
    // the handle across the lower grille
    float arc = abs(length(local - vec2(0.0, -2.2)) - 4.55);
    float handle = (1.0 - smoothstep(0.11 - aa, 0.11 + aa, arc)) * (1.0 - smoothstep(1.9 - aa, 1.9 + aa, abs(local.x)));
    c = mix(c, grille, handle);
    color = vec4(c, 1.0);
  } else {
    // a power supply or switch fan, behind a guard of four spokes and a ring
    float rho = length(local);
    float alpha = smoothstep(1.0 + aa, 1.0 - aa, rho);
    if (alpha <= 0.0) discard;
    c = duct;
    float d;
    float b = blades(local, 5.0, 0.32, 0.95, 0.8, aa, d);
    float tiny = smoothstep(0.06, 0.16, aa);
    b = mix(b, 0.5 * step(0.32, rho), tiny);
    c = mix(c, mix(blade, bladeHi, smoothstep(0.3, 1.0, rho) * 0.6), b);
    c = mix(c, edge, (1.0 - smoothstep(0.0, aa * 1.4, abs(d))) * 0.85 * (1.0 - tiny));
    c = mix(c, hub, smoothstep(aa, -aa, rho - 0.3));
    vec2 q = abs(mat2(0.70710678, -0.70710678, 0.70710678, 0.70710678) * local);
    float spoke = (1.0 - smoothstep(0.07 - aa, 0.07 + aa, min(q.x, q.y))) * step(0.3, rho);
    float ring = 1.0 - smoothstep(0.06 - aa, 0.06 + aa, abs(rho - 0.93));
    c = mix(c, grille, max(spoke, ring));
    color = vec4(c * alpha, alpha);
  }
}`;

const COLORS = {
  duct: '--anatomy-shade-0',
  blade: '--anatomy-shade-2',
  bladeHi: '--anatomy-shade-3',
  edge: '--anatomy-lo',
  hub: '--anatomy-top',
  grille: '--anatomy-mid',
  grilleShade: '--anatomy-faint',
} as const;

export class FanLayer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private count = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private offsets = new Float32Array(16);
  private cam = [1, 0, 0];
  private wallTime = new Float32Array(8);
  private wallSpeed = new Float32Array(8).fill(1);
  private wallPower = new Float32Array(8).fill(1);
  private lastDraw = 0;
  private buf: WebGLBuffer | null = null;
  private css = [1, 1];
  readonly ok: boolean;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    this.ok = !!gl;
    this.gl = gl!;
    if (!gl) {
      this.prog = null!;
      return;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    this.prog = prog;
    gl.useProgram(prog);
    for (const name of ['cam', 'size', 'offsets', 'time', 'wallTime', ...Object.keys(COLORS)]) this.u[name] = gl.getUniformLocation(prog, name);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** The fans to draw. `top` is the fan wall drawn last of all: the one taken off, in front of everything. */
  setFans(fans: Fan[], top = -1) {
    if (!this.ok) return;
    const gl = this.gl;
    // the fans on your servers' fan walls go last: a wall taken off floats in front of the row, and its own
    // fans must show through its grilles, not the fans of the server behind it
    const ordered = [...fans.filter((f) => f.cage < 0), ...fans.filter((f) => f.cage >= 0 && f.cage !== top), ...fans.filter((f) => f.cage >= 0 && f.cage === top)];
    const data = new Float32Array(ordered.length * 10);
    ordered.forEach((f, i) => data.set([...f.m, f.kind, f.spin, f.phase, f.cage], i * 10));
    // one buffer, refilled: the fans change only when the drawing is rebuilt or the focus moves
    if (!this.buf) this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const attr = (loc: number, n: number, off: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 40, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, 0);
    attr(2, 2, 4);
    attr(3, 4, 6);
    this.count = fans.length;
  }

  /** Match the canvas to its box at full device resolution. */
  resize(w: number, h: number) {
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.css = [w, h];
  }

  /** The same mapping an SVG view box makes (meet), so the fans sit exactly on the drawing. */
  setCamera(vb: number[]) {
    const [vx, vy, vw, vh] = vb;
    const [w, h] = this.css;
    const s = Math.min(w / vw, h / vh);
    this.cam = [s, (w - vw * s) / 2 - vx * s, (h - vh * s) / 2 - vy * s];
  }

  /** Power to a fan wall's fans: off while it is out of its server. They spin down, and back up, like real fans. */
  setPower(i: number, on: boolean) {
    if (i >= 0 && i < 8) this.wallPower[i] = on ? 1 : 0;
  }

  setOffset(i: number, dx: number, dy: number) {
    if (i < 0 || i > 7) return;
    this.offsets[i * 2] = dx;
    this.offsets[i * 2 + 1] = dy;
  }

  /** Colours come from the page's theme, so the fans match the drawing in light and dark. */
  setColors(from: Element) {
    if (!this.ok) return;
    const probe = document.createElement('span');
    from.appendChild(probe);
    const gl = this.gl;
    gl.useProgram(this.prog);
    for (const [name, prop] of Object.entries(COLORS)) {
      probe.style.color = `var(${prop})`;
      gl.uniform3fv(this.u[name], parseColor(getComputedStyle(probe).color));
    }
    probe.remove();
  }

  draw(seconds: number) {
    if (!this.ok || !this.count) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform3fv(this.u.cam, this.cam);
    gl.uniform2fv(this.u.size, this.css);
    gl.uniform2fv(this.u.offsets, this.offsets);
    gl.uniform1f(this.u.time, seconds);
    // each wall's clock runs at its fans' speed: about 1.6 s to spin down, 0.7 s to spin up
    const dt = this.lastDraw ? Math.min(0.1, Math.max(0, seconds - this.lastDraw)) : 0;
    this.lastDraw = seconds;
    for (let i = 0; i < 8; i++) {
      const target = this.wallPower[i];
      const tau = target > this.wallSpeed[i] ? 0.25 : 0.55;
      this.wallSpeed[i] += (target - this.wallSpeed[i]) * (1 - Math.exp(-dt / tau));
      this.wallTime[i] = dt ? this.wallTime[i] + dt * this.wallSpeed[i] : seconds;
    }
    gl.uniform1fv(this.u.wallTime, this.wallTime);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
  }

  dispose() {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function parseColor(css: string): number[] {
  const n = css.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  // rgb(255, 0, 0) or color(srgb 1 0 0)
  return css.startsWith('color(') ? n.slice(0, 3) : n.slice(0, 3).map((v) => v / 255);
}
