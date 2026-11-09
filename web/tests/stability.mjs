#!/usr/bin/env node
// Layout stability: nothing on the page may move or resize unless the person asked for a different view.
//
// Runs the real binary in sample-data mode, drives it in headless Chrome over the DevTools protocol
// (no packages needed), and walks every interaction a person makes: picking sizes, menus, launching,
// booting to ready, copying the SSH command, auto-end, ending, receipts, settings, credits. After each
// step that should leave the layout alone it checks two things:
//   1. the browser's own layout-shift entries (the Cumulative Layout Shift signal), and
//   2. the boxes of the elements people look at (cards, the SSH row, the copy button, meters, header,
//      the launch key), which must not change size or position.
// Steps that change the view on purpose (opening another screen, expanding a machine) are marked
// `moves` and only checked for errors.
//
//   node web/tests/stability.mjs            uses ./bin/hotaisle-ui and finds Chrome
//   CHROME=/path/to/chrome node web/tests/stability.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = path.join(root, 'bin', 'hotaisle-ui');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hotaisle-ui-stability-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const cleanup = () => {
  for (const c of children) c.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function findChrome() {
  if (process.env.CHROME) return { path: process.env.CHROME, shell: /headless.shell/.test(process.env.CHROME) };
  const pw = path.join(os.homedir(), os.platform() === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(pw, d))) {
        const p = path.join(pw, d, sub, 'chrome-headless-shell');
        if (fs.existsSync(p)) return { path: p, shell: true };
      }
    }
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) if (fs.existsSync(p)) return { path: p, shell: false };
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return { path: execFileSync('which', [name]).toString().trim(), shell: false };
    } catch {
      /* next */
    }
  }
  throw new Error('No Chrome found. Set CHROME=/path/to/chrome.');
}

function waitForLine(proc, stream, re, what) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 20000);
    proc[stream].on('data', (d) => {
      buf += d;
      const m = buf.match(re);
      if (m) {
        clearTimeout(t);
        resolve(m);
      }
    });
    proc.on('exit', (code) => reject(new Error(`${what}: process exited with ${code}\n${buf}`)));
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
  }
  open() {
    return new Promise((r, j) => {
      this.ws.onopen = r;
      this.ws.onerror = j;
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const OBSERVER = `
window.__changed = new WeakSet();
new MutationObserver((list) => {
  for (const m of list) {
    if (m.type === 'characterData') { window.__changed.add(m.target); if (m.target.parentElement) window.__changed.add(m.target.parentElement); }
    else if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 3)) window.__changed.add(m.target);
  }
}).observe(document, { subtree: true, childList: true, characterData: true });
window.__shifts = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const own = (e.sources || []).length > 0 && e.sources.every((s) => s.node && window.__changed.has(s.node));
    window.__shifts.push({
      value: own ? 0 : e.value,
      own,
      sources: (e.sources || []).map((s) => {
        const n = s.node;
        const name = !n ? '?' : n.nodeType === 1 ? n.nodeName.toLowerCase() + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).join('.') : '') : '#text in ' + (n.parentElement ? n.parentElement.nodeName.toLowerCase() + '.' + (n.parentElement.className || '') : '?');
        const r = (x) => [Math.round(x.x), Math.round(x.y), Math.round(x.width), Math.round(x.height)].join(',');
        return name + ' ' + r(s.previousRect) + ' -> ' + r(s.currentRect);
      }),
    });
  }
}).observe({ type: 'layout-shift', buffered: true });
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason && e.reason.message || e.reason)));
`;

// The boxes that must hold still.
// Positions are taken with every scroll undone, so scrolling a list never counts as movement.
// The inspector is an overlay whose length follows what it describes, so only its place and width are held.
const WATCH = ['.top', '.pv-head', '.pv-title', '.back-btn', '.trip', '.trip-row', '.inst', '.meter-cell', '.meter-v', '.track', '.ssh', '.ssh code', '.btn.copy', '.card-foot', '.btn.end', '.opt', '.details', '.picker-btn', '.estimate', '.go', '.hold', '.fine', '.money', '.plate', '.corner', '.inspector:xyw', '.receipt', '.row-item'];
// Each element is known by its own identity (not its place in a list), so a card that gains a meter
// doesn't make every later meter look moved; only elements there before and after a step are compared.
const BOXES = `(() => {
  const ids = window.__ids || (window.__ids = new WeakMap());
  let next = window.__next || 0;
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, ++next); window.__next = next; return ids.get(el); };
  const out = {};
  for (const spec of ${JSON.stringify(WATCH)}) {
    const [sel, dims] = spec.split(':');
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return; // not shown at this size
      let x = r.x, y = r.y; // the loop below reaches <html>, which holds the page scroll
      let sticky = false;
      for (let p = el; p; p = p.parentElement) { if (p !== el) { x += p.scrollLeft; y += p.scrollTop; } if (getComputedStyle(p).position === 'sticky') sticky = true; }
      const v = { x, y, w: r.width, h: r.height };
      // a sticky bar follows the scroll by design: hold its size and its place across, not down
      const keep = sticky ? (dims || 'xywh').replace('y', '') : dims || 'xywh';
      out[sel + '#' + idOf(el)] = [...keep].map((d) => Math.round(v[d] * 2) / 2).join(',');
    });
  }
  return out;
})()`;
// Nothing may stick out past the edge of its card, row or panel.
const OVERFLOW = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll('.panel, .pv-head, .trip, .trip-row, .opt, .row-item, .inspector, .top, .estimate, .details, .foot, .sheet')) {
    const box = el.getBoundingClientRect();
    if (!box.width) continue;
    for (const c of el.querySelectorAll('*')) {
      if (c.closest('.menu, .picker-menu')) continue;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let clipped = false;
      for (let p = c.parentElement; p && p !== el; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') { clipped = true; break; } }
      if (clipped) continue;
      if (r.right > box.right + 1 || r.left < box.left - 1) {
        bad.push((el.className || el.nodeName) + ' > ' + c.nodeName.toLowerCase() + '.' + (typeof c.className === 'string' ? c.className.split(' ').join('.') : '') + ' spans ' + Math.round(r.left) + '..' + Math.round(r.right) + ', card ' + Math.round(box.left) + '..' + Math.round(box.right));
        break;
      }
    }
  }
  // the order fits its sheet on any window at least 720 px tall: nothing hidden under the launch button
  const body = document.querySelector('.pv-body');
  if (document.querySelector('.order') && innerWidth > 1080 && innerHeight >= 720 && body && body.scrollHeight > body.clientHeight + 1) bad.push('the order is cut off: ' + (body.scrollHeight - body.clientHeight) + ' px of it sits under the launch button');
  for (const el of document.querySelectorAll('.menu, .picker-menu, .sheet, .toast')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.left < 0 || r.right > innerWidth)) bad.push(el.className + ' runs off the window: ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  return bad;
})()`;

// The drawing on a fresh load: the camera comes in and one drawer, the one in focus, slides out once.
// No drawer may reverse (out, in, out again is the flicker), nor more than one end up out. Every running
// machine's server has a tag inside the plate. Reads the per-frame log the drawing keeps under #perf.
const DRAWING = `(() => {
  const bad = [];
  const series = {};
  for (const line of window.__pulls || []) { const [, ...rest] = line.split(' '); for (const r of rest) { const i = r.lastIndexOf(':'); (series[r.slice(0, i)] ??= []).push(+r.slice(i + 1)); } }
  if (!Object.keys(series).length) bad.push('the drawing kept no log of its drawers');
  let out = 0;
  for (const [h, s] of Object.entries(series)) {
    let dir = 0, turns = 0;
    for (let i = 1; i < s.length; i++) { const d = Math.sign(s[i] - s[i - 1]); if (d && d !== dir) { if (dir) turns++; dir = d; } }
    if (turns) bad.push(h + ' drawer changed direction ' + turns + ' time(s): ' + s.filter((v, i) => i % 6 === 0).join(','));
    if (s[s.length - 1] > 0) out++;
  }
  if (out > 1) bad.push(out + ' drawers out at once');
  const plate = document.querySelector('.plate').getBoundingClientRect();
  const tags = [...document.querySelectorAll('[data-tag]')];
  const running = document.querySelectorAll('.trip, .trip-row').length;
  if (!tags.length && running) bad.push('no tags on your servers');
  for (const t of tags) {
    const r = t.getBoundingClientRect();
    if (t.dataset.shown !== 'true') bad.push('tag for ' + t.dataset.tag + ' never came up');
    if (r.left < plate.left || r.right > plate.right || r.top < plate.top || r.bottom > plate.bottom) bad.push('tag for ' + t.dataset.tag + ' sits outside the plate');
  }
  // the outlines are drawn over what the panel and the plate hold
  for (const sel of ['.panel', '.plate']) {
    const b = getComputedStyle(document.querySelector(sel), '::before');
    if (!b.boxShadow || b.boxShadow === 'none' || Number(b.zIndex) < 4) bad.push(sel + ' outline is not drawn above its content');
  }
  return bad;
})()`;

async function run(viewport) {
  const chrome = findChrome();
  const server = spawn(bin, ['--demo', '--no-open', '--port', '0', '--config-file', path.join(tmp, `config-${viewport.name}.json`)], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(server);
  const [link] = await Promise.race([waitForLine(server, 'stdout', /http:\/\/127\.0\.0\.1:\d+\/open\?k=\w+/, 'the server link'), waitForLine(server, 'stderr', /http:\/\/127\.0\.0\.1:\d+\/open\?k=\w+/, 'the server link')]);
  const args = [`--user-data-dir=${path.join(tmp, 'chrome-' + viewport.name)}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'];
  if (!chrome.shell) args.unshift('--headless=new');
  const browser = spawn(chrome.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(browser);
  const [, wsUrl] = await waitForLine(browser, 'stderr', /DevTools listening on (ws:\/\/\S+)/, 'Chrome');
  const cdp = new CDP(wsUrl);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = (m, p) => cdp.send(m, p, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');
  // console warnings and errors count as page errors: a quiet failure (a shader that won't compile, say)
  // must not pass as a page that merely looks a little different
  const consoleProblems = [];
  cdp.ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.sessionId === sessionId && (msg.params.type === 'warning' || msg.params.type === 'error'))
      consoleProblems.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  });
  await page('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 600 });
  await page('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => undefined);
  await page('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
  const evaluate = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expression.slice(0, 120)}`);
    return r.result.value;
  };
  const center = async (sel) => {
    const r = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { err: 'no element' };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return { err: 'covered by ' + (hit ? hit.nodeName.toLowerCase() + '.' + String(hit.className).split(' ').join('.') : 'nothing') };
      return { at: [x, y] };
    })()`);
    if (r.err) throw new Error(`${sel}: ${r.err}`);
    return r.at;
  };
  const mouse = (type, [x, y]) => page('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const click = async (sel) => {
    const at = await center(sel);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    await mouse('mousePressed', at);
    await mouse('mouseReleased', at);
  };
  const hold = async (sel, ms = 950) => {
    const at = await center(sel);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    await mouse('mousePressed', at);
    await sleep(ms);
    await mouse('mouseReleased', at);
  };
  const key = async (k) => {
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
  };
  // wait for something to appear, as a person would, rather than a fixed pause; fails if it never does
  const waitFor = async (sel, ms = 1500) => {
    for (let t = 0; t < ms; t += 50) {
      if (await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) return;
      await sleep(50);
    }
    throw new Error(`${sel} never appeared`);
  };
  const hover = async (sel) => page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (await center(sel))[0], y: (await center(sel))[1] });

  await page('Page.navigate', { url: link });
  await sleep(600);

  const failures = [];
  let n = 0;
  const step = async (name, act, { moves = false, settle = 700, expect, gone, fromLoad = false } = {}) => {
    n++;
    if (!fromLoad) await evaluate('window.__shifts.length = 0');
    const before = moves ? null : await evaluate(BOXES);
    try {
      await act();
    } catch (e) {
      // say what the page looked like, so a step that can't run explains itself
      const seen = await evaluate(`(() => { const t = document.querySelector('.trip'); return t ? t.innerText.replace(/\\s+/g, ' ').slice(0, 200) + (document.querySelector('.sheet') ? ' [sheet: ' + document.querySelector('.sheet').getAttribute('aria-label') + ']' : '') : document.querySelector('.pv-title')?.innerText || '?'; })()`).catch(() => '?');
      failures.push(`${viewport.name} ${n}. ${name}: could not run: ${e.message}\n      page: ${seen}`);
      console.log(`  ✗ ${name} (could not run)\n      ${e.message}\n      page: ${seen}`);
      return;
    }
    await sleep(settle);
    if (process.env.SHOTS) {
      fs.mkdirSync(process.env.SHOTS, { recursive: true });
      const { data } = await page('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.SHOTS, `${viewport.name}-${String(n).padStart(2, '0')}.png`), Buffer.from(data, 'base64'));
    }
    const shifts = await evaluate('window.__shifts');
    const errors = [...(await evaluate('window.__errors.splice(0)')), ...consoleProblems.splice(0)];
    const problems = [];
    if (errors.length) problems.push(`page errors: ${errors.join('; ')}`);
    if (expect && !(await evaluate(`!!document.querySelector(${JSON.stringify(expect)})`))) problems.push(`expected ${expect} afterwards, it is not there`);
    if (gone && (await evaluate(`!!document.querySelector(${JSON.stringify(gone)})`))) problems.push(`expected ${gone} to be gone, it is still there`);
    const over = await evaluate(OVERFLOW);
    if (over.length) problems.push(`sticks out: ${over.slice(0, 4).join(' | ')}`);
    if (!moves) {
      const score = shifts.reduce((a, s) => a + s.value, 0);
      if (score > 0.0005) problems.push(`layout shifted (score ${score.toFixed(4)}): ${[...new Set(shifts.flatMap((s) => s.sources))].slice(0, 6).join(' | ')}`);
      const after = await evaluate(BOXES);
      const moved = Object.keys(before).filter((k) => k in after && before[k] !== after[k]);
      if (moved.length) problems.push(`boxes changed: ${moved.slice(0, 6).map((k) => `${k} ${before[k]} -> ${after[k]}`).join(' | ')}`);
    }
    if (problems.length) {
      failures.push(`${viewport.name} ${n}. ${name}: ${problems.join(' ; ')}`);
      console.log(`  ✗ ${name}\n      ${problems.join('\n      ')}`);
    } else console.log(`  ✓ ${name}${moves ? ' (view changes on purpose)' : ''}`);
  };

  console.log(`\n${viewport.name} (${viewport.width}×${viewport.height})`);
  await step('page arrives: nothing shifts while it loads and the entrance plays', async () => {}, { settle: 3200, fromLoad: true, moves: true, expect: '.opt' });
  await step('then it holds still', async () => {}, { settle: 1500 });
  await step('pick each size', async () => {
    for (const i of [1, 2, 0]) {
      await click(`.opt:nth-child(${i + 1})`);
      await sleep(250);
    }
  }, { expect: '.opt:nth-child(1)[aria-checked="true"], .opt:nth-child(1).on' });
  await step('open the image menu', () => click('.details .picker:nth-child(1) .picker-btn'), { settle: 350, expect: '.picker-menu' });
  await step('close it', () => key('Escape'), { settle: 350, gone: '.picker-menu' });
  await step('choose an auto-end', async () => {
    await click('.details .picker:nth-child(2) .picker-btn');
    await waitFor('.picker-menu > button:nth-child(3)');
    await click('.picker-menu > button:nth-child(3)');
  }, { gone: '.picker-menu' });
  await step('hover the drawing', async () => {
    await hover('.plate');
    await sleep(200);
  });
  await step('open SSH keys', () => click('.picker-btn.attention'), { moves: true, expect: '.row-item.act' });
  await step('add a key from this computer', () => click('.row-item.act'), { moves: true, settle: 900 });
  await step('go back', () => key('Escape'), { moves: true, expect: '.go .hold' });
  await step('hold to launch', () => hold('.go .hold'), { moves: true, settle: 900, expect: '.trip' });
  await step('booting, then ready', async () => {}, { settle: 6500, expect: '.trip .ssh.ready' });
  await step('copy the SSH command', () => click('.trip .btn.copy'), { settle: 400 });
  await step('the copy label returns', async () => {}, { settle: 1800 });
  await step('open More', () => click('.trip .menu-wrap > .btn'), { settle: 350, expect: '.trip .menu' });
  await step('close it', () => key('Escape'), { settle: 350, gone: '.trip .menu' });
  await step('set auto-end on the machine', async () => {
    await click('.trip .sub-act .btn-text');
    await waitFor('.sheet .choice button:nth-child(2)');
    await click('.sheet .choice button:nth-child(2)');
  }, { gone: '.sheet' });
  await step('open End', () => click('.trip .btn.end'), { settle: 400, expect: '.sheet' });
  await step('cancel it', () => click('.sheet-x'), { settle: 400, gone: '.sheet' });
  await step('a minute of running', async () => {}, { settle: 2500 });
  await step('new machine', () => click('.foot .btn.new'), { moves: true, expect: '.opt' });
  await step('pick 2 GPUs', () => click('.opt:nth-child(2)'));
  await step('launch it', () => hold('.go .hold'), { moves: true, settle: 900, expect: '.trip-row' });
  await step('second machine boots', async () => {}, { settle: 6000, expect: '.trip .ssh.ready' });
  await step('copy the second SSH command', () => click('.trip .btn.copy'), { settle: 400 });
  await step('load the page afresh: one drawer out, once', async () => {
    // a full load with the drawing's frame log on (a hash change alone would not reload the page)
    await evaluate(`(() => { history.replaceState(null, '', '/#perf'); setTimeout(() => location.reload(), 0); return true; })()`);
    await sleep(300);
    await waitFor('.trip-row', 5000);
    await sleep(3500);
    const bad = await evaluate(DRAWING);
    if (bad.length) throw new Error(bad.join('; '));
  }, { moves: true, fromLoad: true, settle: 200 });
  await step('switch to the first machine', () => click('.trip-row'), { moves: true });
  await step('open End on it', () => click('.trip .btn.end'), { settle: 400, expect: '.sheet .hold' });
  await step('hold End: the card becomes a receipt in its place', () => hold('.sheet .hold'), { settle: 1400, expect: '.receipt' });
  await step('done with the receipt', () => click('.receipt .card-foot .btn'), { moves: true, gone: '.receipt' });
  await step('open settings', () => click('.top .btn.icon'), { moves: true, expect: '.seg' });
  await step('change settings', async () => {
    await click('.seg button:nth-child(2)');
    await sleep(150);
    await click('.seg button:nth-child(1)');
    await sleep(150);
    await click('.check input');
    await sleep(150);
    await click('.check input');
  });
  await step('open add credits', () => click('.top .btn:not(.icon):not(.tag)'), { moves: true, expect: '.amounts' });
  await step('pick amounts', async () => {
    await click('.amounts button:nth-child(3)');
    await sleep(150);
    await click('.amounts button:nth-child(1)');
  });
  await step('back', () => click('.back-btn'), { moves: true });
  await step('time passes', async () => {}, { settle: 2000 });

  browser.kill('SIGTERM');
  server.kill('SIGTERM');
  return failures;
}

if (!fs.existsSync(bin)) {
  console.error(`Build first: ${bin} is missing (make build).`);
  process.exit(2);
}
const all = [];
for (const v of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'phone', width: 390, height: 844 },
]) {
  try {
    all.push(...(await run(v)));
  } catch (e) {
    all.push(`${v.name}: ${e.message}`);
    console.log(`  ✗ ${e.message}`);
  }
}
console.log(all.length ? `\n${all.length} problem${all.length > 1 ? 's' : ''}:\n- ${all.join('\n- ')}` : '\nNothing moved that should not have.');
process.exit(all.length ? 1 : 0);
