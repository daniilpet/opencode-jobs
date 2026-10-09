// Одно-подтверждённое обновление плагина jobs из проверенного релиза.
// Инварианты: обновление блокируется активными заданиями и очередью; меняется только
// каталог плагина; прежний runtime сохраняется целиком; провал послемонтажных проверок
// запускает автоматический откат; БД OpenCode и host не затрагиваются.
// Модель не получает инструмента обновления: запуск только человеком из bundle.
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const REPOSITORY = 'daniilpet/opencode-jobs';
const run = promisify(execFile);

export function parseArgs(argv) {
  const result = { mode: 'update', version: undefined, file: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') result.mode = 'check';
    else if (argument === '--file') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--file требует путь к архиву.');
      result.file = value;
    } else if (argument.startsWith('--')) throw new Error(`Неизвестный аргумент: ${argument}`);
    else if (result.version === undefined) result.version = argument;
    else throw new Error('Одна версия за запуск.');
  }
  if (result.file && result.version !== undefined) throw new Error('--file и явная версия несовместимы.');
  return result;
}

export function gate(report) {
  if (!report || typeof report !== 'object') throw new Error('Некорректный агрегат preflight.');
  const reasons = Object.entries(report.blockers ?? {}).map(([name, count]) => `${name}: ${count}`);
  return { ready: reasons.length === 0, reasons };
}

export function verifyChecksum(buffer, sums, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expected = new RegExp(`^([0-9a-f]{64})  ${escaped}$`, 'm').exec(sums);
  if (!expected) throw new Error(`SHA256SUMS не содержит запись для ${name}.`);
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== expected[1]) throw new Error('Архив не совпадает с контрольной суммой.');
  return digest;
}

// Листинг архива допускает только относительные пути без подъёма; источник архива -
// официальный релиз или локальный файл, выбранный человеком.
export function assertSafeListing(listing) {
  for (const member of listing.split(/\r?\n/).filter(Boolean)) {
    const parts = member.split(/[\\/]/).filter(Boolean);
    if (member.startsWith('/') || member.startsWith('\\') || parts.includes('..')) throw new Error(`Недопустимый элемент архива: ${member.slice(0, 60)}.`);
  }
}

export async function resolveRelease({ version, file }, { fetch: fetchImpl = fetch } = {}) {
  if (file) return { version: undefined, name: basename(file), archivePath: resolve(file), sumsPath: resolve(join(dirname(file), 'SHA256SUMS')) };
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`, { headers: { accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`Реестр релизов недоступен: HTTP ${response.status}.`);
  const releases = await response.json();
  const usable = releases.filter((release) => !release.draft);
  const chosen = version ? usable.find((release) => release.tag_name === `v${version}`) : usable[0];
  if (!chosen) throw new Error(version ? `Релиз v${version} не найден.` : 'Доступные релизы не найдены.');
  const archive = chosen.assets.find((asset) => asset.name.startsWith('opencode-jobs-') && asset.name.endsWith('.tar.gz'));
  const sums = chosen.assets.find((asset) => asset.name === 'SHA256SUMS');
  if (!archive || !sums) throw new Error('В релизе нет архива или контрольных сумм.');
  return { version: chosen.tag_name.replace(/^v/, ''), name: archive.name, archiveUrl: archive.browser_download_url, sumsUrl: sums.browser_download_url };
}

async function elevatedBroker(helper, dir) {
  // Одно UAC-подтверждение на цикл stop->start: брокер ждёт файл-маркер go между фазами.
  const script = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${helper.replaceAll("'", "''")}','${dir.replaceAll('\\', '\\\\').replaceAll("'", "''")}'); exit $p.ExitCode`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  const stopped = new Promise((resolveStop, rejectStop) => {
    const deadline = Date.now() + 300000;
    const timer = setInterval(() => {
      if (readFileSync(join(dir, 'stopped'), 'utf8') === 'ok') {
        clearInterval(timer);
        resolveStop();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        rejectStop(new Error('Истёк срок ожидания остановки задачи.'));
      }
    }, 200);
    exited.then((code) => {
      clearInterval(timer);
      rejectStop(new Error(code === null || code === 1 ? 'Окно повышения прав закрыто или помощник не запущен.' : `Помощник задачи завершился с кодом ${code}.`));
    });
  });
  return {
    stopped,
    async release() {
      await writeFile(join(dir, 'go'), 'ok');
      await exited;
      const outcome = await readFile(join(dir, 'done')).catch(() => 'unknown');
      if (outcome !== 'ok') throw new Error(`Запуск задачи не подтверждён помощником (${outcome}).`);
    },
  };
}

export const controllers = {
  linux: {
    stop: () => run('systemctl', ['--user', 'stop', 'opencode-jobs.service']),
    start: () => run('systemctl', ['--user', 'start', 'opencode-jobs.service']),
  },
  windows: (helper) => {
    let broker = null;
    return {
      async stop() {
        if (broker) throw new Error('Повторная остановка без запуска.');
        const dir = await mkdtemp(join(tmpdir(), 'jobs-update-task-'));
        broker = await elevatedBroker(helper, dir);
        await broker.stopped;
      },
      async start() {
        if (!broker) throw new Error('Запуск без остановки.');
        const current = broker;
        broker = null;
        await current.release();
      },
    };
  },
};

async function preflightVia(pluginDir, attempt) {
  const url = `${pathToFileURL(join(pluginDir, 'src', 'bridge.js')).href}?update=${attempt}`;
  const { call } = await import(url);
  return call('preflight', {});
}

async function poll(label, check, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await check(attempt);
      if (value !== undefined) return value;
    } catch (error) {
      log(`${label}: попытка ${attempt} не удалась (${error.name})`);
    }
    if (Date.now() > deadline) throw new Error(`${label}: истёк срок ожидания.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

function compareStates(before, after) {
  if (before.jobs !== after.jobs) return `число заданий изменилось: ${before.jobs} -> ${after.jobs}`;
  for (const [status, count] of Object.entries(before.statuses ?? {})) if ((after.statuses ?? {})[status] !== count) return `статус ${status}: ${count} -> ${(after.statuses ?? {})[status] ?? 0}`;
  if (!after.ready) return 'после обновления остались незавершённые операции';
  return null;
}

// Первый rename может попасть в ещё не закрывшийся процесс pump (рабочий каталог - каталог плагина).
async function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code ?? '')) throw error;
      await new Promise((delay) => setTimeout(delay, 250 * attempt));
    }
  }
}

// Обновление одной сессии каталога. Все внешние эффекты проходят через injectables.
export async function runUpdate(options) {
  const { pluginDir, auxDir, controller, archiveBuffer, sumsText, archiveName, targetVersion, mode, log = () => {}, backupsRoot, now = () => Date.now(), preflight = (attempt) => preflightVia(pluginDir, attempt) } = options;
  const current = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
  if (targetVersion && current.version === targetVersion) return { status: 'noop', from: current.version, report: 'Установлена запрошенная версия.' };
  const before = await poll('preflight до обновления', () => preflight(0).then((report) => report), 15000, log);
  let decision = gate(before);
  log(`preflight: jobs=${before.jobs} outbox=${before.outbox} ready=${decision.ready}`);
  if (!decision.ready) {
    if (mode === 'check') return { status: 'blocked', from: current.version, reasons: decision.reasons };
    throw new Error(`Обновление заблокировано активной работой: ${decision.reasons.join(', ')}. Завершите или отмените задания и повторите.`);
  }
  if (mode === 'check') return { status: 'check-ok', from: current.version };
  const digest = verifyChecksum(archiveBuffer, sumsText, archiveName);
  log(`архив проверен: ${digest.slice(0, 16)}…`);
  const backupDir = join(backupsRoot, `update-${targetVersion ?? 'local'}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(backupDir, { recursive: true });
  await cp(pluginDir, join(backupDir, 'plugin-copy'), { recursive: true });
  if (auxDir) await cp(auxDir, join(backupDir, 'auxiliary'), { recursive: true }).catch(() => {});
  const serviceFile = join(homedir(), '.local', 'state', 'opencode', 'service.json');
  await cp(serviceFile, join(backupDir, 'service.json')).catch(() => {});
  const stage = await mkdtemp(join(backupDir, 'stage-'));
  const archivePath = join(stage, archiveName);
  await writeFile(archivePath, archiveBuffer);
  // Относительные аргументы и явный cwd: GNU tar в Git-окружении отвергает абсолютные C:\ пути.
  const listing = await run('tar', ['-tzf', archiveName], { cwd: stage, maxBuffer: 32 * 1024 * 1024 });
  assertSafeListing(listing.stdout);
  await run('tar', ['-xzf', archiveName], { cwd: stage });
  const roots = (await readdir(stage, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith('opencode-jobs-')).map((entry) => entry.name);
  if (roots.length !== 1) throw new Error('Неожиданное содержимое архива.');
  const staged = join(stage, roots[0], '.runtime', 'package');
  const manifest = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
  if (targetVersion && manifest.version !== targetVersion) throw new Error(`Архив содержит версию ${manifest.version}, ожидалась ${targetVersion}.`);
  log(`подготовлено: ${manifest.version}, backup: ${backupDir}`);
  // Повторный gate перед остановкой: согласие UAC может задержаться, состояние могло измениться.
  const baseline = await poll('preflight перед остановкой', () => preflight(0).then((report) => report), 15000, log);
  decision = gate(baseline);
  if (!decision.ready) throw new Error(`Обновление заблокировано активной работой: ${decision.reasons.join(', ')}. Завершите или отмените задания и повторите.`);
  await controller.stop();
  try {
    await renameWithRetry(pluginDir, join(backupDir, 'plugin-original'));
    try {
      await renameWithRetry(staged, pluginDir);
    } catch (error) {
      await rename(join(backupDir, 'plugin-original'), pluginDir);
      throw error;
    }
  } catch (error) {
    await controller.start().catch(() => {});
    throw new Error(`Замена каталога не завершена: ${error.message}. Прежний runtime в ${backupDir}.`);
  }
  try {
    await controller.start();
    const after = await poll('проверка после обновления', async (attempt) => {
      const installed = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
      if (installed.version !== manifest.version) return undefined;
      return preflight(attempt);
    }, 45000, log);
    const difference = compareStates(baseline, after);
    if (difference) throw new Error(`Состояние изменилось после обновления: ${difference}.`);
    return { status: 'updated', from: current.version, to: manifest.version, backup: backupDir, jobs: after.jobs };
  } catch (error) {
    log(`проверка не прошла (${error.message}); откат.`);
    await controller.stop().catch(() => {});
    await rm(pluginDir, { recursive: true, force: true });
    await rename(join(backupDir, 'plugin-original'), pluginDir);
    let rollbackNote = '';
    try {
      await controller.start();
    } catch (startError) {
      rollbackNote = ` Запуск после отката не подтверждён (${startError.message}); запустите задачу планировщика вручную.`;
    }
    await poll('проверка после отката', async (attempt) => {
      const installed = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
      if (installed.version !== current.version) return undefined;
      return preflight(attempt);
    }, 45000, log).catch(() => {});
    return { status: 'rolled-back', from: current.version, intended: manifest.version, backup: backupDir, reason: `${error.message}.${rollbackNote}` };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginDir = join(homedir(), '.config', 'opencode', 'plugins', 'jobs');
  const auxDir = join(homedir(), '.local', 'share', 'opencode-jobs');
  const backupsRoot = join(homedir(), '.local', 'state', 'opencode-jobs-backups');
  const release = await resolveRelease(args);
  let archiveBuffer;
  let sumsText;
  if (release.archivePath) {
    archiveBuffer = await readFile(release.archivePath);
    sumsText = await readFile(release.sumsPath, 'utf8');
  } else {
    const [archiveResponse, sumsResponse] = await Promise.all([fetch(release.archiveUrl), fetch(release.sumsUrl)]);
    if (!archiveResponse.ok || !sumsResponse.ok) throw new Error('Не удалось скачать ресурсы релиза.');
    archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
    sumsText = await sumsResponse.text();
  }
  const log = (message) => process.stderr.write(`${message}\n`);
  const controller = process.platform === 'win32'
    ? controllers.windows(join(dirname(process.argv[1] ?? ''), 'update-windows-task.ps1'))
    : controllers.linux;
  const result = await runUpdate({ pluginDir, auxDir, controller, archiveBuffer, sumsText, archiveName: release.name, targetVersion: release.version, mode: args.mode, log, backupsRoot });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status === 'rolled-back') process.exitCode = 4;
  if (result.status === 'blocked') process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
