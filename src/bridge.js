import { Service } from '../vendor/client/promise/service.js';
import { anchorDirectory } from './paths.js';

export async function request(path, { method = 'GET', body, directory, signal } = {}) {
  const endpoint = await Service.discover({ file: process.env.OPENCODE_JOBS_SERVICE_FILE, version: (value) => value === '2.0.22' });
  if (!endpoint) throw new Error('Локальный сервер OpenCode 2.0.22 недоступен.');
  const url = new URL(path, endpoint.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Планировщик подключается только к loopback-серверу.');
  if (directory) url.searchParams.set('location[directory]', directory);
  const response = await fetch(url, {
    method,
    signal: signal ?? AbortSignal.timeout(10000),
    headers: { ...Service.headers(endpoint), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`OpenCode: HTTP ${response.status} при ${method} ${path}.`);
  if (response.status === 204) return;
  return response.json();
}

export async function call(method, input, signal) {
  const result = await request(`/api/rpc/opencode-jobs/${method}`, { method: 'POST', body: { input }, directory: anchorDirectory(), signal });
  return result.output;
}
