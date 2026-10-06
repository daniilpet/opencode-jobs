# ADR 0002: finite execution and dedicated model sessions

## 1. Status and context

Accepted; implementation is **Unreleased**, not part of v0.1.0. Existing
installations have not been updated. This decision supersedes ADR 0001's execution
of scheduled prompts in the original conversation. OpenCode 2.0.22 interrupts execution by session ID;
it has no public atomic operation for interrupting one admitted prompt while
preserving unrelated work in that same session. Stopping dispatch alone cannot
bound already-running model work.

## 2. Alternatives

1. Keep shared-session dispatch and stop only new admissions: insufficient to bound execution.
2. Interrupt the original session at the deadline: can stop unrelated user work.
3. Dedicated job sessions using the native fork, interruption, and hooks: selected.
4. Patch the host or introduce another execution service: unnecessary for the checked native paths.

## 3. Decision

The immutable hard ceiling is 24 hours. Defaults are 30 minutes for background
shell and schedule execution, one hour for monitors and loops. Loops also stop
admitting after 12 iterations by default, with an explicit ceiling of 100. These
values are project policy, not a universal scheduling standard. Tool arguments
cannot disable limits or raise these ceilings.

Background and monitor shell separate approval waiting from execution, each with
the same finite budget. A cancellation controller reaches the native executor while
approval is pending. The first attachment fixes execution expiry from the native
start timestamp; reattachment and restart do not extend it. The native shell
timeout remains effective without the pump.

Schedules keep their 30-day waiting horizon. At the first firing, the scheduler
persists the runtime deadline and creation intent before requesting a native fork.
Setup and inbox/approval waiting consume that runtime budget.
Loops use their existing absolute lifetime deadline and one fork for all iterations.
The fork snapshots the original context and session permissions. The pending inbox
and unfinished messages are excluded according to the host's fork contract.
An unknown fork outcome is not retried automatically.

Session metadata carries immutable ownership and expiry across the host boundary.
Worker-location guards read that durable metadata at context, all model-request
kinds, and tool execution boundaries. A local timer interrupts the worker even
when the pump is unavailable. Expired or terminal workers cannot dispatch again
after restart. Cleanup attempts to interrupt owned workers before removing timers
and reports failures.

Workers cannot create jobs, launch subagents, or request native background shell.
Native foreground shell retains existing permission checks and receives at most
the remaining budget. The parent conversation remains independent. A confirmed
worker result returns through the durable outbox and wakes the parent, whose
processing is explicitly outside the worker's execution budget.

A confirmed success is redacted and bounded to 8,000 characters before it is
persisted, ahead of any required worker stop. If the stop acknowledgment is
unknown, the saved result survives restart and expiry. The scheduler retries
stopping the worker and queues the saved result without re-executing its prompt
or reclassifying that success from the worker's later interrupted state.

## 4. External state matrices

| Worker metadata terminal | Deadline expired | Worker action |
|---|---|---|
| No | No | Allow bounded execution and observe completion |
| No | Yes | Persist stop, remove pending work, interrupt the owned session |
| Yes | No | Reject new execution; retry incomplete cleanup only |
| Yes | Yes | Reject new execution; retry incomplete cleanup only |

The worker's terminal metadata is distinct from scheduling status `completed`:
a schedule or final loop admission can still execute within its remaining budget.

| Tick due | Previous iteration pending/running | Scheduler action |
|---|---|---|
| No | No | Wait |
| No | Yes | Observe existing execution |
| Yes | No | Admit once if lifetime and count permit |
| Yes | Yes | Coalesce without concurrent iteration |

| Outstanding messages | Admission action |
|---|---|
| Below 100 | Reserve a stable ID before delivery |
| At 100 | Stop the producing job and its owned execution; no 101st notification |
| Legacy backlog above 100 | Stop affected owners before admitting more messages |

Outstanding IDs are the union of local outbox entries and accepted inbox messages
still pending. Worker prompts and parent notifications retain their actual target
session for cancellation and reconciliation. Unknown pending state remains counted.

| Legacy state | Upgrade action |
|---|---|
| Active background/monitor/loop without valid limits | Reject scheduler loading before recovery side effects |
| Schedule/loop with tracked deliveries but no confirmed worker, or prompt outbox entry not targeting its confirmed worker | Reject loading before recovery side effects; require separate manual review, including terminal records |
| Future one-shot schedule without old deliveries | Preserve date; apply finite execution policy when due |
| Other terminal history | Retain subject to normal history and outstanding-message protection |

Validation preserves the stored state. It does not automatically transfer or
resend old prompts, create replacement workers, or interrupt the original
conversation to enforce a newly introduced budget.

## 5. Consequences and verification boundary

The scheduler persists the worker execution mode before creating new messages.
Legacy records receive that marker only after the delivery preflight succeeds;
an outbox prompt must still target its confirmed worker regardless of the marker.

Dedicated sessions add an inspectable history and change context from a live shared
conversation to a snapshot. Their permission snapshot does not automatically track
later parent changes. Fork creation can have an unknown outcome; the plugin reports
that uncertainty instead of creating another potentially duplicated execution.

The scheduler protects unfinished executions, saved results, and cleanup records
from history pruning. `completed` describes finished scheduling; `executionStatus` separately
describes observed worker execution. Cancellation cannot undo previous side effects
or stop a result already being processed in the parent conversation.

The guarantee requires a functioning host event loop and cancellation-cooperating
execution. Native model streams and foreground shell are checked paths. This is
not an OS sandbox, a hard real-time deadline, or a guarantee for arbitrary
third-party tools that ignore cancellation.

Verification covers persisted deadlines/counts, unknown admission acknowledgments,
cancel-before-attach and pending-approval races, bounded queues, recovery gates,
actual process termination without the pump, and independent parent execution.
Dependency compatibility checks exercise the affected serialization and compiler
paths; they do not update or certify the installed host's shared runtime.

## 6. Sources

- [OpenCode V2 plugin hooks and cleanup](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode V2 API](https://opencode.ai/v2/docs/api)
- [Native shell 2.0.22](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/tool/plugin/shell.ts)
- [Session inbox 2.0.22](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/inbox.ts)
- [Location activity 2.0.22](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/location-activity.ts)

The checked implementation is 2.0.22. Current documentation can differ from that
version; runtime declarations and isolated native tests determine compatibility.
