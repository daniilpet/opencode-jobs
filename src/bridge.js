import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { anchorDirectory } from './paths.js';

// Политика host: контракт стабилен внутри 2.x, полом — 2.0.22 (старейшая проверенная).
// Новые 2.x принимаются по совпадению контракта; сломанные версии блокируются точечно.
const blocked = new Set([]);
const supportedHost = (version) => {
  if (blocked.has(version)) return false;
  // Только канонические трёхкомпонентные версии: пререлизы и сборки host не принимаются.
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 2 && (minor > 0 || patch >= 22);
};

async function registration(signal) {
  try {
    const file = process.env.OPENCODE_JOBS_SERVICE_FILE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'opencode', 'service.json');
    const info = JSON.parse(await readFile(file, { encoding: 'utf8', signal }));
    if (!info || typeof info.url !== 'string' || typeof info.password !== 'string' || !info.password.trim()
      || !Number.isSafeInteger(info.pid) || info.pid <= 0 || (info.version !== undefined && !supportedHost(info.version))) throw new Error();
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(info.url)) throw new Error();
    const url = new URL(info.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return { url, pid: info.pid, version: info.version, headers: { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString('base64')}` } };
  } catch {
    throw new Error('Недоступна или некорректна локальная регистрация OpenCode (host 2.x начиная с 2.0.22).');
  }
}

async function send(url, options) {
  // manual не следует Location и сохраняет отмену body в Undici 6.21.1 (#4627).
  const response = await fetch(url, { ...options, redirect: 'manual' }).catch(() => {
    throw new Error('Локальный запрос OpenCode прерван или не выполнен.');
  });
  if (!response.ok) {
    const error = new Error(`OpenCode: HTTP ${response.status}.`);
    await response.body?.cancel().catch(() => { throw error; });
    throw error;
  }
  if (response.status === 204) return;
  return response.json().catch(() => {
    throw new Error('Некорректный ответ локального сервера OpenCode.');
  });
}

// Регистрация | Discovery | API | Результат
// Неверная | любой | любой | ошибка без сети
// Верная | несовпадение version/pid, ошибка/auth | любой | ошибка без API
// Верная | redirect | любой | ошибка без перехода и без API
// Верная | ready | redirect/ошибка | ошибка без перехода
// Верная | ready | 2xx | JSON либо undefined для 204
// Один снимок регистрации; localhost закреплён за 127.0.0.1 без DNS.
export async function request(path, { method = 'GET', body, directory, signal } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\#\u0000-\u0020\u007f]/.test(path)) throw new Error('Некорректный путь OpenCode API.');
  const controller = new AbortController();
  // Таймер удерживает controller до полного чтения body, в том числе после GC.
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    signal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
    const endpoint = await registration(signal);
    const url = new URL(path, endpoint.url);
    if (url.origin !== endpoint.url.origin || !url.pathname.startsWith('/api/')) throw new Error('Некорректный путь OpenCode API.');
    let info;
    try {
      info = await send(new URL('/api/info', endpoint.url), { headers: endpoint.headers, signal });
    } catch {
      throw new Error('Локальный сервер OpenCode недоступен.');
    }
    if (!info || !supportedHost(info.version) || info.pid !== endpoint.pid || (endpoint.version !== undefined && info.version !== endpoint.version)) throw new Error('Локальный сервер OpenCode не соответствует регистрации (ожидается host 2.x начиная с 2.0.22).');
    if (directory) url.searchParams.set('location[directory]', directory);
    return await send(url, {
      method,
      signal,
      headers: { ...endpoint.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function call(method, input, signal) {
  const result = await request(`/api/rpc/opencode-jobs/${method}`, { method: 'POST', body: { input }, directory: anchorDirectory(), signal });
  return result.output;
}

export { supportedHost };
