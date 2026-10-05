/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui';
import { createSignal, For, Show, onCleanup } from 'solid-js';
import { Jobs } from './contract.js';

function Status(props) {
  const context = props.context;
  const [state, setState] = createSignal({ jobs: [], healthy: true });
  let running = false;
  let disposed = false;
  const refresh = async () => {
    if (running || !props.sessionID) return;
    running = true;
    try {
      const result = await context.client.rpc(Jobs).list({ sessionID: props.sessionID }, {
        location: context.location ?? context.data.location.default(), signal: AbortSignal.timeout(5000),
      });
      if (!disposed) setState({ ...result, healthy: result.healthy });
    } catch {
      if (!disposed) setState((value) => ({ ...value, healthy: false }));
    } finally { running = false; }
  };
  void refresh();
  const timer = setInterval(refresh, 1000);
  onCleanup(() => { disposed = true; clearInterval(timer); });
  const active = () => state().jobs.filter((job) => job.status === 'active');
  return (
    <Show when={active().length || !state().healthy}>
      <box flexDirection="column">
        <text fg={state().healthy ? context.theme.text.base : context.theme.error}>
          {state().healthy ? `Задания: ${active().length} активных` : 'Планировщик недоступен'}
        </text>
        <Show when={!props.compact}>
          <For each={active()}>{(job) => (
            <box flexDirection="column">
              <text fg={context.theme.text.muted}>{job.kind} {job.id.slice(0, 12)} {job.due ? new Date(job.due).toLocaleTimeString() : 'выполняется'}</text>
              <For each={job.preview ?? []}>{(line) => <text wrapMode="none" fg={context.theme.text.muted}>{line}</text>}</For>
            </box>
          )}</For>
        </Show>
      </box>
    </Show>
  );
}

export default Plugin.define({
  id: 'opencode.jobs.tui',
  setup(context) {
    context.ui.slot({ append: 'sidebar.content', render: (props) => <Status context={context} sessionID={props.sessionID} /> });
    context.ui.slot({ append: 'prompt.footer.status', render: (props) => <Status context={context} sessionID={props.sessionID} compact /> });
  },
});
