import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

async function checkRuntime(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.codex', '.git', 'node_modules', 'service.json', 'pump-status.json'].includes(entry.name) || /\.(?:log|sqlite|db)$/.test(entry.name) || entry.isSymbolicLink()) {
      throw new Error(`Private or unsafe runtime artifact: ${entry.name}`);
    }
    if (entry.isDirectory()) await checkRuntime(join(directory, entry.name));
  }
}

export async function packageRelease(root = process.cwd()) {
  const artifact = join(root, '.runtime', 'package');
  if (!existsSync(join(artifact, 'index.js')) || !existsSync(join(artifact, 'tui.js'))) throw new Error('Run npm run build before packaging.');
  await checkRuntime(artifact);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('Invalid release version.');
  const name = `opencode-jobs-${manifest.version}`;
  const releases = join(root, '.runtime', 'releases');
  await mkdir(releases, { recursive: true });
  const output = join(releases, manifest.version);
  await mkdir(output);
  const stage = join(output, 'stage', name);
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', private: true, license: manifest.license }, null, 2) + '\n');
  await cp(artifact, join(stage, '.runtime', 'package'), { recursive: true });
  for (const item of ['README.md', 'DEPLOYMENT.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.txt', 'docs']) {
    await cp(join(root, item), join(stage, item), { recursive: true });
  }
  await mkdir(join(stage, 'scripts'));
  for (const script of ['install-windows.ps1', 'install-linux.sh', 'verify-install.js']) await cp(join(root, 'scripts', script), join(stage, 'scripts', script));
  const archive = join(output, `${name}.tar.gz`);
  const result = spawnSync('tar', ['-czf', `${name}.tar.gz`, '-C', 'stage', name], { cwd: output, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Archive failed: ${result.stderr}`);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  const checksums = join(output, 'SHA256SUMS');
  await writeFile(checksums, `${hash}  ${name}.tar.gz\n`);
  return { archive, checksums };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await packageRelease();
  process.stdout.write(`Release: ${result.archive}\nChecksums: ${result.checksums}\n`);
}
