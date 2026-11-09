// One Durable Object per Hot Aisle account (named by a hash of its email): the account's machine records (when
// each was launched, with which image, at what price) and its history of ended machines. It holds no tokens.

import { DurableObject } from 'cloudflare:workers';
import { addEnded, checkUpdate, emptyRecords, historyOf, listMachines, pruneMachines, updateMachine, type Ended, type MachineUpdate, type RecordsState } from '../../shared/records';
import type { Env } from './hotaisle';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, message: string) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export class Account extends DurableObject<Env> {
  private async load(): Promise<RecordsState> {
    return (await this.ctx.storage.get<RecordsState>('records')) ?? emptyRecords();
  }

  private save(s: RecordsState) {
    return this.ctx.storage.put('records', s);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const team = url.searchParams.get('team') ?? '';
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
        return json(listMachines(s, team));
      case 'POST /machines': {
        const u = await body<MachineUpdate>(4096);
        const bad = checkUpdate(u ?? {});
        if (!u || bad) return fail(400, bad ?? 'body must be JSON');
        const m = updateMachine(s, u);
        await this.save(s);
        return json(m);
      }
      case 'POST /machines/prune': {
        const u = await body<{ team: string; names: string[] }>(65536);
        if (!u?.team || !Array.isArray(u.names)) return fail(400, 'body must be {"team": "handle", "names": [...]}');
        if (pruneMachines(s, u.team, u.names.map(String))) await this.save(s);
        return json({ ok: true });
      }
      case 'GET /history':
        return json(historyOf(s, team));
      case 'POST /history': {
        const e = await body<Ended>(16384);
        if (!e?.team || !e.name) return fail(400, 'body must be {"team", "name", "gpus", "ran_ms", "cents", "ended_at"}');
        addEnded(s, { ...e, ended_at: e.ended_at || new Date().toISOString() });
        await this.save(s);
        return json({ ok: true });
      }
    }
    return fail(404, 'not found');
  }
}
