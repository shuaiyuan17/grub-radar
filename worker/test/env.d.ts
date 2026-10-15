import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('../index');
    }
  }
}
