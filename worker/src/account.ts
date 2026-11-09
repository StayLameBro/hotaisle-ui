// One Durable Object per Hot Aisle account (named by a hash of its email): the account's machine records,
// its history of ended machines, and its auto-end timers, which fire as a Durable Object alarm even with
// every browser closed.
//
// To end a machine on time the alarm needs a token, so the account keeps the latest one it was used with,
// encrypted at rest (AES-GCM, under a key derived from SESSION_SECRET), and only while a timer is pending.
// With no timers left it is deleted.

import { DurableObject } from 'cloudflare:workers';
import {
  addEnded,
  checkUpdate,
  emptyRecords,
  fireTimers,
  historyOf,
  listMachines,
  nextRelease,
  pruneMachines,
  updateMachine,
  type Ended,
  type MachineUpdate,
  type RecordsState,
} from '../../shared/records';
import { upstream, type Credential, type Env } from './hotaisle';
import { deriveKey, open, seal } from './session';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, message: string) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export class Account extends DurableObject<Env> {
  private async load(): Promise<RecordsState> {
    return (await this.ctx.storage.get<RecordsState>('records')) ?? emptyRecords();
  }

  /** Saves the records, keeps the alarm on the next timer, and keeps a token only while one is pending. */
  private async save(s: RecordsState, cred?: Credential) {
    await this.ctx.storage.put('records', s);
    const next = nextRelease(s);
    if (next == null) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete('token');
      return;
    }
    if (cred) await this.ctx.storage.put('token', await seal(await deriveKey(this.env.SESSION_SECRET, 'token at rest'), cred));
    const at = await this.ctx.storage.getAlarm();
    if (at == null || at !== next) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  private async credential(): Promise<Credential | undefined> {
    const sealed = await this.ctx.storage.get<string>('token');
    return sealed ? open<Credential>(await deriveKey(this.env.SESSION_SECRET, 'token at rest'), sealed) : undefined;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const team = url.searchParams.get('team') ?? '';
    // the credential of the request this came from, so a pending timer can still end its machine later
    let token: Credential | undefined;
    try {
      token = JSON.parse(req.headers.get('X-Hotaisle-Credential') ?? 'null') ?? undefined;
    } catch {
      token = undefined;
    }
    const s = await this.load();
    const body = async <T>(limit: number): Promise<T | undefined> => {
      const text = await req.text();
      if (text.length > limit) return undefined;
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined;
      }
    };
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /machines':
        if (token && nextRelease(s) != null) await this.save(s, token);
        return json(listMachines(s, team));
      case 'POST /machines': {
        const u = await body<MachineUpdate>(4096);
        const bad = checkUpdate(u ?? {});
        if (!u || bad) return fail(400, bad ?? 'body must be JSON');
        const m = updateMachine(s, u);
        await this.save(s, token);
        return json(m);
      }
      case 'POST /machines/prune': {
        const u = await body<{ team: string; names: string[] }>(65536);
        if (!u?.team || !Array.isArray(u.names)) return fail(400, 'body must be {"team": "handle", "names": [...]}');
        if (pruneMachines(s, u.team, u.names.map(String))) await this.save(s, token);
        return json({ ok: true });
      }
      case 'GET /history':
        return json(historyOf(s, team));
      case 'POST /history': {
        const e = await body<Ended>(16384);
        if (!e?.team || !e.name) return fail(400, 'body must be {"team", "name", "gpus", "ran_ms", "cents", "ended_at"}');
        addEnded(s, { ...e, ended_at: e.ended_at || new Date().toISOString() });
        await this.save(s, token);
        return json({ ok: true });
      }
    }
    return fail(404, 'not found');
  }

  /** Auto-end: ends every machine whose time has come, records it, and sets the alarm for the next one. */
  async alarm() {
    const s = await this.load();
    const cred = await this.credential();
    await fireTimers(s, async (path) => {
      if (!cred) return { status: 0, message: 'no token: sign in again so auto-end can end it' };
      const r = await upstream(this.env, 'DELETE', path, { cred });
      return { status: r.status, message: (await r.text()).trim() };
    });
    await this.save(s);
  }
}
