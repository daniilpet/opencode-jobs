import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../src/scheduler.js';
import plugin from '../src/index.js';
import { parseArgs, gate, verifyChecksum, assertSafeListing, resolveRelease } from '../scripts/update.js';

function schedulerFixture(initial) {
  let snapshot = initial;
  const scheduler = new Scheduler({
    load: async () => snapshot,
    save: async (value) => { snapshot = structuredClone(value); },
    prepareWorker: async (job) => `ses_worker_${job.id}`,
    observeWorker: async () => ({ status: 'running' }),
    stopWorker: async () => {},
    deliver: async () => {},
    isPending: async () => false,
    wasAdmitted: async () => false,
    cancelDelivery: async () => {},
  });
  return { scheduler, saved: () => snapshot };
}

test('updatePreflight: пустое состояние готово к обновлению', async () => {
  const f = schedulerFixture();
  await f.scheduler.load(0);
  const report = f.scheduler.updatePreflight();
  assert.equal(report.ready, true);
  assert.equal(report.jobs, 0);
  assert.equal(report.outbox, 0);
  assert.deepEqual(report.blockers, {});
});

test('updatePreflight: активное задание блокирует, отмена разблокирует', async () => {
  const f = schedulerFixture();
  await f.scheduler.load(0);
  const job = await f.scheduler.add('ses_one', { kind: 'background', command: 'SECRET-COMMAND-1', timeout: 60000 }, 0);
  let report = f.scheduler.updatePreflight();
  assert.equal(report.ready, false);
  assert.equal(report.blockers.active, 1);
  assert.equal(report.nonTerminal, 1);
  assert.ok(!JSON.stringify(report).includes('SECRET-COMMAND-1'));
  await f.scheduler.cancel('ses_one', job.id);
  report = f.scheduler.updatePreflight();
  assert.equal(report.ready, true);
  assert.equal(report.statuses.cancelled, 1);
});

test('updatePreflight: ожидающий финализации результат и очередь блокируют завершённое задание', async () => {
  const f = schedulerFixture({ version: 1, jobs: [{ id: 'job_x', kind: 'loop', sessionID: 'ses_one', status: 'completed', created: 1, sequence: 0, coalesced: 0, timeout: 60000, workerResult: { text: 'SECRET-RESULT-1' } }], outbox: [{ id: 'msg_pending', jobID: 'job_x', sessionID: 'ses_one', type: 'output', text: 'SECRET-OUTPUT-1', created: 2, due: 2 }] });
  await f.scheduler.load(0);
  const report = f.scheduler.updatePreflight();
  assert.equal(report.ready, false);
  assert.equal(report.blockers.workerResult, 1);
  assert.equal(report.blockers.outbox, 1);
  assert.ok(!JSON.stringify(report).includes('SECRET-RESULT-1'));
  assert.ok(!JSON.stringify(report).includes('SECRET-OUTPUT-1'));
});

async function rpcFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jobs-preflight-'));
  const previousState = process.env.OPENCODE_JOBS_STATE;
  process.env.OPENCODE_JOBS_STATE = root;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/info') return send({ version: '2.0.22', pid: process.pid });
    send({ unexpected: url.pathname }, 500);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registration = join(root, 'service.json');
  await writeFile(registration, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, password: 'synthetic-preflight-password', pid: process.pid, version: '2.0.22' }));
  const previousService = process.env.OPENCODE_JOBS_SERVICE_FILE;
  process.env.OPENCODE_JOBS_SERVICE_FILE = registration;
  const store = new Map();
  const registered = {};
  const noop = () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory: join(root, 'anchor') },
    storage: { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, structuredClone(value)); } },
    rpc: { register: (contract, handlers) => { Object.assign(registered, handlers); return noop(); } },
    tool: { transform: (fn) => { fn({ add: () => {} }); return noop(); }, hook: noop },
    command: { transform: (fn) => { fn({ add: () => {} }); return noop(); } },
    session: { hook: noop, get: async ({ sessionID }) => ({ id: sessionID, title: `Сессия ${sessionID}`, location: { directory: 'C:/synthetic/project' } }), update: async () => {}, interrupt: async () => {}, wait: async () => {} },
  };
  const cleanup = await plugin.setup(ctx);
  const call = (name, input) => registered[name](input, { signal: AbortSignal.timeout(10000) });
  t.after(() => {
    if (previousState === undefined) delete process.env.OPENCODE_JOBS_STATE;
    else process.env.OPENCODE_JOBS_STATE = previousState;
    if (previousService === undefined) delete process.env.OPENCODE_JOBS_SERVICE_FILE;
    else process.env.OPENCODE_JOBS_SERVICE_FILE = previousService;
    server.closeAllConnections();
    return Promise.all([new Promise((resolve) => server.close(resolve)), cleanup()]);
  });
  return { call };
}

test('RPC preflight: пусто -> готово; активное задание -> блокировка без содержимого', async (t) => {
  const f = await rpcFixture(t);
  const before = await f.call('preflight', {});
  assert.equal(before.ready, true);
  await f.call('create', { sessionID: 'ses_root', name: 'background', raw: 'SECRET-RPC-COMMAND' });
  const during = await f.call('preflight', {});
  assert.equal(during.ready, false);
  assert.equal(during.blockers.active, 1);
  assert.ok(!JSON.stringify(during).includes('SECRET-RPC-COMMAND'));
});

test('parseArgs: режимы и аргументы обновления', () => {
  assert.deepEqual(parseArgs([]), { mode: 'update', version: undefined, file: undefined });
  assert.deepEqual(parseArgs(['--check']), { mode: 'check', version: undefined, file: undefined });
  assert.deepEqual(parseArgs(['--check', '0.5.0']), { mode: 'check', version: '0.5.0', file: undefined });
  assert.deepEqual(parseArgs(['--file', 'archive.tar.gz']), { mode: 'update', version: undefined, file: 'archive.tar.gz' });
  assert.throws(() => parseArgs(['--file']), /требует путь/);
  assert.throws(() => parseArgs(['--unknown']), /Неизвестный аргумент/);
  assert.throws(() => parseArgs(['0.5.0', '0.6.0']), /Одна версия/);
});

test('gate: решение по агрегату preflight', () => {
  assert.deepEqual(gate({ ready: true, blockers: {} }), { ready: true, reasons: [] });
  const blocked = gate({ ready: false, blockers: { active: 2, outbox: 1 } });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.reasons, ['active: 2', 'outbox: 1']);
  assert.throws(() => gate(null), /агрегат/);
});

test('verifyChecksum: сверка с SHA256SUMS', async () => {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update('payload').digest('hex');
  assert.equal(verifyChecksum(Buffer.from('payload'), `${digest}  opencode-jobs-0.5.0.tar.gz\n`, 'opencode-jobs-0.5.0.tar.gz'), digest);
  assert.throws(() => verifyChecksum(Buffer.from('tampered'), `${digest}  opencode-jobs-0.5.0.tar.gz\n`, 'opencode-jobs-0.5.0.tar.gz'), (error) => error.message.includes('контрольной суммой'));
  assert.throws(() => verifyChecksum(Buffer.from('payload'), 'no-match-here\n', 'opencode-jobs-0.5.0.tar.gz'), /SHA256SUMS/);
});

import { execFile } from 'node:child_process';
import { mkdir, readFile as readFileAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runUpdate } from '../scripts/update.js';
const run = promisify(execFile);

async function bundle(root, version) {
  const packageRoot = join(root, `opencode-jobs-${version}`, '.runtime', 'package');
  await mkdir(packageRoot, { recursive: true });
  await writeFileAsync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'opencode-jobs', version, type: 'module', private: true }));
  await writeFileAsync(join(packageRoot, 'index.js'), `export default ${JSON.stringify(version)};\n`);
  const { createHash } = await import('node:crypto');
  await run('tar', ['-czf', `opencode-jobs-${version}.tar.gz`, `opencode-jobs-${version}`], { cwd: root });
  const archive = await readFileAsync(join(root, `opencode-jobs-${version}.tar.gz`));
  return { archive, sums: `${createHash('sha256').update(archive).digest('hex')}  opencode-jobs-${version}.tar.gz\n`, name: `opencode-jobs-${version}.tar.gz` };
}

test('runUpdate: успешная замена с backup и сохранением состояния', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-update-flow-'));
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })));
  const pluginDir = join(root, 'plugins', 'jobs');
  await mkdir(pluginDir, { recursive: true });
  await writeFileAsync(join(pluginDir, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  await writeFileAsync(join(pluginDir, 'index.js'), 'old');
  const { archive, sums, name } = await bundle(join(root, 'bundle'), '0.5.0');
  const events = [];
  const reports = { jobs: 1, statuses: { completed: 1 }, blockers: {}, ready: true };
  const result = await runUpdate({
    pluginDir, auxDir: undefined, controller: { stop: async () => events.push('stop'), start: async () => events.push('start') },
    archiveBuffer: archive, sumsText: sums, archiveName: name, targetVersion: '0.5.0', mode: 'update',
    backupsRoot: join(root, 'backups'), preflight: async () => reports,
  });
  assert.equal(result.status, 'updated');
  assert.equal(result.from, '0.4.0');
  assert.equal(result.to, '0.5.0');
  assert.equal(JSON.parse(await readFileAsync(join(pluginDir, 'package.json'))).version, '0.5.0');
  assert.equal(JSON.parse(await readFileAsync(join(result.backup, 'plugin-original', 'package.json'))).version, '0.4.0');
  assert.deepEqual(events, ['stop', 'start']);
});

test('runUpdate: изменение состояния откатывает прежний runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-update-rollback-'));
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })));
  const pluginDir = join(root, 'plugins', 'jobs');
  await mkdir(pluginDir, { recursive: true });
  await writeFileAsync(join(pluginDir, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  const { archive, sums, name } = await bundle(join(root, 'bundle'), '0.5.0');
  const events = [];
  const result = await runUpdate({
    pluginDir, auxDir: undefined, controller: { stop: async () => events.push('stop'), start: async () => events.push('start') },
    archiveBuffer: archive, sumsText: sums, archiveName: name, targetVersion: '0.5.0', mode: 'update',
    backupsRoot: join(root, 'backups'),
    preflight: async () => {
      const installed = JSON.parse(await readFileAsync(join(pluginDir, 'package.json')));
      return installed.version === '0.5.0' ? { jobs: 2, statuses: { completed: 2 }, blockers: {}, ready: true } : { jobs: 1, statuses: { completed: 1 }, blockers: {}, ready: true };
    },
  });
  assert.equal(result.status, 'rolled-back');
  assert.equal(result.from, '0.4.0');
  assert.ok(result.reason.includes('число заданий'));
  assert.equal(JSON.parse(await readFileAsync(join(pluginDir, 'package.json'))).version, '0.4.0');
  assert.deepEqual(events, ['stop', 'start', 'stop', 'start']);
});

test('assertSafeListing: абсолютные пути и подъём каталогов отвергаются', () => {
  assertSafeListing('opencode-jobs-0.5.0/.runtime/package/package.json\n');
  assert.throws(() => assertSafeListing('/etc/passwd\n'), /Недопустимый элемент/);
  assert.throws(() => assertSafeListing('opencode-jobs-0.5.0/../../evil.txt\n'), /Недопустимый элемент/);
  assert.throws(() => assertSafeListing('..\\evil\n'), /Недопустимый элемент/);
});

test('resolveRelease: офлайн --file ожидает SHA256SUMS рядом', async () => {
  const release = await resolveRelease({ file: 'dir/opencode-jobs-0.5.0.tar.gz' });
  assert.equal(release.name, 'opencode-jobs-0.5.0.tar.gz');
  assert.ok(release.archivePath.endsWith('opencode-jobs-0.5.0.tar.gz'));
  assert.ok(release.sumsPath.endsWith(join('dir', 'SHA256SUMS')));
});

test('resolveRelease: черновики пропускаются, версия и ассеты выбираются', async () => {
  const asset = (name) => ({ name, browser_download_url: `https://example.invalid/${name}` });
  const fetchImpl = async (url) => ({ ok: true, json: async () => [
    { draft: true, tag_name: 'v9.9.9', assets: [] },
    { draft: false, tag_name: 'v0.5.0', assets: [asset('opencode-jobs-0.5.0.tar.gz'), asset('SHA256SUMS')] },
    { draft: false, tag_name: 'v0.4.0', assets: [asset('opencode-jobs-0.4.0.tar.gz'), asset('SHA256SUMS')] },
  ] });
  assert.equal((await resolveRelease({ version: undefined }, { fetch: fetchImpl })).version, '0.5.0');
  assert.equal((await resolveRelease({ version: '0.4.0' }, { fetch: fetchImpl })).version, '0.4.0');
  await assert.rejects(resolveRelease({ version: '0.3.0' }, { fetch: fetchImpl }), /не найден/);
  const broken = async () => ({ ok: true, json: async () => [{ draft: false, tag_name: 'v0.5.0', assets: [asset('opencode-jobs-0.5.0.tar.gz')] }] });
  await assert.rejects(resolveRelease({ version: undefined }, { fetch: broken }), /контрольных сумм/);
});

test('runUpdate: установленная версия не меняется (noop)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-update-noop-'));
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })));
  const pluginDir = join(root, 'plugins', 'jobs');
  await mkdir(pluginDir, { recursive: true });
  await writeFileAsync(join(pluginDir, 'package.json'), JSON.stringify({ version: '0.5.0' }));
  const { archive, sums, name } = await bundle(join(root, 'bundle'), '0.5.0');
  const events = [];
  const result = await runUpdate({
    pluginDir, auxDir: undefined, controller: { stop: async () => events.push('stop'), start: async () => events.push('start') },
    archiveBuffer: archive, sumsText: sums, archiveName: name, targetVersion: '0.5.0', mode: 'update',
    backupsRoot: join(root, 'backups'), preflight: async () => ({ jobs: 0, statuses: {}, blockers: {}, ready: true }),
  });
  assert.equal(result.status, 'noop');
  assert.deepEqual(events, []);
});

test('runUpdate: офлайн-архив обнаруживает каталог распаковки по содержимому', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-update-file-'));
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })));
  const pluginDir = join(root, 'plugins', 'jobs');
  await mkdir(pluginDir, { recursive: true });
  await writeFileAsync(join(pluginDir, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  const { archive, sums, name } = await bundle(join(root, 'bundle'), '0.5.1');
  const events = [];
  const result = await runUpdate({
    pluginDir, auxDir: undefined, controller: { stop: async () => events.push('stop'), start: async () => events.push('start') },
    archiveBuffer: archive, sumsText: sums, archiveName: name, targetVersion: undefined, mode: 'update',
    backupsRoot: join(root, 'backups'), preflight: async () => ({ jobs: 3, statuses: { completed: 3 }, blockers: {}, ready: true }),
  });
  assert.equal(result.status, 'updated');
  assert.equal(result.to, '0.5.1');
  assert.equal(JSON.parse(await readFileAsync(join(pluginDir, 'package.json'))).version, '0.5.1');
});

test('runUpdate: блокировка и --check не меняют файлы', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jobs-update-blocked-'));
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true })));
  const pluginDir = join(root, 'plugins', 'jobs');
  await mkdir(pluginDir, { recursive: true });
  await writeFileAsync(join(pluginDir, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  const { archive, sums, name } = await bundle(join(root, 'bundle'), '0.5.0');
  const blocked = { jobs: 1, statuses: { active: 1 }, blockers: { active: 1 }, ready: false };
  const events = [];
  const base = { pluginDir, auxDir: undefined, controller: { stop: async () => events.push('stop'), start: async () => events.push('start') }, archiveBuffer: archive, sumsText: sums, archiveName: name, targetVersion: '0.5.0', backupsRoot: join(root, 'backups'), preflight: async () => blocked };
  const check = await runUpdate({ ...base, mode: 'check' });
  assert.equal(check.status, 'blocked');
  assert.deepEqual(check.reasons, ['active: 1']);
  await assert.rejects(runUpdate({ ...base, mode: 'update' }), (error) => error.message.includes('заблокировано'));
  assert.equal(JSON.parse(await readFileAsync(join(pluginDir, 'package.json'))).version, '0.4.0');
  assert.deepEqual(events, []);
});
