import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../src/index.js';

const header = '## OpenCode jobs: выбор инструментов';
const tool = { description: 'test tool', input: { type: 'object' } };
let hook;

test.before(async () => {
  const parent = process.platform === 'win32' ? join(tmpdir(), 'opencode') : tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'jobs-guidance-test-'));
  const previous = process.env.OPENCODE_JOBS_STATE;
  process.env.OPENCODE_JOBS_STATE = join(root, 'state');
  try {
    await plugin.setup({
      location: { directory: join(root, 'work') },
      rpc: { register: async () => {} },
      tool: { transform: async (edit) => edit({ add: () => {} }) },
      command: { transform: async (edit) => edit({ add: () => {} }) },
      session: { hook: async (name, callback) => { assert.equal(name, 'context'); hook = callback; } },
    });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_JOBS_STATE;
    else process.env.OPENCODE_JOBS_STATE = previous;
  }
});

function context(tools = {}) {
  return {
    sessionID: 'session-test', agent: 'review', model: { providerID: 'test', id: 'test' },
    system: [{ type: 'text', text: 'Preserve the original role and instructions.', options: { test: 'keep' } }],
    tools, messages: [{ role: 'user', content: 'Run the permitted check.' }], options: { temperature: 0.2 },
  };
}

function apply(event) {
  assert.equal(typeof hook, 'function', 'плагин должен зарегистрировать context hook');
  hook(event);
}

test('полный набор jobs получает один блок с конкретными правилами выбора', () => {
  const event = context({ opencode_jobs_background: tool, opencode_jobs_monitor: tool, opencode_jobs_schedule: tool, opencode_jobs_loop: tool, opencode_jobs_jobs: tool, opencode_jobs_cancel: tool });
  apply(event);
  assert.equal(event.system.length, 2);
  assert.match(event.system[1].text, /Предпочитай.*opencode_jobs_background/);
  assert.match(event.system[1].text, /opencode_jobs_monitor/);
  assert.match(event.system[1].text, /opencode_jobs_schedule/);
  assert.match(event.system[1].text, /opencode_jobs_loop/);
  assert.match(event.system[1].text, /opencode_jobs_jobs/);
  assert.match(event.system[1].text, /opencode_jobs_cancel/);
});

test('без доступных jobs контекст остаётся прежним', () => {
  const event = context({ shell: tool });
  const before = structuredClone(event);
  apply(event);
  assert.deepEqual(event, before);
});

test('отсутствие jobs не удаляет уже существующие инструкции', () => {
  const event = context();
  event.system.push({ type: 'text', text: `${header}\nExisting instruction.` });
  const before = structuredClone(event);
  apply(event);
  assert.deepEqual(event, before);
});

test('похожее имя чужого инструмента не включает jobs guidance', () => {
  const event = context({ foreign_opencode_jobs_background: tool });
  apply(event);
  assert.equal(event.system.length, 1);
});

test('унаследованное свойство не считается инструментом текущего запроса', () => {
  const event = context(Object.create({ opencode_jobs_background: tool }));
  apply(event);
  assert.equal(event.system.length, 1);
});

test('роль без shell получает только доступные правила schedules и диагностики', () => {
  const event = context({ opencode_jobs_schedule: tool, opencode_jobs_loop: tool, opencode_jobs_jobs: tool, opencode_jobs_cancel: tool });
  apply(event);
  assert.match(event.system[1].text, /opencode_jobs_schedule/);
  assert.match(event.system[1].text, /opencode_jobs_loop/);
  assert.match(event.system[1].text, /opencode_jobs_jobs/);
  assert.match(event.system[1].text, /opencode_jobs_cancel/);
  assert.doesNotMatch(event.system[1].text, /opencode_jobs_background|opencode_jobs_monitor/);
});

test('один доступный monitor не рекламирует остальные jobs инструменты', () => {
  const event = context({ opencode_jobs_monitor: tool });
  apply(event);
  assert.match(event.system[1].text, /opencode_jobs_monitor/);
  assert.doesNotMatch(event.system[1].text, /opencode_jobs_background|opencode_jobs_schedule|opencode_jobs_loop|opencode_jobs_jobs|opencode_jobs_cancel/);
});

test('один доступный background получает только своё правило', () => {
  const event = context({ opencode_jobs_background: tool });
  apply(event);
  assert.match(event.system[1].text, /opencode_jobs_background/);
  assert.doesNotMatch(event.system[1].text, /opencode_jobs_monitor|opencode_jobs_schedule|opencode_jobs_loop|opencode_jobs_jobs|opencode_jobs_cancel/);
});

test('один доступный schedule получает только своё правило', () => {
  const event = context({ opencode_jobs_schedule: tool });
  apply(event);
  assert.match(event.system[1].text, /opencode_jobs_schedule/);
  assert.doesNotMatch(event.system[1].text, /opencode_jobs_background|opencode_jobs_monitor|opencode_jobs_loop|opencode_jobs_jobs|opencode_jobs_cancel/);
});

test('один доступный loop получает только своё правило', () => {
  const event = context({ opencode_jobs_loop: tool });
  apply(event);
  assert.match(event.system[1].text, /opencode_jobs_loop/);
  assert.doesNotMatch(event.system[1].text, /opencode_jobs_background|opencode_jobs_monitor|opencode_jobs_schedule|opencode_jobs_jobs|opencode_jobs_cancel/);
});

test('один доступный jobs получает только своё правило', () => {
  const event = context({ opencode_jobs_jobs: tool });
  apply(event);
  assert.match(event.system[1].text, /opencode_jobs_jobs/);
  assert.doesNotMatch(event.system[1].text, /opencode_jobs_background|opencode_jobs_monitor|opencode_jobs_schedule|opencode_jobs_loop|opencode_jobs_cancel/);
});

test('один доступный cancel получает только своё правило', () => {
  const event = context({ opencode_jobs_cancel: tool });
  apply(event);
  assert.match(event.system[1].text, /opencode_jobs_cancel/);
  assert.doesNotMatch(event.system[1].text, /opencode_jobs_background|opencode_jobs_monitor|opencode_jobs_schedule|opencode_jobs_loop|opencode_jobs_jobs/);
});

test('одинаковый блок не добавляется повторно', () => {
  const event = context({ opencode_jobs_background: tool });
  apply(event);
  const before = structuredClone(event);
  apply(event);
  assert.deepEqual(event, before);
});

test('добавление guidance сохраняет исходные system parts и остальные поля запроса', () => {
  const event = context({ opencode_jobs_background: tool, shell: tool });
  const before = structuredClone(event);
  const original = event.system[0];
  apply(event);
  assert.equal(event.system[0], original);
  assert.deepEqual({ ...event, system: event.system.slice(0, 1) }, before);
  assert.equal(event.system[1].type, 'text');
});

test('guidance сохраняет разрешения, no-replay и ограничения на ожидание и секреты', () => {
  const event = context({ opencode_jobs_background: tool, opencode_jobs_loop: tool });
  apply(event);
  assert.match(event.system[1].text, /не расширяют полномочия/);
  assert.match(event.system[1].text, /Не повторяй.*запуск/);
  assert.match(event.system[1].text, /Не жди.*sleep/);
  assert.match(event.system[1].text, /секрет/);
  assert.match(event.system[1].text, /платн/);
});

test('числовое сравнение выполняет скрипт, monitor получает только маркер', () => {
  const event = context({ opencode_jobs_monitor: tool });
  apply(event);
  assert.match(event.system[1].text, /value < 0\.5/);
  assert.match(event.system[1].text, /сравнение выполняет разрешённый скрипт/);
  assert.match(event.system[1].text, /сам числовые выражения не вычисляет/);
});
