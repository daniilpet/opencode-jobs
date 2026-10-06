import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseSync } from '@babel/core';
import { createResource } from 'solid-js';
import { renderToStringAsync } from 'solid-js/web';
import { fromJSON, toJSON } from 'seroval';
import { HeadersPlugin, URLPlugin } from 'seroval-plugins/web';

const require = createRequire(import.meta.url);
const { transformSolidSource } = await import(new URL('./scripts/solid-transform.js', pathToFileURL(require.resolve('@opentui/solid'))));

function payload() {
  return {
    url: new URL('https://example.invalid/resource'),
    headers: new Headers({ 'x-fixture': 'safe' }),
    bytes: new Uint8Array([7, 9]),
  };
}

function assertPayload(value) {
  assert.equal(value.url.href, 'https://example.invalid/resource');
  assert.equal(value.headers.get('x-fixture'), 'safe');
  assert.deepEqual(Array.from(value.bytes), [7, 9]);
}

test('Seroval сохраняет значения и ссылки с текущими web plugins', () => {
  const value = payload();
  value.self = value;
  const options = { plugins: [URLPlugin, HeadersPlugin] };
  const restored = fromJSON(toJSON(value, options), options);
  assertPayload(restored);
  assert.equal(restored.self, restored);
});

test('Solid передаёт resource через серверный serializer и web plugins', async () => {
  const html = await renderToStringAsync(() => {
    const [value] = createResource(() => payload());
    return value().url.href;
  }, { renderId: 'dependency-check', timeoutMs: 1000 });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'Solid должен сформировать hydration script');
  const context = { URL, Headers, Uint8Array, atob, _$HY: { r: {} } };
  context.self = context;
  // Выполняется только script из фиксированного синтетического payload этого теста.
  runInNewContext(scripts[0][1], context, { timeout: 1000 });
  assertPayload(context._$HY.r['dependency-check0']);
});

test('OpenTUI компилирует TSX своим Babel transformer', async () => {
  const code = await transformSolidSource('const Status = (props: { label: string }) => <text>{props.label}</text>;', {
    filename: 'dependency-check.tsx',
  });
  assert.match(code, /from ["']@opentui\/solid["']/);
  assert.match(code, /createElement\(["']text["']\)/);
  assert.match(code, /props\.label/);
  assert.doesNotThrow(() => parseSync(code, { sourceType: 'module', configFile: false, babelrc: false }));
});
