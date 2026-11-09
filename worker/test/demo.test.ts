// The sample data (web/src/demo/api.ts) runs in the browser; it is tested here, in the Workers runtime,
// which has the same web APIs it uses.
import { beforeEach, describe, expect, it } from 'vitest';
import { demoFetch, resetDemo } from '../../web/src/demo/api';

const T = '/api/teams/demo-lab';
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQxuQk1cH8WkaQ3w6cABiyfRruEmtY280ryshxbN5f3 demo';

beforeEach(() => resetDemo());

describe('sample data', () => {
  it('needs an SSH key before it launches anything, as the real API does', async () => {
    expect((await demoFetch('POST', `${T}/virtual_machines/`, { gpus: [{ count: 1 }] })).status).toBe(428);
  });

  it('places machines where the app previews them: next to yours while there is room, else a free server', async () => {
    expect((await demoFetch('POST', '/api/user/ssh_keys/', { authorized_key: KEY })).status).toBe(200);
    const hostOf = async (n: number) => {
      const v = await demoFetch('POST', `${T}/virtual_machines/`, { gpus: [{ count: n, model: 'MI300X' }] });
      expect(v.status).toBe(200);
      const st = await demoFetch('GET', `${T}/virtual_machines/${(v.body as { name: string }).name}/state/`);
      return (st.body as { host: string }).host;
    };
    expect([await hostOf(4), await hostOf(4), await hostOf(2), await hostOf(2)]).toEqual(['enc1-host-07', 'enc1-host-07', 'enc1-host-15', 'enc1-host-15']);
  });

  it('reserves a whole free server as bare metal, installs it, and frees it on release', async () => {
    const avail = (await demoFetch('GET', `${T}/bare_metal/available/`)).body as { Quantity: number; MinimumReservationMinutes: number; OnDemandPrice: number }[];
    expect(avail).toMatchObject([{ Quantity: 2, MinimumReservationMinutes: 480, OnDemandPrice: 2712 }]);
    const r = await demoFetch('POST', `${T}/bare_metal/`, { specs: {} });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'enc1-host-07', os_status: { os_install_status: 'shutting_down' } });
    expect((await demoFetch('POST', `${T}/bare_metal/`, { specs: {} })).status).toBe(201);
    expect((await demoFetch('POST', `${T}/bare_metal/`, { specs: {} })).status).toBe(404);
    // inside the 8-hour minimum: refused without force, released with it
    expect((await demoFetch('DELETE', `${T}/bare_metal/enc1-host-07/`)).status).toBe(400);
    expect((await demoFetch('DELETE', `${T}/bare_metal/enc1-host-07/?force=true`)).status).toBe(204);
    expect(((await demoFetch('GET', `${T}/bare_metal/available/`)).body as { Quantity: number }[])[0].Quantity).toBe(1);
  });

  it('keeps records and ends machines on their timers, like the real backend', async () => {
    await demoFetch('POST', '/api/user/ssh_keys/', { authorized_key: KEY });
    const v = (await demoFetch('POST', `${T}/virtual_machines/`, { gpus: [{ count: 1 }] })).body as { name: string };
    expect((await demoFetch('POST', '/records/machines', { team: 'demo-lab', name: v.name, launched: true, release_in_minutes: 60 })).status).toBe(200);
    const list = (await demoFetch('GET', '/records/machines?team=demo-lab')).body as { name: string; release_at?: string }[];
    expect(list[0]).toMatchObject({ name: v.name });
    expect(list[0].release_at).toBeTruthy();
  });
});
