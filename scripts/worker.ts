import { setTimeout as pause } from 'node:timers/promises';
import { hosted } from '../src/server/config';
import { runEmail, runGeneration } from '../src/server/worker';

async function main() {
  if (!hosted()) throw new Error('The local Next.js process runs the demo worker. Use APP_MODE=hosted for a dedicated worker.');
  let stop = false;
  process.once('SIGTERM', () => { stop = true; });
  process.once('SIGINT', () => { stop = true; });
  while (!stop) {
    try {
      const [generated, sent] = await Promise.all([runGeneration(), runEmail()]);
      if (!generated && !sent) await pause(1500);
    } catch {
      console.error('Worker could not poll its queue. Retrying.');
      await pause(5000);
    }
  }
  process.exit(0);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Worker could not start.');
  process.exitCode = 1;
});
