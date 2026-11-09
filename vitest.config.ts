// Worker tests run inside the Workers runtime (workerd), locally. Calls to Hot Aisle go to a stand-in
// (worker/dev/fake-api.mjs) through the UPSTREAM binding, so nothing here touches the real API.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { fakeHotAisle } from './worker/dev/fake-api.mjs';

const fake = fakeHotAisle();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SESSION_SECRET: 'test-only-secret-0123456789abcdefghijklmnop',
          API_BASE: 'https://api.test/api',
        },
        serviceBindings: {
          UPSTREAM: async (req) => {
            const r = await fake.fetch(req);
            return new Response(r.status === 204 || r.status === 202 ? null : await r.arrayBuffer(), { status: r.status, headers: Object.fromEntries(r.headers) });
          },
        },
      },
    }),
  ],
  test: { include: ['worker/test/**/*.test.ts'] },
});
