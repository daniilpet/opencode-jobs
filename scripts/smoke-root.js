import { mkdir, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Матрица: default -> новый уникальный root; свободный explicit -> эксклюзивное
// создание; существующий файл/каталог/ссылка -> ошибка; гонка -> один владелец.
export async function createSmokeRoot(requestedRoot) {
  if (requestedRoot !== undefined) {
    const root = resolve(requestedRoot);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    return root;
  }
  const parent = process.platform === 'win32' ? join(tmpdir(), 'opencode') : join(homedir(), '.local', 'share');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, 'jobs-smoke-'));
}
