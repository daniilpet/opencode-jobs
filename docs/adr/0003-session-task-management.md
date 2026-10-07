# ADR 0003: Session-scoped terminal task management

## Status

Accepted; implementation is included in **0.3.0 preview**.

## Context

The terminal footer shows an active-job count but offers no inspection or control.
Scheduling completion is distinct from worker completion. A user must be able to
inspect or stop the selected job without submitting a prompt to a model.

OpenCode 2.0.22 exposes footer events, command layers, custom dialogs and session
navigation. Its built-in shell output dialog is not exported to plugins and cannot
be addressed by shell ID through the public command interface.

## Decision

Use a clickable footer and the local `/joblist` command to open a session-scoped
dialog. Keep the existing server `/jobs` command. Read captured output through the
host shell client, bounded to the most recent 32,768 characters. Navigate to the
existing worker transcript rather than duplicating its renderer.

Use the existing list/cancel RPC and ownership checks. No new service, storage
field or permission is introduced. Explicit cancellation preserves completion
already observed by the scheduler and confirmed loop results awaiting delivery.
For accepted modern-loop messages, the stored destination distinguishes parent
notifications from worker prompts, but not individual parent notification types.
Cancellation therefore retains accepted parent notifications together. Queue
overflow and deadline handling continue to remove pending deliveries.

| Observed state | Presentation and cancellation |
|---|---|
| Active schedule or process | Active list; Stop available |
| Scheduling completed, execution pending/running | Active list; Stop available |
| Stop acknowledgment pending | Stopping; duplicate Stop disabled |
| Successful result persisted, finalization pending | Finalizing; Stop rejected without mutation |
| Terminal outcome, no remaining activity | History; late Stop preserves outcome |
| Loop result waiting for delivery, loop active | Stop future execution; retain produced result |
| Server responds, pump unavailable | Warning; direct Stop remains available |
| Server unavailable | Retain stale display; no successful Stop claim |

## Consequences

Opening, reading and stopping do not call a model. Normal job/result delivery still
has the existing costs, including a retained result delivered after loop cancellation.
Physical process completion and scheduler observation are not atomic; this decision
protects observed completion, not an unobservable ordering guarantee.

Dialog disposal and session changes cancel subscriptions. Refreshing a job object
does not restart the output subscription when shell ID and directory are unchanged.
Component rendering tests cover these lifetimes, while a separate native-host
check verifies command registration, keyboard routing, output and cancellation.
