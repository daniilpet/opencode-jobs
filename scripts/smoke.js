import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Service } from '../vendor/client/promise/service.js';
import { createSmokeRoot } from './smoke-root.js';

const root = await createSmokeRoot(process.env.OPENCODE_JOBS_TEST_ROOT);
const artifact = join(root, 'plugin');
await cp(resolve('.runtime/package'), artifact, { recursive: true });
const config = join(root, 'config', 'opencode');
const anchor = join(root, 'jobs', 'anchor');
const workdir = join(root, 'work');
const registration = join(root, 'state', 'opencode', 'service.json');
for (const directory of [config, anchor, workdir]) await mkdir(directory, { recursive: true, mode: 0o700 });
let calls = 0;
const guidanceRequests = [];
const guidanceHeader = '## OpenCode jobs: выбор инструментов';
const agentPrompts = { build: 'Local integration test. Follow the test tool request. Do not use other tools.', noShell: 'Local permissions test.', noTools: 'Local no-tools test.', denyCommand: 'Local command-specific denial test.', askShell: 'Local shell approval test.' };
const statusOutputs = [];
const toolExchanges = [];
const hangingWorkers = [];
const mock = createServer(async (request, response) => {
  let raw = '';
  for await (const part of request) raw += part;
  const body = JSON.parse(raw || '{}');
  const system = (body.messages ?? []).filter((item) => ['system', 'developer'].includes(item.role)).map((item) => typeof item.content === 'string' ? item.content : (item.content ?? []).map((part) => part.text ?? '').join('\n')).join('\n');
  const users = (body.messages ?? []).filter((item) => item.role === 'user').map((item) => typeof item.content === 'string' ? item.content : (item.content ?? []).map((part) => part.text ?? '').join('\n')).join('\n');
  const agent = /JOBS_SMOKE_AGENT:(build|noShell|noTools|denyCommand|askShell)/.exec(users)?.[1];
  if (agent) guidanceRequests.push({ agent, tools: (body.tools ?? []).map((item) => item.function.name), system, originalPromptPreserved: system.includes(agentPrompts[agent]) });
  const last = body.messages?.at(-1);
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
  if (last?.role === 'user' && text.includes('JOBS_SMOKE_WORKER_HANG')) {
    calls++;
    const capture = { closed: false };
    hangingWorkers.push(capture);
    response.on('close', () => { capture.closed = true; });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': waiting for the job deadline\n\n');
    return;
  }
  const marker = /JOBS_SMOKE_TOOL:(background|monitor|jobs|cancel)/.exec(text);
  const tool = marker && last.role === 'user' ? body.tools?.find((item) => item.function?.name.endsWith(`opencode_jobs_${marker[1]}`)) : undefined;
  const nativeCommand = text.includes('TIMEOUT_CHILD') ? 'node timeout-child.cjs' : text.includes('PARTIAL_OUTPUT') ? 'node partial-child.cjs' : text.includes('DENIED_COMMAND') ? 'echo JOBS_DENIED_COMMAND' : text.includes('CANCEL_LONG') ? (process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60') : (process.platform === 'win32' ? 'Start-Sleep -Seconds 2; Write-Output OPENCODE_JOBS_SMOKE' : 'sleep 2; echo OPENCODE_JOBS_SMOKE');
  const argumentsRaw = marker?.[1] === 'jobs' ? '' : marker?.[1] === 'cancel' ? /CANCEL_ID:(job_[a-f0-9-]+)/.exec(text)?.[1] : marker?.[1] === 'monitor' ? `--regex OPENCODE_JOBS_SMOKE --before 0 --after 0 --debounce 1 -- ${nativeCommand}` : nativeCommand;
  for (const item of body.messages ?? []) {
    if (item.role !== 'tool' || typeof item.content !== 'string' || !/"jobs":|"job":/.test(item.content)) continue;
    if (!statusOutputs.includes(item.content)) statusOutputs.push(item.content);
  }
  const id = `chatcmpl-${++calls}`;
  const message = tool ? { role: 'assistant', tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ raw: argumentsRaw, ...(text.includes('TIMEOUT_CHILD') ? { timeout: '5s' } : text.includes('WAIT_TIMEOUT') ? { timeout: '2s' } : {}) }) } }] } : { role: 'assistant', content: 'SMOKE_READY' };
  const finish = tool ? 'tool_calls' : 'stop';
  toolExchanges.push({ last, response: message });
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = tool ? { ...message, tool_calls: message.tool_calls.map((value, index) => ({ index, ...value })) } : message;
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`);
    response.end();
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: 'smoke', choices: [{ index: 0, message, finish_reason: finish }], usage }));
  }
});
await new Promise((done) => mock.listen(0, '127.0.0.1', done));
await writeFile(join(config, 'opencode.json'), JSON.stringify({
  model: 'smoke/smoke', plugins: [artifact], update: 'disable',
  providers: { smoke: { package: '@opencode/ai/providers/openai-compatible', env: ['OPENCODE_JOBS_SMOKE_KEY'], settings: { baseURL: `http://127.0.0.1:${mock.address().port}/v1` }, models: { smoke: { name: 'Local smoke', capabilities: { tools: true }, limit: { context: 32768, output: 1024 } } } } },
  agents: { build: { system: agentPrompts.build, permissions: [{ action: '*', resource: '*', effect: 'allow' }] }, noShell: { system: agentPrompts.noShell, permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] }, noTools: { system: agentPrompts.noTools, permissions: [{ action: '*', resource: '*', effect: 'deny' }] }, denyCommand: { system: agentPrompts.denyCommand, permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*JOBS_DENIED_COMMAND*', effect: 'deny' }] }, askShell: { system: agentPrompts.askShell, permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'shell', resource: '*', effect: 'ask' }] } },
}));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)));
Object.assign(env, {
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
  OPENCODE_DB: join(root, 'data', 'smoke.sqlite'), OPENCODE_JOBS_STATE: join(root, 'jobs'), OPENCODE_JOBS_SERVICE_FILE: registration, OPENCODE_JOBS_SMOKE_KEY: 'local-test-placeholder',
});
const binary = process.env.OPENCODE_JOBS_CLI ?? (process.platform === 'win32' ? join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe') : join(homedir(), '.local', 'bin', 'opencode'));
let server;
let pump;
let endpoint;
let logs = '';
const start = () => {
  server = spawn(binary, ['serve', '--service', '--hostname', '127.0.0.1', '--port', '0', '--log-level', 'debug', '--print-logs'], { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', (part) => { logs += part; });
  server.stderr.on('data', (part) => { logs += part; });
};
const until = async (predicate, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`Smoke timeout: ${label}`);
};
const api = async (path, method = 'GET', body, directory) => {
  const url = new URL(path, endpoint.url);
  if (directory) url.searchParams.set('location[directory]', directory);
  const result = await fetch(url, { method, headers: { ...Service.headers(endpoint), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!result.ok) throw new Error(`${method} ${path}: ${result.status} ${await result.text()}`);
  return result.status === 204 ? undefined : result.json();
};
const rpc = async (method, input) => (await api(`/api/rpc/opencode-jobs/${method}`, 'POST', { input }, anchor)).output;
const data = (value) => value?.data ?? value;
try {
  await writeFile(join(workdir, 'timeout-child.cjs'), "process.stdout.write('JOBS_CHILD_PID=' + process.pid + '\\n'); setInterval(() => {}, 1000);\n");
  await writeFile(join(workdir, 'partial-child.cjs'), "process.stdout.write('token=FIXTURE_PARTIAL_SECRET'); setInterval(() => {}, 1000);\n");
  start();
  endpoint = await until(() => Service.discover({ file: registration }), 'isolated server startup');
  await writeFile(join(root, 'config-discovery.json'), JSON.stringify(await api('/api/config', 'GET', undefined, workdir), null, 2));
  const plugin = await until(async () => {
    const plugins = data(await api('/api/plugin', 'GET', undefined, workdir));
    await writeFile(join(root, 'plugins.json'), JSON.stringify(plugins, null, 2));
    return plugins.find((item) => item.id === 'opencode.jobs' || item.state?.status === 'failed');
  }, 'server plugin discovery');
  assert.ok(plugin, 'server plugin discovered');
  assert.equal(plugin.state.status ?? plugin.state.type, 'active', JSON.stringify(plugin.state));
  const commands = data(await api('/api/command', 'GET', undefined, workdir));
  for (const name of ['background', 'monitor', 'loop', 'schedule', 'jobs', 'cancel']) assert.ok(commands.some((item) => item.name === name), name);
  const session = data(await api('/api/session', 'POST', { title: 'OpenCode jobs isolated smoke', location: { directory: workdir }, agent: 'build', model: { providerID: 'smoke', id: 'smoke' } }));
  const sessionID = session.id;
  pump = spawn(process.execPath, [join(artifact, 'src', 'pump.js')], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  await until(async () => (await rpc('list', { sessionID })).healthy, 'pump healthy');
  for (const name of ['background', 'monitor']) {
    await api(`/api/session/${sessionID}/prompt`, 'POST', { text: `JOBS_SMOKE_TOOL:${name}\nJOBS_SMOKE_AGENT:build` });
    const job = await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.kind === name && item.shellID), `${name} actual native tool execution`);
    await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === job.id && item.status === 'completed'), `${name} completion`);
    if (name === 'monitor') await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === job.id && item.delivery === 'sent'), 'monitor match notification');
    process.stdout.write(`PASS native ${name}\n`);
  }
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background CANCEL_LONG\nJOBS_SMOKE_AGENT:build' });
  const cancelShell = await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.kind === 'background' && item.status === 'active' && item.shellID), 'native cancellable shell');
  await rpc('cancel', { sessionID, id: cancelShell.id });
  assert.equal((await rpc('list', { sessionID })).jobs.find((item) => item.id === cancelShell.id).status, 'cancelled');
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.id === cancelShell.shellID && item.status === 'running'));
  process.stdout.write('PASS native shell cancellation\n');
  const delayedAttach = await rpc('create', { sessionID, name: 'background', raw: process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60' });
  await rpc('cancel', { sessionID, id: delayedAttach.job.id });
  const lateShell = data(await api('/api/shell', 'POST', { command: delayedAttach.job.command, cwd: workdir, metadata: { sessionID } }, workdir));
  await rpc('attach', { sessionID, id: delayedAttach.job.id, shellID: lateShell.id });
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.id === lateShell.id && item.status === 'running'));
  process.stdout.write('PASS cancel before attach race\n');
  const forbiddenSession = data(await api('/api/session', 'POST', { title: 'OpenCode jobs permissions smoke', location: { directory: workdir }, agent: 'noShell', model: { providerID: 'smoke', id: 'smoke' } }));
  await api(`/api/session/${forbiddenSession.id}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background\nJOBS_SMOKE_AGENT:noShell' });
  await until(async () => data(await api(`/api/session/${forbiddenSession.id}/context`)).some((item) => JSON.stringify(item).includes('SMOKE_READY')), 'deny shell session response');
  assert.equal((await rpc('list', { sessionID: forbiddenSession.id })).jobs.length, 0);
  process.stdout.write('PASS shell permission denial\n');
  const denyCommand = data(await api('/api/session', 'POST', { title: 'OpenCode jobs command-specific denial', location: { directory: workdir }, agent: 'denyCommand', model: { providerID: 'smoke', id: 'smoke' } }));
  await api(`/api/session/${denyCommand.id}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background DENIED_COMMAND\nJOBS_SMOKE_AGENT:denyCommand' });
  await until(async () => (await rpc('list', { sessionID: denyCommand.id })).jobs.some((item) => item.status === 'failed'), 'specific command denied through wrapper');
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.metadata.sessionID === denyCommand.id));
  const askShell = data(await api('/api/session', 'POST', { title: 'OpenCode jobs approval denial', location: { directory: workdir }, agent: 'askShell', model: { providerID: 'smoke', id: 'smoke' } }));
  await api(`/api/session/${askShell.id}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background CANCEL_LONG\nJOBS_SMOKE_AGENT:askShell' });
  const permission = await until(async () => data(await api(`/api/session/${askShell.id}/permission`))[0], 'native permission pending');
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.metadata.sessionID === askShell.id));
  await api(`/api/session/${askShell.id}/permission/${permission.id}/reply`, 'POST', { decision: 'reject' });
  await until(async () => (await rpc('list', { sessionID: askShell.id })).jobs.some((item) => item.status === 'failed'), 'native permission rejection');
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.metadata.sessionID === askShell.id));
  process.stdout.write('PASS specific command deny and ask/reject preserve native permission checks\n');
  const waitTimeout = data(await api('/api/session', 'POST', { title: 'OpenCode jobs approval deadline', location: { directory: workdir }, agent: 'askShell', model: { providerID: 'smoke', id: 'smoke' } }));
  await api(`/api/session/${waitTimeout.id}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background CANCEL_LONG WAIT_TIMEOUT\nJOBS_SMOKE_AGENT:askShell' });
  const waiting = await until(async () => data(await api(`/api/session/${waitTimeout.id}/permission`))[0], 'permission with finite waiting deadline');
  await until(async () => data(await api(`/api/session/${waitTimeout.id}/permission`)).length === 0, 'expired approval removed');
  await assert.rejects(api(`/api/session/${waitTimeout.id}/permission/${waiting.id}/reply`, 'POST', { decision: 'once' }), /404/);
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.metadata.sessionID === waitTimeout.id));
  process.stdout.write('PASS approval wait expires and late approval cannot start command\n');
  const cancelApproval = data(await api('/api/session', 'POST', { title: 'OpenCode jobs cancel pending approval', location: { directory: workdir }, agent: 'askShell', model: { providerID: 'smoke', id: 'smoke' } }));
  await api(`/api/session/${cancelApproval.id}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background CANCEL_LONG\nJOBS_SMOKE_AGENT:askShell' });
  const cancelWaiting = await until(async () => data(await api(`/api/session/${cancelApproval.id}/permission`))[0], 'approval before job cancellation');
  const waitingJob = (await rpc('list', { sessionID: cancelApproval.id })).jobs[0];
  await rpc('cancel', { sessionID: cancelApproval.id, id: waitingJob.id });
  await until(async () => data(await api(`/api/session/${cancelApproval.id}/permission`)).length === 0, 'job cancellation removes pending approval');
  await assert.rejects(api(`/api/session/${cancelApproval.id}/permission/${cancelWaiting.id}/reply`, 'POST', { decision: 'once' }), /404/);
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.metadata.sessionID === cancelApproval.id));
  await until(async () => (await rpc('list', { sessionID: cancelApproval.id })).jobs.some((item) => item.id === waitingJob.id && !item.stopPending), 'pending launch cleanup acknowledged');
  process.stdout.write('PASS cancelling pending approval prevents a late launch\n');
  const noToolsSession = data(await api('/api/session', 'POST', { title: 'OpenCode jobs no-tools guidance smoke', location: { directory: workdir }, agent: 'noTools', model: { providerID: 'smoke', id: 'smoke' } }));
  await api(`/api/session/${noToolsSession.id}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background\nJOBS_SMOKE_AGENT:noTools' });
  await until(async () => data(await api(`/api/session/${noToolsSession.id}/context`)).some((item) => JSON.stringify(item).includes('SMOKE_READY')), 'no-tools session response');
  assert.equal((await rpc('list', { sessionID: noToolsSession.id })).jobs.length, 0);
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:monitor PARTIAL_OUTPUT\nJOBS_SMOKE_AGENT:build' });
  const partial = await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.monitorState?.partial?.includes('FIXTURE_PARTIAL_SECRET')), 'raw monitor partial exists only internally');
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:jobs\nJOBS_SMOKE_AGENT:build' });
  await until(() => statusOutputs.some((item) => item.includes('"jobs":')), 'model received safe jobs status');
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: `JOBS_SMOKE_TOOL:cancel CANCEL_ID:${partial.id}\nJOBS_SMOKE_AGENT:build` });
  await until(() => statusOutputs.some((item) => item.includes('"job":')), 'model received safe cancel status');
  assert.ok(statusOutputs.length >= 2);
  for (const output of statusOutputs) assert.doesNotMatch(output, /FIXTURE_PARTIAL_SECRET|monitorState|lastMessage|"messages"/);
  process.stdout.write('PASS model-facing jobs and cancel exclude raw monitor state\n');
  const stoppedPump = pump;
  stoppedPump.kill();
  await new Promise((done) => stoppedPump.once('exit', done));
  pump = undefined;
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background TIMEOUT_CHILD\nJOBS_SMOKE_AGENT:build' });
  const bounded = await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.timeout === 5000 && item.shellID), 'finite native shell without pump');
  await until(async () => data(await api(`/api/shell/${bounded.shellID}`, 'GET', undefined, workdir)).status === 'timeout', 'native timeout without pump');
  const childOutput = data(await api(`/api/shell/${bounded.shellID}/output?cursor=0&limit=16384`, 'GET', undefined, workdir)).output;
  const childPID = Number(/JOBS_CHILD_PID=(\d+)/.exec(childOutput)?.[1]);
  assert.ok(childPID > 0, 'actual child process started');
  await until(() => { try { process.kill(childPID, 0); return false; } catch (error) { if (error.code !== 'ESRCH') throw error; return true; } }, 'native timeout terminates actual child PID');
  pump = spawn(process.execPath, [join(artifact, 'src', 'pump.js')], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === bounded.id && item.status === 'expired'), 'durable expiry after pump resumes');
  process.stdout.write('PASS finite shell timeout kills the process without jobs pump\n');
  const scheduled = await rpc('create', { sessionID, name: 'schedule', raw: 'in 2s SMOKE_SCHEDULE' });
  await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === scheduled.job.id && item.delivery === 'sent'), 'schedule');
  const completedSchedule = await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === scheduled.job.id && item.executionStatus === 'succeeded'), 'separate schedule execution completed');
  assert.notEqual(completedSchedule.workerID, sessionID);
  assert.ok(completedSchedule.workerID.startsWith('ses'));
  await assert.rejects(rpc('create', { sessionID: completedSchedule.workerID, name: 'loop', raw: '10s NEVER_NESTED' }), /RpcInternalError/);
  assert.equal((await rpc('list', { sessionID: completedSchedule.workerID })).jobs.length, 0);
  await until(async () => data(await api(`/api/session/${sessionID}/context`)).some((item) => JSON.stringify(item).includes(completedSchedule.workerID) && JSON.stringify(item).includes('SMOKE_READY')), 'worker result returned to parent');
  const noPump = pump;
  noPump.kill();
  await new Promise((done) => noPump.once('exit', done));
  pump = undefined;
  const boundedWorker = await rpc('create', { sessionID, name: 'schedule', raw: 'in 1s JOBS_SMOKE_WORKER_HANG', timeout: '4s' });
  await until(() => Date.now() >= boundedWorker.job.due, 'worker scheduled deadline');
  await rpc('tick', {});
  await until(() => hangingWorkers.length === 1, 'worker model request started without pump');
  const runningWorker = (await rpc('list', { sessionID })).jobs.find((item) => item.id === boundedWorker.job.id);
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: 'PARENT_STILL_INDEPENDENT\nJOBS_SMOKE_AGENT:build' });
  await until(() => hangingWorkers[0].closed, 'worker timer aborted provider stream without pump');
  await until(async () => data(await api(`/api/session/${runningWorker.workerID}`)).outcome === 'interrupted', 'worker interrupt acknowledged');
  assert.notEqual(data(await api(`/api/session/${sessionID}`)).outcome, 'interrupted');
  await api(`/api/session/${runningWorker.workerID}/prompt`, 'POST', { text: 'JOBS_SMOKE_WORKER_HANG' });
  await api(`/api/experimental/session/${runningWorker.workerID}/wait`, 'POST', {});
  assert.equal(hangingWorkers.length, 1, 'terminal worker cannot send another provider request');
  pump = spawn(process.execPath, [join(artifact, 'src', 'pump.js')], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === boundedWorker.job.id && item.status === 'expired' && !item.stopPending), 'scheduler reconciles expired worker');
  process.stdout.write('PASS separate worker context, result delivery, nested job denial and independent model deadline\n');
  if (process.platform === 'linux') {
    await until(async () => Object.keys(data(await api('/api/session/active'))).length === 0, 'idle before TUI');
    const beforeCalls = calls;
    const uiSession = data(await api('/api/session', 'POST', { title: 'Jobs TUI smoke', location: { directory: workdir }, agent: 'build', model: { providerID: 'smoke', id: 'smoke' } }));
    const untouched = await rpc('create', { sessionID: uiSession.id, name: 'schedule', raw: 'in 5m NEVER_RUN_TUI' });
    await writeFile(join(workdir, 'tui-child.cjs'), "process.stdout.write('NATIVE_TUI_OUTPUT\\n'); setInterval(() => {}, 1000);\n");
    const uiJob = await rpc('create', { sessionID: uiSession.id, name: 'monitor', raw: '--regex NEVER_MATCH_TUI -- node tui-child.cjs', timeout: '2m' });
    assert.ok(uiJob.job.created > untouched.job.created, 'selected first row is the newer monitor');
    const uiShell = data(await api('/api/shell', 'POST', { command: 'node tui-child.cjs', timeout: 120000, metadata: { sessionID: uiSession.id } }, workdir));
    await rpc('attach', { sessionID: uiSession.id, id: uiJob.job.id, shellID: uiShell.id });
    const terminal = spawn('python3', [resolve('scripts/tui-smoke.py'), binary, uiSession.id, join(root, 'tui-screen.txt')], { cwd: workdir, env, stdio: 'inherit' });
    const status = await new Promise((done) => terminal.once('exit', done));
    assert.equal(status, 0, 'real TUI task management');
    const uiState = await rpc('list', { sessionID: uiSession.id });
    assert.equal(uiState.jobs.find((item) => item.id === uiJob.job.id).status, 'cancelled');
    assert.equal(uiState.jobs.find((item) => item.id === untouched.job.id).status, 'active');
    assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.id === uiShell.id && item.status === 'running'));
    assert.equal(calls, beforeCalls, 'UI inspection and cancellation must not call a model');
    await rpc('cancel', { sessionID: uiSession.id, id: untouched.job.id });
  }
  const loop = await rpc('create', { sessionID, name: 'loop', raw: '10s SMOKE_LOOP', maxRuns: 1 });
  await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === loop.job.id && item.delivery === 'sent'), 'loop');
  const limitedLoop = (await rpc('list', { sessionID })).jobs.find((item) => item.id === loop.job.id);
  assert.equal(limitedLoop.runs, 1);
  assert.equal(limitedLoop.status, 'completed');
  await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === loop.job.id && !item.runMessage && item.executionStatus === 'succeeded'), 'loop execution complete');
  await rpc('cancel', { sessionID, id: loop.job.id });
  assert.equal((await rpc('list', { sessionID })).jobs.find((item) => item.id === loop.job.id).status, 'completed', 'late cancellation preserves observed completion');
  const persisted = await rpc('create', { sessionID, name: 'schedule', raw: 'in 20s SMOKE_PERSISTED' });
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: 'JOBS_SMOKE_TOOL:background CANCEL_LONG\nJOBS_SMOKE_AGENT:build' });
  const interrupted = await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.kind === 'background' && item.status === 'active' && item.shellID), 'native shell before restart');
  await Service.stop({ file: registration });
  await sleep(500);
  start();
  endpoint = await until(() => Service.discover({ file: registration }), 'isolated restart');
  assert.equal((await rpc('list', { sessionID })).jobs.find((item) => item.id === persisted.job.id).status, 'active');
  await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === interrupted.id && item.status === 'interrupted' && item.delivery === 'sent'), 'interrupted shell explicit failure');
  assert.ok(!data(await api('/api/shell', 'GET', undefined, workdir)).some((item) => item.status === 'running'));
  await rpc('cancel', { sessionID, id: persisted.job.id });
  const missed = await rpc('create', { sessionID, name: 'schedule', raw: 'in 2s NEVER_RUN_MISSED' });
  await Service.stop({ file: registration });
  await sleep(3000);
  start();
  endpoint = await until(() => Service.discover({ file: registration }), 'missed restart');
  await until(async () => (await rpc('list', { sessionID })).jobs.find((item) => item.id === missed.job.id && item.status === 'missed' && item.delivery === 'sent'), 'missed failure notification');
  assert.equal(guidanceRequests.length, calls, 'every fixture model request captured independently of its system prompt');
  assert.ok(guidanceRequests.some((item) => item.agent === 'build'), 'build requests captured');
  assert.ok(guidanceRequests.some((item) => item.agent === 'noShell'), 'noShell requests captured');
  assert.ok(guidanceRequests.some((item) => item.agent === 'noTools'), 'no-tools requests captured');
  for (const item of guidanceRequests) {
    assert.ok(item.originalPromptPreserved, `${item.agent}: original role prompt preserved in every request`);
    const available = item.tools.filter((name) => name.startsWith('opencode_jobs_'));
    assert.equal(item.system.split(guidanceHeader).length - 1, available.length ? 1 : 0, `${item.agent}: one guidance block only when jobs are available`);
    const guidance = item.system.split(guidanceHeader)[1] ?? '';
    for (const name of ['background', 'monitor', 'schedule', 'loop', 'jobs', 'cancel']) {
      const id = `opencode_jobs_${name}`;
      assert.equal(guidance.includes(id), available.includes(id), `${item.agent}: ${id} guidance matches model tool snapshot`);
    }
    if (item.agent === 'noShell') assert.ok(!available.includes('opencode_jobs_background') && !available.includes('opencode_jobs_monitor'));
    if (item.agent === 'noTools') assert.equal(available.length, 0);
  }
  await writeFile(join(root, 'guidance-report.json'), JSON.stringify({ ok: true, requests: guidanceRequests.map(({ agent, tools, originalPromptPreserved }) => ({ agent, tools: tools.filter((name) => name.startsWith('opencode_jobs_')), originalPromptPreserved, guidanceMatchesTools: true })), limitation: 'Mock provider verifies prompt delivery, not real-model tool selection.' }, null, 2));
  process.stdout.write('PASS native guidance delivery, original role prompts and permission-filtered tools\n');
  await writeFile(join(root, 'report.json'), JSON.stringify({ ok: true, platform: process.platform, sessionID, mockCalls: calls, checks: ['plugin', 'commands', 'native background', 'native monitor notification', 'native shell cancel', 'cancel-before-attach race', 'shell permission deny', 'specific-command denial', 'ask/reject without spawn', 'approval deadline and late approval rejection', 'cancel pending approval without spawn', 'safe jobs/cancel output', 'native timeout without pump and actual child termination', 'dedicated worker and parent result delivery', 'nested job denial', 'worker deadline without pump', 'parent independence', 'terminal worker dispatch denial', 'guidance delivery and original prompts', 'permission-filtered guidance', 'no-tools guidance omitted', 'schedule', 'finite loop count', 'cancel', 'restart persistence', 'interrupted shell failure without replay', 'missed deadline'] }, null, 2));
  process.stdout.write(`PASS isolated integration. Artifacts: ${root}\n`);
} catch (error) {
  await writeFile(join(root, 'server.log'), logs);
  await writeFile(join(root, 'tool-exchanges.json'), JSON.stringify(toolExchanges, null, 2));
  process.stderr.write(`${error.stack}\nLogs: ${root}\n`);
  process.exitCode = 1;
} finally {
  pump?.kill();
  await Service.stop({ file: registration }).catch(() => {});
  server?.kill();
  mock.close();
}
