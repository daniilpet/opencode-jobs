# Using jobs

This guide describes **0.3.1 preview**, adding connection diagnostics. Its finite limits,
dedicated worker sessions, and security hardening are not in the v0.1.0 bundle.
Existing installations require a separately reviewed manual update.

## 1. Commands and tools

| Command | Example | Result |
|---|---|---|
| `/background` | `/background npm test` | Job ID now; native shell completion later |
| `/monitor` | `/monitor --regex "ERROR|FAILED" --before 3 --after 3 --debounce 5 -- npm run build` | Matching output with nearby context |
| `/schedule` | `/schedule in 10m check the result` | One prompt at a future deadline |
| `/schedule` | `/schedule at 2026-10-06T15:00:00+03:00 check the result` | One prompt with an explicit time zone |
| `/loop` | `/loop 5m check the build status` | Recurring prompts |
| `/jobs` | `/jobs` | This session's jobs and scheduler health |
| `/cancel` | `/cancel job_<id>` | Cancel future deliveries and interrupt the owned shell or worker session |

The model-facing tools have names `opencode_jobs_background`,
`opencode_jobs_monitor`, `opencode_jobs_schedule`, `opencode_jobs_loop`,
`opencode_jobs_jobs`, and `opencode_jobs_cancel`. They accept the same arguments
in a `raw` string. Command text is passed to the existing native shell unchanged.
Choose commands for your platform; the plugin does not translate PowerShell to sh.
The six slash-command names are registered at the session's location; avoid
loading another plugin that defines the same names.

Durations accept `s`, `m`, `h`, or `d`, including combinations such as `1h30m`.
The minimum loop interval is 10 seconds.
Absolute deadlines must contain a time-zone offset. The schedule horizon is
30 days. A node allows up to 20 active jobs and 100 outstanding plugin messages,
counting the union of local outbox IDs and already admitted, still-pending inbox IDs.
Terminal history is pruned toward 50 records, while undelivered messages,
unfinished executions, saved results, and pending cleanup protect their owners
from pruning. Monitor context and output are bounded.

### Finite job limits

| Kind | Default lifetime | Explicit maximum | Run count |
|---|---|---|---|
| `background` | 30 minutes | 24 hours | One shell launch |
| `monitor` | 1 hour | 24 hours | One shell launch |
| `loop` | 1 hour from creation | 24 hours | 12 admissions by default; maximum 100 |
| `schedule` | 30 minutes of execution, after waiting for its date | 24 hours of execution; 30-day schedule horizon | One admission |

For model-facing tools, `timeout` is a duration string such as `2h`; `maxRuns`
is an integer available only for `loop`. The loop interval must be shorter than
its lifetime. Explicit increases are reserved for work requested by the user.
The hard ceilings cannot be disabled with zero or raised by tool arguments.
These are tool input fields, not flags embedded in `raw`. A schedule's execution
budget starts at its first firing, before worker creation, and includes setup,
queue waiting, approval waiting, and execution. Its preceding wait for the
scheduled date is separate.

Shell approval waiting and execution are separate stages, each bounded by the
configured timeout. An expired approval request cannot subsequently launch work.
At the first shell attachment, its native start time fixes the stored execution
deadline. Reattachment and restart never extend it. The native executor enforces
the execution timeout even without the jobs pump; startup and process termination
can add overhead, so the deadline is not a hard real-time guarantee.

Loops stop on lifetime or admission count, whichever comes first. The last
count-limited admission can still be consumed until the lifetime expires.
Expiry removes still-pending owned messages and interrupts the dedicated job
session. A local timer and model/tool guards in that session's location enforce
the deadline independently of the pump. The host's event loop must remain running;
this is not a hard real-time or operating-system sandbox guarantee. Native model
requests and foreground shell cancellation are covered; arbitrary third-party
tools that ignore cancellation are outside that guarantee.
There is no automatic extension or replacement job after a limit is reached.

If another message would exceed the queue limit, the producing job stops, its
owned shell or worker is stopped, and its pending deliveries are cancelled. No overflow
notification is added. `/jobs` retains the reason. A failed cleanup remains
visible as `stopPending: true` with `untrusted.cleanupError`; subsequent ticks
retry cleanup only. The original command or prompt is never relaunched.

### 1.1. Model tool selection

The canonical guidance is in `src/guidance.js`. The plugin registers OpenCode
2.0.22's `session.hook('context', ...)` to append a text system part before each
agent-loop request, including tool-driven continuations. It preserves existing
system parts, role, messages, tools, permissions, and generation options. It does
not change persisted history, title generation, compaction, or transient generation.
No separately maintained ForgeFlow prompt is required.

Guidance is built from the request's tool snapshot, not the unfiltered registry.
If no jobs tools are available, nothing is added. With a subset, only its selection
rules appear. An identical block already present is not appended again. For example,
a role denying shell gets no background/monitor recommendation. Later plugins can
edit the request; the model must still use only the final tools and obey permissions.

The guidance asks the model to:

- Prefer `background` for long permitted tests, builds, downloads, or other shell
  work; keep short commands and reads on ordinary tools.
- Use `monitor` for a concrete output event. For a numeric condition such as
  `value < 0.5`, an authorized script performs the comparison and prints a marker
  when the condition holds; `monitor` matches that marker. It does not evaluate
  numeric expressions or conditional operators itself. Define when observation ends.
- Use `schedule` for an explicitly requested future prompt, with a known time and
  time zone where applicable. Use `loop` only for requested periodic model work,
  with a clear interval and stopping condition. Frequent technical checks can run
  inside a script without calling a model for every sample.
- Report the real job ID, continue independent authorized work, or finish the
  response while waiting for automatic notification. Do not wait through sleep
  commands or repeatedly poll completion.
- Use `jobs` for requested status, diagnostics, and context recovery. Use `cancel`
  to stop a session-owned job when requested or when the agreed observation ends.
- After an error or ambiguous response, establish whether the job/process already
  exists and what it did before deciding on another attempt. Do not launch the same
  command again through a fallback tool.

These instructions do not grant permissions, add blanket allow rules, or create
jobs on their own. Tool availability does not prove the pump is healthy. The model
must not promise unconfirmed execution/delivery or place secrets in commands/prompts.
Scheduled prompts can incur provider costs. Mock-provider integration checks prove
delivery of the guidance, not autonomous tool selection by a real model.

### 1.2. Terminal task management

The task manager is included starting with v0.3.0. Click the bottom
jobs indicator, select **Задания и мониторы** in the command palette, or choose
`/joblist` in slash completion. This local command opens the interface directly;
`/jobs` remains the existing model-facing status command.

The window is scoped to the conversation that owns the jobs. Active entries include commands,
monitors, future schedules, repeating jobs, and workers that are still executing
after scheduling has completed. Use the arrow keys and Enter, or click a row, to
inspect an entry. Press `h` to switch between active entries and retained history.

A job created inside a child session, such as a subagent, belongs to the root
conversation of that chain. It appears in the root session's window marked
**[Агент]**; its details show the creating session, and its notifications are
delivered to the root conversation with the creating agent named in the message.
Every session of the chain sees the same shared list, while unrelated sessions
stay isolated. A scheduled or repeating job created by a subagent forks its
worker snapshot from the root conversation, so the worker works with the root
conversation's context. Jobs saved by earlier versions keep their original
session attribution; no state migration is performed. Worker sessions still
cannot create nested jobs.

The detail view shows the job type, command/prompt, state, scheduled time and
remaining execution lifetime when available. Captured shell output updates while
the view is open; it retains at most 32,768 characters from the end of the output.
Earlier output may be omitted. File-redirected output is not displayed.
If the host has removed a stopped shell, only the retained short preview is
available after reopening its details; the window reports the read failure.
Use the arrow/PageUp/PageDown keys to scroll and End to follow new output. If a job has a
worker session, press `o` or click **Рабочая сессия** to open its existing transcript.

Press `Ctrl+X` or click **Остановить** to stop the selected job. This invokes the
existing cancellation operation directly, without asking a model. Stopping a loop
also cancels future iterations. An already-produced loop result remains queued for
delivery to the parent session when the user cancels the loop.
**Останавливается** means cleanup is still pending; it does not claim that the
process has already stopped. A confirmed worker result
awaiting finalization is shown as **Завершается** and cannot be discarded by Stop.
Once finalization completes, a repeating job can be stopped normally.

If completion was already observed by the scheduler, a late cancellation preserves
the result. Physical process exit and the scheduler's observation are not atomic:
the ordering of those observations determines the outcome of a close race.

Press `r` to refresh, Backspace to return from details to the list, and Escape to
close the window. Opening, reading, and stopping jobs do not submit prompts.
Normal job execution and its result notifications retain their documented model
costs. Switching sessions closes the window; late responses cannot populate the
new session's display.

When the pump is unavailable but the server responds, the window warns and still
allows direct cancellation. On loss of the server connection, retained information
is marked stale and Stop is disabled until a successful refresh. An unconfirmed
cancellation displays an error; inspect refreshed state before trying again.
In 0.3.0, the same connection warning is also used for authorization and other
request failures. See [connection warnings and recovery](#51-connection-warnings-and-recovery).

## 2. Understand delivery

A scheduled prompt runs in a dedicated session created by OpenCode's native fork
at the first firing. The fork snapshots the original conversation's available
history, instructions, agent, model, location, and session permission rules.
Pending inbox entries and incomplete messages are not copied. Later changes in
the original session do not automatically propagate to this snapshot.

One loop retains the same job session and its iteration history. Ticks coalesce
while the previous iteration is queued or still executing, or its owned messages
remain outstanding. The internal `coalesced` counter records combined ticks;
it is not exposed by the model-facing status projection. The indicator and
`/jobs` refer to the local node only.

Within the job session, nested subagents, new jobs, and native background-shell
launches are forbidden. Foreground shell retains native permission checks, with
its timeout bounded by the remaining job budget. These restrictions do not grant
permissions or make arbitrary authorized shell code an OS sandbox.

For a schedule, `completed` means the scheduler generated the delivery message.
`delivery: sent` means OpenCode accepted it; `pending` or `failed` means delivery
is waiting or failed. `workerID` identifies the dedicated session;
`executionStatus` reports its separately observed execution outcome. Neither an
admission nor scheduling `completed` proves successful execution.

A confirmed successful result is redacted, bounded to 8,000 characters, and
persisted before any required worker stop. An unknown stop acknowledgment cannot
replace that saved success with a later interruption or expiry: recovery retains
it across restart and deadline, retries the stop, and then queues the result.
A stop error on this path appears under `untrusted.observationError`.

The result is delivered to the original session through the durable outbox and
wakes its model. Processing that notification has its own provider costs and
belongs to the original conversation, outside the job-session execution budget.
The full worker history is retained for inspection.

Cancellation removes future delivery attempts and owned queued messages, aborts
pending shell approval, and interrupts the owned job session or shell process.
It does not interrupt the original conversation's processing of a result already
consumed there, or roll back side effects. Native shell completion messages are
provided by OpenCode; the plugin does not duplicate them.

Starting with v0.3.0, late cancellation preserves a
terminal outcome already observed by the scheduler. Cancelling a modern worker
loop also retains its produced result in the outbox and accepted notifications
to the parent session while removing pending worker prompts. The stored format
does not distinguish the types of already-accepted parent notifications, so those
notifications are retained together. Deadline and queue-overflow cleanup retain
their existing cancellation policy. See [ADR 0003](adr/0003-session-task-management.md).

## 3. Recovery

The node, OpenCode server, and pump must be running at the deadline. Normal tick
resolution is about a second, without a real-time guarantee. A running scheduler
treats more than five seconds of lateness as a miss. On restoration, a deadline
that already passed is reported as missed rather than executed retroactively.

If delivery failed and the deadline becomes too old, the scheduler checks the
stable message ID against the server. An already admitted request is not
replayed; a request confirmed not admitted is replaced by a failure notification.
An unavailable transport delays that reconciliation instead of assuming success.

Worker creation records an intent before the fork request. An unknown creation
outcome is terminal and is not automatically retried. Inspect session history and
the failure reason before deciding on a replacement job. Deadlines and admission
counts survive restart; expired or terminal workers are blocked before model
dispatch, including automatic recovery and compaction. Plugin cleanup attempts
to interrupt its owned workers before removing their timers and reports failures.
Timer-based interruption makes
at most three attempts without the pump and logs failures; this is not an
unconditional termination guarantee when the host cannot complete cancellation.

After a server restart, an existing shell can continue being observed if its
original process remains available. A lost shell becomes `interrupted`; the
model is notified and must decide what to do. Automatic shell replay is forbidden
because the command may already have performed some actions. The monitor persists
its output cursor, partial line, match window, and notification together.

Failure messages may also wait in the inbox while the model/provider is
unavailable. A corrupt storage record is rejected; it is not silently replaced
with an empty job list. Do not delete the OpenCode database as a recovery step.

Before upgrading, review [legacy state requirements](../DEPLOYMENT.md#4-state-and-updates).
Active unbounded legacy jobs block loading. Old schedule/loop tracked deliveries
without a worker and prompt outbox entries not targeting a confirmed worker also
block loading, even when their job is terminal. No automatic transfer, replay,
or interruption of the original conversation is performed. Future schedules
without old deliveries retain their dates.
Validated schedules record the new execution mode before creating messages, so a
new failure notification without a worker is not mistaken for a legacy prompt.

## 4. Security and costs

Native delegation retains OpenCode's shell scanner and permission checks. No
blanket allow rule is added. Separate before/after hooks for the original `shell`
tool name are not replayed; hooks for the wrapper still apply.

The bridge validates one snapshot of the local service registration before any
network request. It accepts literal loopback addresses, maps `localhost` to
`127.0.0.1`, verifies server version and PID, rejects redirects, and restricts
API requests to the same origin. Discovery and response reading share a finite
10-second timeout, including calls with an external cancellation signal.
Job ownership is scoped to the originating session in the plugin's tools; this
does not turn OpenCode into a sandbox for mutually untrusted operating-system users.

Command output is untrusted data, framed with a per-notification marker. ANSI and
common credential formats are filtered, but arbitrary secrets and personal data
cannot be reliably detected. Never depend on output redaction to protect secrets.
Regex evaluation runs in a bounded worker to limit pathological patterns.

The `jobs` and `cancel` tools expose an allowlisted status projection. Commands,
prompts, raw partial monitor lines, and internal delivery state are excluded.
Redacted diagnostics and the last three preview lines appear under `untrusted`.
This projection does not redact OpenCode's database, native shell output, or
authenticated administrative access to the internal jobs interface.

Scheduled and recurring prompts use the session's configured model. They can
incur API costs or request additional permissions. Use sensible intervals and
check unattended jobs regularly. For security findings, see [SECURITY.md](../SECURITY.md).

## 5. Troubleshooting

### 5.1. Connection warnings and recovery

Warnings remain visible in the bottom indicator and task window. They do not
prove that a job failed or that its process stopped. After a failed list request,
retained information is stale and Stop is unavailable until a successful refresh.

**Version scope:** version 0.3.0 shows **«Задания: связь потеряна»** for all
list-request failures. The **0.3.1** interface distinguishes authorization,
transport, and other request errors as listed below. These more specific messages
require an updated installation; the recovery guidance also applies to 0.3.0.

| Situation | Warning in the 0.3.1 interface | Checks and recovery |
|---|---|---|
| Server rejects authentication, including a stale client after a service password change | «Задания: ошибка авторизации»; the window explains that the server rejected authentication | Reopen the same existing session in a new OpenCode client. This refreshes the client connection without restarting the service. Do not clear credentials or disable authentication as a workaround |
| Transport failure or request timeout | «Задания: связь потеряна» | Check `opencode service status` under the same user account. If the intended service is stopped, start it with `opencode service start`. Refresh the task list after connectivity returns; a timeout alone does not prove the service stopped |
| Another request failure, such as an unexpected server response | «Задания: ошибка запроса» | Once the service is reachable, inspect `opencode api get /api/plugin` from the affected project and confirm that jobs is active. Record the versions and a sanitized reproduction if the error persists; this warning alone does not identify the cause |
| Server responds but the jobs pump is unhealthy | «Планировщик недоступен» | Inspect the jobs task/service and `pump-status.json` as described below. Direct cancellation remains available through the server |

The output view and an unconfirmed Stop also distinguish request failures in the
0.3.1 interface. Raw server errors, headers, and credentials are not displayed.
Successful list and output reads clear their respective warnings. An error does not trigger
automatic command replay, service restart, or password changes.

`opencode api` can start the managed service when discovery finds no healthy
compatible service. Use `opencode service status` first when only inspecting its
state. Do not delete service-registration files or the OpenCode database as a
recovery step.

### 5.2. Password changes with an already-open client

The following sequence can trigger the authorization warning in an existing client:

```text
opencode service unset password
opencode service start
opencode service status
```

This is a reproduction sequence, not a recovery procedure. In OpenCode 2.0.22,
unsetting the password stops the managed service and removes the configured value.
The next service start generates and saves a new password; it does not turn
authentication off. The main terminal client can reconnect, while an already-loaded
terminal plugin retains its previous client object and authentication headers.
Jobs requests then receive HTTP 401 even if the pump has discovered the new
registration and is healthy.

Reopen the affected session in a new terminal client and check `/joblist` again.
Closing the terminal client does not require stopping the shared server or pump.
If the warning persists, use the checks in section 5.1 instead of repeatedly
changing the password or relaunching commands whose outcome is unknown.

The stale client reference is visible in the
[OpenCode 2.0.22 plugin context](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/tui/src/plugin/api.tsx#L136-L144).
The diagnostic change in jobs explains this condition; it does not fix the host's
plugin-client lifecycle or automatically refresh its credentials.

### 5.3. Scheduler health and plugin loading

If `/jobs` reports unhealthy, inspect `pump-status.json` and the new task/service
described in [DEPLOYMENT.md](../DEPLOYMENT.md). Confirm the server still reports
2.0.22 and is reachable under the same account. The pump records connection errors
and retries its tick; it does not repeat native shell launches.

If a command is not listed, inspect `opencode api get /api/plugin` and
`opencode api get /api/command` from the affected location. Confirm that the built
plugin, including its root `index.js` and `tui.js`, was installed. Do not add an
unbuilt clone as a plugin. If other plugins define `/jobs` or `/cancel`, remove the
configuration conflict deliberately rather than editing generated files.

For a bug report, include versions, platform, a sanitized reproduction, and the
relevant job status. Do not attach databases, full session exports, or unredacted
logs. Tests leave temporary files intact so you can inspect failures; remove only
the test artifacts you intend to discard.
