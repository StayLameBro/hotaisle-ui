import { describe, expect, it } from 'vitest';
import { addEnded, emptyRecords, historyOf, HISTORY_LIMIT, pruneMachines, updateMachine, type Ended } from '../../shared/records';

describe('records', () => {
  it('records a launch once, keeping the first launch time', () => {
    const s = emptyRecords();
    updateMachine(s, { team: 't', name: 'a', launched: true, image: 'vllm', price_cents: 299 }, Date.parse('2026-01-01T00:00:00Z'));
    updateMachine(s, { team: 't', name: 'a', launched: true }, Date.parse('2026-01-01T01:00:00Z'));
    expect(s.machines['t/a']).toMatchObject({ launched_at: '2026-01-01T00:00:00.000Z', image: 'vllm', price_cents: 299 });
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
});
