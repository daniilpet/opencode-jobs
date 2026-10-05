import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { packageRelease } from '../scripts/package-release.js';

async function temporaryDirectory() {
  const parent = process.platform === 'win32' ? join(tmpdir(), 'opencode') : tmpdir();
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'jobs-release-test-'));
}

async function fixture() {
  const root = await temporaryDirectory();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'opencode-jobs', version: '0.1.0' }));
  await mkdir(join(root, '.runtime', 'package'), { recursive: true });
  await writeFile(join(root, '.runtime', 'package', 'index.js'), 'export default {};');
  await writeFile(join(root, '.runtime', 'package', 'tui.js'), 'export default {};');
  for (const name of ['README.md', 'DEPLOYMENT.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.txt', 'docs', 'scripts']) {
    await cp(name, join(root, name), { recursive: true });
  }
  await mkdir(join(root, '.codex'));
  await writeFile(join(root, '.codex', 'private-note.md'), 'NOT_FOR_PUBLICATION');
  return root;
}

test('release contains installer-compatible layout, notices and a valid checksum without private material', async () => {
  const root = await fixture();
  const result = await packageRelease(root);
  const listing = spawnSync('tar', ['-tzf', basename(result.archive)], { cwd: dirname(result.archive), encoding: 'utf8' });
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /opencode-jobs-0\.1\.0\/\.runtime\/package\/index\.js/);
  assert.match(listing.stdout, /scripts\/install-windows\.ps1/);
  assert.match(listing.stdout, /scripts\/install-linux\.sh/);
  assert.match(listing.stdout, /scripts\/verify-install\.js/);
  assert.match(listing.stdout, /\/LICENSE/);
  assert.match(listing.stdout, /opencode-jobs-0\.1\.0\/package\.json/);
  assert.match(listing.stdout, /THIRD-PARTY-NOTICES\.txt/);
  assert.doesNotMatch(listing.stdout, /\.codex|node_modules|private-note|smoke\.js/);
  const hash = createHash('sha256').update(await readFile(result.archive)).digest('hex');
  assert.equal(await readFile(result.checksums, 'utf8'), `${hash}  opencode-jobs-0.1.0.tar.gz\n`);
});

test('release packaging refuses to overwrite an existing version', async () => {
  const root = await fixture();
  const result = await packageRelease(root);
  const before = await readFile(result.archive);
  await assert.rejects(packageRelease(root), /exists|EEXIST/i);
  assert.deepEqual(await readFile(result.archive), before);
});

test('release packaging refuses an unbuilt checkout', async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'opencode-jobs', version: '0.1.0' }));
  await assert.rejects(packageRelease(root), /build/i);
});

test('private artifacts accidentally placed in the runtime block release packaging', async () => {
  const root = await fixture();
  await mkdir(join(root, '.runtime', 'package', '.codex'));
  await writeFile(join(root, '.runtime', 'package', '.codex', 'note.md'), 'private');
  await assert.rejects(packageRelease(root), /private|\.codex/i);
});
