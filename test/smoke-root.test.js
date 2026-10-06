import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSmokeRoot } from '../scripts/smoke-root.js';

async function fixture() {
  const parent = process.platform === 'win32' ? join(tmpdir(), 'opencode') : tmpdir();
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'jobs-smoke-root-test-'));
}

test('существующий smoke root отклоняется без изменения содержимого', async () => {
  const root = await fixture();
  const sentinel = join(root, 'sentinel.txt');
  await writeFile(sentinel, 'preserve');
  await assert.rejects(createSmokeRoot(root), { code: 'EEXIST' });
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
});

test('пустой существующий smoke root также отклоняется', async () => {
  const root = await fixture();
  await assert.rejects(createSmokeRoot(root), { code: 'EEXIST' });
  assert.deepEqual(await readdir(root), []);
});

test('свободный smoke root создаётся вместе с отсутствующими родителями', async () => {
  const root = join(await fixture(), 'parent', 'nested', 'root');
  assert.equal(await createSmokeRoot(root), root);
  assert.ok((await stat(root)).isDirectory());
  assert.deepEqual(await readdir(root), []);
});

test('файл по пути smoke root не перезаписывается', async () => {
  const root = join(await fixture(), 'root');
  await writeFile(root, 'preserve');
  await assert.rejects(createSmokeRoot(root), { code: 'EEXIST' });
  assert.equal(await readFile(root, 'utf8'), 'preserve');
});

test('ссылка по пути smoke root отклоняется с сохранением цели', async () => {
  const parent = await fixture();
  const target = join(parent, 'target');
  const root = join(parent, 'root');
  await mkdir(target);
  await writeFile(join(target, 'sentinel.txt'), 'preserve');
  await symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSmokeRoot(root), { code: 'EEXIST' });
  assert.ok((await lstat(root)).isSymbolicLink());
  assert.equal(await readFile(join(target, 'sentinel.txt'), 'utf8'), 'preserve');
});

test('ссылка на отсутствующую цель не используется как smoke root', async () => {
  const parent = await fixture();
  const root = join(parent, 'root');
  await symlink(join(parent, 'missing'), root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSmokeRoot(root), { code: 'EEXIST' });
  assert.ok((await lstat(root)).isSymbolicLink());
  await assert.rejects(stat(join(parent, 'missing')), { code: 'ENOENT' });
});

test('из конкурентных запусков только один получает заданный smoke root', async () => {
  const root = join(await fixture(), 'root');
  const results = await Promise.allSettled([createSmokeRoot(root), createSmokeRoot(root)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'fulfilled').value, root);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'EEXIST');
});

test('параллельные default запуски получают разные созданные каталоги', async () => {
  const [first, second] = await Promise.all([createSmokeRoot(), createSmokeRoot()]);
  assert.notEqual(first, second);
  assert.deepEqual(await readdir(first), []);
  assert.deepEqual(await readdir(second), []);
});

test('explicit smoke root закрыт от группы и остальных на POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = await createSmokeRoot(join(await fixture(), 'root'));
  assert.equal((await stat(root)).mode & 0o077, 0);
});

test('default smoke root закрыт от группы и остальных на POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = await createSmokeRoot();
  assert.equal((await stat(root)).mode & 0o077, 0);
});

test('smoke отклоняет существующий root до копирования сборки и запуска сервера', async () => {
  const checkout = await fixture();
  const root = join(checkout, 'root');
  await mkdir(join(root, 'plugin'), { recursive: true });
  await writeFile(join(root, 'plugin', 'sentinel.txt'), 'preserve');
  await mkdir(join(checkout, '.runtime', 'package'), { recursive: true });
  await writeFile(join(checkout, '.runtime', 'package', 'sentinel.txt'), 'overwrite');
  await mkdir(join(checkout, 'scripts'));
  await cp(new URL('../scripts/smoke.js', import.meta.url), join(checkout, 'scripts', 'smoke.js'));
  await cp(new URL('../scripts/smoke-root.js', import.meta.url), join(checkout, 'scripts', 'smoke-root.js'));
  await mkdir(join(checkout, 'vendor', 'client', 'promise'), { recursive: true });
  await writeFile(join(checkout, 'vendor', 'client', 'promise', 'service.js'), 'export const Service = {};');
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
  const result = spawnSync(process.execPath, ['scripts/smoke.js'], {
    cwd: checkout, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, OPENCODE_JOBS_TEST_ROOT: root, OPENCODE_JOBS_CLI: join(checkout, 'missing-cli') },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(await readFile(join(root, 'plugin', 'sentinel.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(root), ['plugin']);
});
