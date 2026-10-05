import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const directory of ['src', 'scripts', 'test']) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else process.stdout.write('Синтаксис JavaScript проверен.\n');
