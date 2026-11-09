import { describe, expect, it } from 'vitest';
import { addEnded, emptyRecords, endedByTimer, fireTimers, historyOf, HISTORY_LIMIT, nextRelease, pruneMachines, updateMachine, type Ended } from '../../shared/records';

describe('records', () => {
  it('sets, moves and clears an auto-end timer', () => {
    const s = emptyRecords();
    const now = Date.parse('2026-01-01T00:00:00Z');
    updateMachine(s, { team: 't', name: 'a', launched: true, release_in_minutes: 60 }, now);
    expect(nextRelease(s)).toBe(now + 3600_000);
    updateMachine(s, { team: 't', name: 'a', release_in_minutes: 0 }, now);
    expect(nextRelease(s)).toBeUndefined();
  });

  it('never forgets a machine launched in the last few minutes, whatever a list says', () => {
    const s = emptyRecords();
    const now = Date.now();
    updateMachine(s, { team: 't', name: 'new', launched: true }, now);
    updateMachine(s, { team: 't', name: 'old', launched: true }, now - 3600_000);
    pruneMachines(s, 't', [], now);
    expect(Object.keys(s.machines)).toEqual(['t/new']);
  });

  it('keeps the newest entries per team, one per machine', () => {
    const s = emptyRecords();
    const e = (name: string): Ended => ({ team: 't', name, gpus: '1×', ended_at: '' });
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) addEnded(s, e('m' + i));
    addEnded(s, e('m24'));
    const h = historyOf(s, 't');
    expect(h.length).toBe(HISTORY_LIMIT);
    expect(h.filter((x) => x.name === 'm24').length).toBe(1);
  });

  it('charges the minimum: 30 minutes for a VM, 8 hours for bare metal', () => {
    const now = Date.parse('2026-01-01T01:00:00Z');
    const launched = '2026-01-01T00:50:00Z';
    expect(endedByTimer({ team: 't', name: 'v', launched_at: launched, price_cents: 600 }, now)).toMatchObject({ minimum_applied: true, cents: 300 });
    expect(endedByTimer({ team: 't', name: 'b', launched_at: launched, price_cents: 2712, metal: true }, now).cents).toBe(2712 * 8);
  });

  it('never treats a failed release as success: it retries and says why', async () => {
    const s = emptyRecords();
    const now = Date.now();
    updateMachine(s, { team: 't', name: 'a', launched: true, release_in_minutes: 1 }, now - 120_000);
    updateMachine(s, { team: 't', name: 'gone', launched: true, release_in_minutes: 1 }, now - 120_000);
    updateMachine(s, { team: 't', name: 'metal', launched: true, metal: true, release_in_minutes: 1 }, now - 120_000);
    const paths: string[] = [];
    await fireTimers(s, async (p) => {
      paths.push(p);
      if (p.includes('/gone/')) return { status: 404, message: 'not found' };
      if (p.includes('/a/')) return { status: 500, message: 'boom' };
      return { status: 204, message: '' };
    }, now);
    expect(paths).toContain('/teams/t/bare_metal/metal/?force=true');
    expect(s.machines['t/a'].last_error).toMatch(/500: boom/);
    expect(Date.parse(s.machines['t/a'].release_at!)).toBe(now + 60_000);
    expect(s.machines['t/gone']).toBeUndefined();
    expect(historyOf(s, 't').map((h) => h.name)).toEqual(['metal']);
  });
});
