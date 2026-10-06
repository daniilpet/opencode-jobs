# Using jobs

## 1. Commands and tools

| Command | Example | Result |
|---|---|---|
| `/background` | `/background npm test` | Job ID now; native shell completion later |
| `/monitor` | `/monitor --regex "ERROR|FAILED" --before 3 --after 3 --debounce 5 -- npm run build` | Matching output with nearby context |
| `/schedule` | `/schedule in 10m check the result` | One prompt at a future deadline |
| `/schedule` | `/schedule at 2026-10-06T15:00:00+03:00 check the result` | One prompt with an explicit time zone |
| `/loop` | `/loop 5m check the build status` | Recurring prompts |
| `/jobs` | `/jobs` | This session's jobs and scheduler health |
| `/cancel` | `/cancel job_<id>` | Cancel future deliveries and the owned shell process |

The model-facing tools have names `opencode_jobs_background`,
`opencode_jobs_monitor`, `opencode_jobs_schedule`, `opencode_jobs_loop`,
`opencode_jobs_jobs`, and `opencode_jobs_cancel`. They accept the same arguments
in a `raw` string. Command text is passed to the existing native shell unchanged.
Choose commands for your platform; the plugin does not translate PowerShell to sh.
The six slash-command names are registered at the session's location; avoid
loading another plugin that defines the same names.

Durations accept `s`, `m`, or `h`. The minimum loop interval is 10 seconds.
Absolute deadlines must contain a time-zone offset. The schedule horizon is
30 days. A node allows up to 20 active jobs and 100 undelivered messages.
Up to 50 terminal history records are kept, except jobs still owning undelivered
or queued messages. Monitor context and output are bounded.

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

## 2. Understand delivery

A prompt enters the original session's durable inbox. It does not interrupt the
current response. A loop coalesces ticks while its previous message remains
queued; `coalesced` records how many ticks were combined. The indicator and `/jobs`
refer to the local node only.

For a schedule, `completed` means the scheduler generated the delivery message.
`delivery: sent` means OpenCode accepted it; `pending` or `failed` means delivery
is waiting or failed. Neither status confirms that the model completed the
requested work. Inspect the session's response for that result.

Cancellation removes future delivery attempts and queued messages still owned by
the job. It cannot interrupt or undo work from a message already consumed by the
model, and cannot roll back shell side effects. Native shell completion messages
are provided by OpenCode; the plugin does not duplicate them.

## 3. Recovery

The node, OpenCode server, and pump must be running at the deadline. Normal tick
resolution is about a second, without a real-time guarantee. A running scheduler
treats more than five seconds of lateness as a miss. On restoration, a deadline
that already passed is reported as missed rather than executed retroactively.

If delivery failed and the deadline becomes too old, the scheduler checks the
stable message ID against the server. An already admitted request is not
replayed; a request confirmed not admitted is replaced by a failure notification.
An unavailable transport delays that reconciliation instead of assuming success.

After a server restart, an existing shell can continue being observed if its
original process remains available. A lost shell becomes `interrupted`; the
model is notified and must decide what to do. Automatic shell replay is forbidden
because the command may already have performed some actions. The monitor persists
its output cursor, partial line, match window, and notification together.

Failure messages may also wait in the inbox while the model/provider is
unavailable. A corrupt storage record is rejected; it is not silently replaced
with an empty job list. Do not delete the OpenCode database as a recovery step.

## 4. Security and costs

Native delegation retains OpenCode's shell scanner and permission checks. No
blanket allow rule is added. Separate before/after hooks for the original `shell`
tool name are not replayed; hooks for the wrapper still apply.

The bridge uses authenticated shared-service discovery and accepts loopback only.
Job ownership is scoped to the originating session in the plugin's tools; this
does not turn OpenCode into a sandbox for mutually untrusted operating-system users.

Command output is untrusted data, framed with a per-notification marker. ANSI and
common credential formats are filtered, but arbitrary secrets and personal data
cannot be reliably detected. Never depend on output redaction to protect secrets.
Regex evaluation runs in a bounded worker to limit pathological patterns.

Scheduled and recurring prompts use the session's configured model. They can
incur API costs or request additional permissions. Use sensible intervals and
check unattended jobs regularly. For security findings, see [SECURITY.md](../SECURITY.md).

## 5. Troubleshooting

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
