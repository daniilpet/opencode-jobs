import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { call } from './bridge.js';
import { stateDirectory, anchorDirectory } from './paths.js';

await mkdir(anchorDirectory(), { recursive: true, mode: 0o700 });
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const status = join(stateDirectory(), 'pump-status.json');
while (!stopping) {
  const started = Date.now();
  let health;
  try {
    const result = await call('tick', {});
    health = { pid: process.pid, time: started, ok: true, ...result };
  } catch (error) {
    health = { pid: process.pid, time: started, ok: false, error: error.message };
  }
  await writeFile(status + '.tmp', JSON.stringify(health), { mode: 0o600 });
  await rename(status + '.tmp', status);
  await sleep(Math.max(50, 1000 - (Date.now() - started)));
}
