// What tests see through `cloudflare:workers`: this Worker's bindings, and its exports.
import type { Env as WorkerEnv } from '../src/hotaisle';

declare global {
  // the sample data, tested here, keeps its state in the browser's sessionStorage (absent in workerd; it copes)
  var sessionStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import('../src/index');
    }
  }
}
