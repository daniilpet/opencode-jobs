import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from '../src/bridge.js';

const info = { version: '2.0.22', pid: process.pid };
const password = 'synthetic-bridge-password';
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

async function server(t, handler, host = '127.0.0.1') {
  const received = [];
  const instance = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, method: req.method, headers: req.headers, body });
    await handler(req, res);
  });
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, host, resolve);
  });
  t.after(() => {
    instance.closeAllConnections();
    return new Promise((resolve) => instance.close(resolve));
  });
  const hostname = host === '::1' ? '[::1]' : host;
  return { url: `http://${hostname}:${instance.address().port}`, received };
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function registration(t, values) {
  const root = await mkdtemp(join(tmpdir(), 'jobs-bridge-test-'));
  const file = join(root, 'service.json');
  const previous = process.env.OPENCODE_JOBS_SERVICE_FILE;
  process.env.OPENCODE_JOBS_SERVICE_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_JOBS_SERVICE_FILE;
    else process.env.OPENCODE_JOBS_SERVICE_FILE = previous;
  });
  await writeFile(file, JSON.stringify({ ...info, password, ...values }));
  return file;
}

test('удалённая регистрация отклоняется до authenticated discovery', async (t) => {
  await registration(t, { url: 'https://synthetic.invalid' });
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
  await assert.rejects(request('/api/info'));
  assert.equal(outbound.mock.callCount(), 0);
});

test('POST redirect не передаёт тело другому серверу', async (t) => {
  const target = await server(t, (_req, res) => json(res, { output: 'leaked' }));
  const source = await server(t, (req, res) => {
    if (req.url === '/api/info') return json(res, info);
    res.writeHead(307, { location: `${target.url}/capture` });
    res.end();
  });
  await registration(t, { url: source.url });
  const result = await request('/api/rpc/opencode-jobs/create', { method: 'POST', body: { input: 'synthetic-private-body' } }).catch((error) => error);
  assert.equal(target.received.length, 0);
  assert.ok(result instanceof Error);
});

for (const [name, values] of [
  ['схема file', { url: 'file:///api/info' }],
  ['схема ftp', { url: 'ftp://127.0.0.1' }],
  ['неверный URL', { url: 'synthetic-private-url' }],
  ['userinfo', { url: 'http://user:synthetic-private-url@127.0.0.1' }],
  ['пустой userinfo', { url: 'http://@127.0.0.1' }],
  ['поддельный localhost', { url: 'http://localhost.synthetic.invalid' }],
  ['иной loopback', { url: 'http://127.0.0.2' }],
  ['пароль отсутствует', { password: undefined }],
  ['пустой пароль', { password: '' }],
  ['пробельный пароль', { password: '   ' }],
  ['пароль неверного типа', { password: 42 }],
  ['неверная версия', { version: '2.0.21' }],
  ['pid отсутствует', { pid: undefined }],
  ['pid строкой', { pid: String(process.pid) }],
  ['pid отрицательный', { pid: -1 }],
  ['pid дробный', { pid: 1.5 }],
]) {
  test(`невалидная регистрация: ${name}, сеть отсутствует`, async (t) => {
    await registration(t, { url: 'http://127.0.0.1', ...values });
    const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
    await assert.rejects(request('/api/info'), (error) => !/synthetic|42/.test(error.message));
    assert.equal(outbound.mock.callCount(), 0);
  });
}

test('повреждённый JSON регистрации отклоняется без сети и утечки содержимого', async (t) => {
  const file = await registration(t, { url: 'http://127.0.0.1' });
  await writeFile(file, '{"password":"synthetic-private-malformed');
  const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
  await assert.rejects(request('/api/info'), (error) => !error.message.includes('synthetic'));
  assert.equal(outbound.mock.callCount(), 0);
});

for (const [name, value, status] of [
  ['версия', { ...info, version: '2.0.21' }, 200],
  ['pid', { ...info, pid: process.pid + 1 }, 200],
  ['pid неверного типа', { ...info, pid: String(process.pid) }, 200],
  ['пустой объект', {}, 200],
  ['null', null, 200],
  ['отказ авторизации', info, 401],
  ['ещё не ready', info, 503],
  ['несовместимый API', info, 404],
]) {
  test(`discovery: ${name}, рабочий API не вызывается`, async (t) => {
    const source = await server(t, (_req, res) => json(res, value, status));
    await registration(t, { url: source.url });
    await assert.rejects(request('/api/rpc/opencode-jobs/list'), (error) => !error.message.includes('HTTP 404'));
    assert.deepEqual(source.received.map((entry) => entry.url), ['/api/info']);
  });
}

test('не-JSON discovery отклоняется без утечки тела', async (t) => {
  const source = await server(t, (_req, res) => res.end('synthetic-private-response'));
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/rpc/opencode-jobs/list'), (error) => !error.message.includes('synthetic'));
  assert.equal(source.received.length, 1);
});

test('discovery redirect не достигает второго сервера и рабочего API', async (t) => {
  const target = await server(t, (_req, res) => json(res, info));
  const source = await server(t, (_req, res) => {
    res.writeHead(302, { location: `${target.url}/api/info` });
    res.end();
  });
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/rpc/opencode-jobs/list'));
  assert.equal(target.received.length, 0);
  assert.deepEqual(source.received.map((entry) => entry.url), ['/api/info']);
});

for (const path of ['https://synthetic.invalid/api/info', '//synthetic.invalid/api/info', '/api/../../outside', '/api/%2e%2e/outside', '/api/\\synthetic.invalid', '/api/info#fragment', '/api/info\nprivate']) {
  test(`невалидный путь ${JSON.stringify(path)} отклоняется до сети`, async (t) => {
    await registration(t, { url: 'http://127.0.0.1' });
    const outbound = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
    await assert.rejects(request(path), (error) => !error.message.includes(path));
    assert.equal(outbound.mock.callCount(), 0);
  });
}

test('JSON POST сохраняет auth, тело, query и directory в том же origin', async (t) => {
  const source = await server(t, (req, res) => json(res, req.url === '/api/info' ? info : { output: 'done' }));
  await registration(t, { url: `${source.url}/ignored/base?ignored=true` });
  const result = await request('/api/rpc/opencode-jobs/create?cursor=2', { method: 'POST', body: { input: 'payload' }, directory: '/synthetic project' });
  assert.deepEqual(result, { output: 'done' });
  assert.equal(source.received[0].headers.authorization, authorization);
  assert.equal(source.received[1].headers.authorization, authorization);
  assert.equal(source.received[1].headers['content-type'], 'application/json');
  assert.equal(source.received[1].body, '{"input":"payload"}');
  assert.equal(source.received[1].method, 'POST');
  assert.equal(source.received[1].url, '/api/rpc/opencode-jobs/create?cursor=2&location%5Bdirectory%5D=%2Fsynthetic+project');
});

test('204 возвращает undefined без попытки разбора JSON', async (t) => {
  const source = await server(t, (req, res) => {
    if (req.url === '/api/info') return json(res, info);
    res.writeHead(204);
    res.end();
  });
  await registration(t, { url: source.url });
  assert.equal(await request('/api/example', { method: 'DELETE' }), undefined);
});

test('ошибка API сохраняет HTTP 404 для recovery, но скрывает path и body', async (t) => {
  const source = await server(t, (req, res) => json(res, req.url === '/api/info' ? info : { private: 'synthetic-private-response' }, req.url === '/api/info' ? 200 : 404));
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/synthetic-private-path'), { message: 'OpenCode: HTTP 404.' });
});

test('не-JSON API отклоняется без утечки тела ответа', async (t) => {
  const source = await server(t, (req, res) => {
    if (req.url === '/api/info') return json(res, info);
    res.end('synthetic-private-response');
  });
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/example'), (error) => !error.message.includes('synthetic'));
});

test('localhost явно нормализуется в IPv4 loopback', async (t) => {
  const source = await server(t, (req, res) => json(res, req.url === '/api/info' ? info : { output: 'done' }));
  await registration(t, { url: source.url.replace('127.0.0.1', 'localhost') });
  assert.deepEqual(await request('/api/example'), { output: 'done' });
  assert.equal(source.received[0].headers.host, new URL(source.url).host);
});

test('IPv6 literal loopback поддерживается', async (t) => {
  const source = await server(t, (req, res) => json(res, req.url === '/api/info' ? info : { output: 'done' }), '::1');
  await registration(t, { url: source.url });
  assert.deepEqual(await request('/api/example'), { output: 'done' });
});

test('смена регистрации во время discovery не меняет endpoint и auth снимка', async (t) => {
  const target = await server(t, (_req, res) => json(res, { output: 'wrong' }));
  const file = await registration(t, { url: target.url });
  const source = await server(t, async (req, res) => {
    if (req.url !== '/api/info') return json(res, { output: 'original' });
    await writeFile(file, JSON.stringify({ ...info, password: 'replaced-password', url: target.url }));
    json(res, info);
  });
  await writeFile(file, JSON.stringify({ ...info, password, url: source.url }));
  assert.deepEqual(await request('/api/example'), { output: 'original' });
  assert.equal(target.received.length, 0);
  assert.equal(source.received[1].headers.authorization, authorization);
});

test('без override читается service.json из XDG_STATE_HOME', async (t) => {
  const source = await server(t, (req, res) => json(res, req.url === '/api/info' ? info : { output: 'done' }));
  const file = await registration(t, { url: source.url });
  const root = dirname(file);
  await mkdir(join(root, 'opencode'));
  await writeFile(join(root, 'opencode', 'service.json'), JSON.stringify({ ...info, password, url: source.url }));
  const previous = process.env.XDG_STATE_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  process.env.XDG_STATE_HOME = root;
  delete process.env.OPENCODE_JOBS_SERVICE_FILE;
  assert.deepEqual(await request('/api/example'), { output: 'done' });
});

test('отмена discovery не вызывает рабочий API и скрывает reason', async (t) => {
  const controller = new AbortController();
  const source = await server(t, () => controller.abort(new Error('synthetic-private-reason')));
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/example', { signal: controller.signal }), (error) => !error.message.includes('synthetic'));
  assert.deepEqual(source.received.map((entry) => entry.url), ['/api/info']);
});

test('отмена API прерывает чтение незавершённого тела', async (t) => {
  const controller = new AbortController();
  const source = await server(t, (req, res) => {
    if (req.url === '/api/info') return json(res, info);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    controller.abort(new Error('synthetic-private-reason'));
  });
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/example', { signal: controller.signal }), (error) => !error.message.includes('synthetic'));
  assert.equal(source.received.length, 2);
});

test('внешний неотменённый signal не отключает 10s timeout API', { timeout: 15000 }, async (t) => {
  const source = await server(t, (req, res) => {
    if (req.url === '/api/info') return json(res, info);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/example', { signal: new AbortController().signal }));
  assert.equal(source.received.length, 2);
});

test('внешний неотменённый signal не отключает timeout discovery', { timeout: 15000 }, async (t) => {
  const source = await server(t, () => {});
  await registration(t, { url: source.url });
  await assert.rejects(request('/api/example', { signal: new AbortController().signal }));
  assert.deepEqual(source.received.map((entry) => entry.url), ['/api/info']);
});
