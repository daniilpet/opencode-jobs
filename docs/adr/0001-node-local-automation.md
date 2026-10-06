# ADR 0001: node-local automation for OpenCode V2

## 1. Status and context

Accepted. Each node owns its schedules. Deadlines persist, failures are explicit,
and interrupted shell commands must never be replayed automatically. OpenCode
2.0.22 lazily loads plugins per Location and can unload inactive locations.
Plugin storage is scoped to plugin ID and the node database, not the location;
independent writers would corrupt a shared job list.

[ADR 0002](0002-finite-job-execution.md) supersedes the original shared-session
execution contract for scheduled prompts and adds finite execution boundaries.
That change is included in 0.2.0 preview and is not in v0.1.0; the behaviour below
reflects the 0.2.0 contract. The anchor, supervised pump, durable outbox, and native
shell delegation remain.

## 2. Alternatives

1. A legacy monitor plugin and custom fork: incompatible with the installed V2 API.
2. Timers only inside a V2 plugin: execution stops when its Location unloads.
3. A separate database and HTTP scheduler: duplicates existing OpenCode services.
4. A supervised local pump and one anchor instance: selected.

## 3. Decision

The `opencode.jobs` anchor instance owns all job state in `ctx.storage`. Other
instances delegate operations through the authenticated OpenCode interface.
The pump calls `tick` about once a second, activating the anchor after restarts
or unloads. It does not open an additional HTTP listener.

Shell launch delegates only to the registered native executor with a real
ToolContext, preserving scanning, external-directory checks, and permissions.
The production bridge uses `/api/shell` for observation and cancellation only.
The isolated regression test deliberately creates a shell directly to reproduce
the cancel-before-attach race; that path is not available through production tools.

State writes are serialized, and an outbox is persisted before admission. Stable
message IDs reconcile an unknown acknowledgment without executing a second prompt.
That guarantee does not extend to arbitrary shell/model side effects. A new
anchor stops and drains its predecessor before restoring storage.

## 4. External behaviour

| State | Deadline/process | Session | Action |
|---|---|---|---|
| Cancelled/terminal | Any | Any | Do not create a new execution |
| Active schedule | Future | Any | Wait |
| Active schedule | Due | Original idle/busy | Snapshot into a dedicated bounded session; admit there |
| Restored schedule | Already passed | Any | Report missed; do not replay prompt |
| Loop | Due, previous iteration queued/running | Worker busy | Coalesce; no concurrent iteration |
| Shell recovery | Process available | Any | Continue observation without launch |
| Shell recovery | Process lost | Any | Report interrupted, outcome may be unknown |
| Delivery error | Deadline still admissible | Any | Retry admission with the same ID |
| Delivery error | Too late, ID already admitted | Any | Preserve admission, no replay |
| Delivery error | Too late, ID not admitted | Any | Replace prompt with missed notification |

Recovery first validates legacy state. Active unbounded jobs and old prompt
deliveries requiring manual review block loading before these recovery actions.
No old prompt is automatically transferred to a worker or replayed in its original
conversation, and the original conversation is never interrupted for migration.

## 5. Consequences and limits

This is not hard real-time scheduling. Late ticks over five seconds become misses;
the model can start later due to inbox order, provider failure, or permissions.
Native background-shell completion is not duplicated. Native executor delegation
does not replay before/after hooks under the original shell tool name.

Monitoring uses combined stdout/stderr, a bounded regex worker, framed output,
and best-effort redaction. These are risk reductions, not a complete data-loss
prevention or prompt-injection protection mechanism. Windows and Linux supervisor
installers are separate; state is never replicated between machines.

## 6. Primary sources for the checked version

- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [V2 RPC](https://opencode.ai/v2/docs/build/plugins/rpc)
- [Native shell 2.0.22](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/tool/plugin/shell.ts)
- [Location unloading](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/location-activity.ts)
- [Storage scope](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/plugin/host.ts)
- [Admission idempotency](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/inbox.ts)
