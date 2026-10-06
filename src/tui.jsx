/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui';
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { useTerminalDimensions } from '@opentui/solid';
import { Jobs } from './contract.js';
import { hasJobActivity } from './job-activity.js';
import { sanitize } from './sanitize.js';

const kinds = { background: 'Команда', monitor: 'Монитор', schedule: 'По расписанию', loop: 'Повторяющееся' };
const title = (job) => sanitize(job.command ?? job.prompt ?? job.id).replace(/\s+/g, ' ').slice(0, 100);
const location = (context) => context.location ?? context.data.location.default();

function status(job) {
  if (job.stopPending) return 'Останавливается';
  if (job.workerResult?.status === 'succeeded') return 'Завершается';
  if (job.preparing) return 'Подготовка';
  if (job.runMessage) return job.executionStatus === 'pending' ? 'В очереди' : 'Выполняется';
  if (job.status === 'active') {
    if (job.kind === 'schedule') return 'Ожидает запуска';
    if (job.kind === 'loop') return 'Ожидает повтора';
    return job.shellID ? 'Выполняется' : 'Ожидает разрешения';
  }
  return { completed: 'Завершено', cancelled: 'Отменено', expired: 'Истёк срок', missed: 'Пропущен срок', interrupted: 'Прервано', failed: 'Ошибка' }[job.status] ?? 'Неизвестное состояние';
}

// Нет ответа -> загрузка; ошибка + старые данные -> устаревшие, без успешных действий.
// Ответ + healthy=false -> предупреждение, прямой cancel остаётся доступным.
// Новая сессия/закрытие -> старый запрос отменяется и не обновляет представление.
function useJobs(context, sessionID) {
  const [state, setState] = createSignal({ jobs: [], loaded: false, healthy: false, error: false });
  let reload = async () => {};
  createEffect(() => {
    const id = sessionID();
    const controller = new AbortController();
    let pending;
    setState({ jobs: [], loaded: false, healthy: false, error: false });
    const refresh = () => {
      if (!id || controller.signal.aborted) return Promise.resolve();
      if (pending) return pending;
      pending = context.client.rpc(Jobs).list({ sessionID: id }, {
        location: location(context), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      }).then((result) => {
        if (!controller.signal.aborted) setState({ ...result, loaded: true, error: false });
      }).catch(() => {
        if (!controller.signal.aborted) setState((value) => ({ ...value, error: true }));
      }).finally(() => { pending = undefined; });
      return pending;
    };
    reload = async () => { await pending; await refresh(); };
    void refresh();
    const timer = setInterval(refresh, 1000);
    onCleanup(() => { controller.abort(); clearInterval(timer); });
  });
  return { state, reload: () => reload() };
}

function openJobs(context, sessionID) {
  if (!sessionID) return;
  context.ui.dialog.show(() => <Manager context={context} sessionID={sessionID} />);
  context.ui.dialog.set({ size: 'xlarge', centered: true });
}

function Status(props) {
  const context = props.context;
  const { state } = useJobs(context, () => props.sessionID);
  const active = () => state().jobs.filter(hasJobActivity);
  return (
    <Show when={props.sessionID && (active().length || !state().loaded || !state().healthy || state().error)}>
      <box flexDirection="column">
        <text onMouseUp={() => openJobs(context, props.sessionID)} fg={state().error || (state().loaded && !state().healthy) ? context.theme.error : context.theme.text.base}>
          {state().error ? 'Задания: связь потеряна' : !state().loaded ? 'Задания: загрузка' : `Задания: ${active().length} · мониторы: ${active().filter((job) => job.kind === 'monitor').length}${state().healthy ? '' : ' · планировщик недоступен'}`} · /joblist
        </text>
        <Show when={!props.compact}>
          <For each={active()}>{(job) => (
            <box flexDirection="column">
              <text fg={context.theme.text.muted}>{kinds[job.kind]} {job.id.slice(0, 12)} {status(job)}</text>
              <For each={job.preview ?? []}>{(line) => <text wrapMode="none" fg={context.theme.text.muted}>{sanitize(line)}</text>}</For>
            </box>
          )}</For>
        </Show>
      </box>
    </Show>
  );
}

function Output(props) {
  const context = props.context;
  const dimensions = useTerminalDimensions();
  const [output, setOutput] = createSignal();
  const [error, setError] = createSignal(false);
  const [omitted, setOmitted] = createSignal(false);
  const shellID = createMemo(() => props.job.shellID);
  const shellDirectory = createMemo(() => props.job.directory);
  let scroll;
  createEffect(() => {
    const id = shellID();
    const directory = shellDirectory();
    if (!id) return;
    const controller = new AbortController();
    let cursor;
    let timer;
    setOutput(undefined);
    setError(false);
    setOmitted(false);
    const poll = async () => {
      const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) };
      const input = { id, location: directory ? { directory } : location(context) };
      try {
        if (cursor === undefined) {
          const head = await context.client.shell.output({ ...input, cursor: Number.MAX_SAFE_INTEGER }, options);
          if (controller.signal.aborted) return;
          cursor = Math.max(0, head.data.size - 32768);
          setOmitted(cursor > 0);
        }
        const page = await context.client.shell.output({ ...input, cursor, limit: 32768 }, options);
        if (controller.signal.aborted) return;
        cursor = page.data.cursor;
        setOutput((previous) => {
          const next = (previous ?? '') + page.data.output;
          if (next.length > 32768 || page.data.truncated) setOmitted(true);
          return next.slice(-32768);
        });
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    onCleanup(() => { controller.abort(); clearTimeout(timer); });
  });
  context.keymap.layer(() => ({ mode: 'modal', commands: [
    { bind: 'up', run: () => scroll?.scrollBy(-1) },
    { bind: 'down', run: () => scroll?.scrollBy(1) },
    { bind: 'pageup', run: () => scroll?.scrollBy(-10) },
    { bind: 'pagedown', run: () => scroll?.scrollBy(10) },
    { bind: 'end', run: () => scroll?.scrollTo(Infinity) },
  ] }));
  return <box flexDirection="column">
    <Show when={omitted()}><text fg={context.theme.text.muted}>Показан конец вывода; начало опущено.</text></Show>
    <scrollbox ref={(value) => { scroll = value; }} height={Math.max(3, Math.min(16, dimensions().height - 16))} stickyScroll stickyStart="bottom">
      <text fg={context.theme.text.base} wrapMode="word">{output() === undefined ? (props.job.shellID && !error() ? 'Загрузка вывода…' : sanitize((props.job.preview ?? []).join('\n')) || 'Сохранённого вывода нет.') : sanitize(output()).replace(/\r\n?/g, '\n') || 'Вывода пока нет.'}</text>
    </scrollbox>
    <Show when={error()}><text fg={context.theme.error}>Не удалось прочитать вывод. Показаны последние полученные данные.</text></Show>
    <text fg={context.theme.text.muted}>↑/↓ прокрутка · end следить за выводом</text>
  </box>;
}

function Manager(props) {
  const context = props.context;
  const dimensions = useTerminalDimensions();
  const { state, reload } = useJobs(context, () => props.sessionID);
  const [history, setHistory] = createSignal(false);
  const [selectedID, setSelectedID] = createSignal('');
  const [details, setDetails] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  const visible = createMemo(() => state().jobs.filter((job) => history() ? !hasJobActivity(job) : hasJobActivity(job)).sort((a, b) => b.created - a.created));
  const selected = () => state().jobs.find((job) => job.id === selectedID());
  let list;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  createEffect(() => {
    const route = context.ui.router.current();
    if (route.type !== 'session' || route.sessionID !== props.sessionID) context.ui.dialog.clear();
  });
  createEffect(() => {
    if (!details() && !visible().some((job) => job.id === selectedID())) setSelectedID(visible()[0]?.id ?? '');
  });
  createEffect(() => { list?.scrollChildIntoView(selectedID()); });
  const move = (step) => {
    const jobs = visible();
    const index = jobs.findIndex((job) => job.id === selectedID());
    setSelectedID(jobs[Math.max(0, Math.min(jobs.length - 1, index + step))]?.id ?? '');
  };
  const canStop = () => selected() && hasJobActivity(selected()) && !selected().stopPending && selected().workerResult?.status !== 'succeeded' && !state().error && !stopping();
  const stop = async () => {
    if (!canStop()) return;
    const id = selectedID();
    setStopping(true);
    setActionError('');
    try {
      await context.client.rpc(Jobs).cancel({ sessionID: props.sessionID, id }, {
        location: location(context), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!controller.signal.aborted) await reload();
    } catch {
      if (!controller.signal.aborted) setActionError('Остановка не подтверждена. Обновите список, чтобы проверить состояние.');
    } finally { if (!controller.signal.aborted) setStopping(false); }
  };
  const worker = () => {
    const id = selected()?.workerID;
    if (!id) return;
    context.ui.dialog.clear();
    context.ui.router.navigate({ type: 'session', sessionID: id });
  };
  context.keymap.layer(() => ({ mode: 'modal', commands: [
    { id: 'opencode.jobs.stop', bind: 'ctrl+x', enabled: canStop, run: stop },
    { id: 'opencode.jobs.history', bind: 'h', enabled: () => !details(), run: () => setHistory(!history()) },
    { id: 'opencode.jobs.back', bind: 'backspace', enabled: details, run: () => setDetails(false) },
    { id: 'opencode.jobs.worker', bind: 'o', enabled: () => Boolean(selected()?.workerID), run: worker },
    { id: 'opencode.jobs.refresh', bind: 'r', run: reload },
    { bind: 'up', enabled: () => !details(), run: () => move(-1) },
    { bind: 'down', enabled: () => !details(), run: () => move(1) },
    { id: 'opencode.jobs.details', bind: 'return', enabled: () => !details() && Boolean(selected()), run: () => setDetails(true) },
  ] }));
  return <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={context.theme.text.base}>Задания и мониторы</text>
      <text fg={context.theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>Закрыть [esc]</text>
    </box>
    <Show when={state().error} fallback={<Show when={state().loaded && !state().healthy}><text fg={context.theme.error}>Планировщик недоступен. Остановка через сервер доступна.</text></Show>}>
      <text fg={context.theme.error}>Связь с сервером потеряна. Сведения могут быть устаревшими.</text>
    </Show>
    <Show when={state().loaded} fallback={<text fg={context.theme.text.muted}>{state().error ? 'Не удалось загрузить задания.' : 'Загрузка заданий…'}</text>}>
      <Show when={details() && selected()} fallback={<>
        <text fg={context.theme.text.base} onMouseUp={() => setHistory(!history())}>{history() ? 'История' : 'Активные'} · {visible().length} · переключить [h]</text>
        <scrollbox ref={(value) => { list = value; }} height={Math.max(3, Math.min(16, dimensions().height - 12))}>
          <Show when={visible().length} fallback={<text fg={context.theme.text.muted}>{history() ? 'История пуста.' : 'Активных заданий нет.'}</text>}>
            <For each={visible()}>{(job) => <box id={job.id} flexDirection="column" onMouseUp={() => { setSelectedID(job.id); setDetails(true); }}>
              <text fg={context.theme.text.base}>{selectedID() === job.id ? '› ' : '  '}{kinds[job.kind]} · {status(job)}</text>
              <text fg={context.theme.text.muted} wrapMode="none">  {title(job)}</text>
            </box>}</For>
          </Show>
        </scrollbox>
        <text fg={context.theme.text.muted}>↑/↓ выбрать · enter открыть · h история</text>
      </>}>
        <text fg={context.theme.text.base}>{kinds[selected().kind]} · {stopping() ? 'Останавливается' : status(selected())}</text>
        <text fg={context.theme.text.muted} wrapMode="word" maxHeight={3}>{title(selected())}</text>
        <text fg={context.theme.text.muted}>{sanitize(selected().id)}{selected().due ? ` · запуск: ${new Date(selected().due).toLocaleString()}` : ''}</text>
        <Show when={hasJobActivity(selected()) && Number.isFinite(selected().expiresAt)}><text fg={context.theme.text.muted}>До предельного срока: {Math.max(0, Math.ceil((selected().expiresAt - Date.now()) / 1000))} с</text></Show>
        <Show when={selected().error}><text fg={context.theme.error} maxHeight={3}>{sanitize(selected().error)}</text></Show>
        <Output context={context} job={selected()} />
        <text fg={context.theme.text.muted} onMouseUp={() => setDetails(false)}>К списку [backspace]</text>
      </Show>
    </Show>
    <Show when={actionError()}><text fg={context.theme.error}>{actionError()}</text></Show>
    <box flexDirection="row" gap={2} flexWrap="wrap">
      <Show when={canStop()}><text fg={context.theme.error} onMouseUp={stop}>Остановить [ctrl+x]</text></Show>
      <Show when={stopping() || selected()?.stopPending}><text fg={context.theme.text.muted}>Останавливается…</text></Show>
      <Show when={selected()?.workerID}><text fg={context.theme.text.base} onMouseUp={worker}>Рабочая сессия [o]</text></Show>
      <text fg={context.theme.text.muted} onMouseUp={() => void reload()}>Обновить [r]</text>
    </box>
  </box>;
}

function Commands(props) {
  const context = props.context;
  context.keymap.layer(() => ({ mode: 'global', commands: [{
    id: 'opencode.jobs.open', title: 'Задания и мониторы', group: 'Session', palette: true,
    slash: { name: 'joblist' },
    enabled: () => context.ui.router.current().type === 'session',
    run: () => { const route = context.ui.router.current(); if (route.type === 'session') openJobs(context, route.sessionID); },
  }] }));
  return <></>;
}

export default Plugin.define({
  id: 'opencode.jobs.tui',
  setup(context) {
    context.ui.slot({ append: 'app', render: () => <Commands context={context} /> });
    context.ui.slot({ append: 'sidebar.content', render: (props) => <Status context={context} sessionID={props.sessionID} /> });
    context.ui.slot({ append: 'prompt.footer.status', render: (props) => <Status context={context} sessionID={props.sessionID} compact /> });
  },
});
