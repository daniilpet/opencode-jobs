# ADR 0004: Subagent job result delivery

## Status

Accepted for the unreleased source. Existing installations are not updated by
source changes; legacy job attribution and terminal history are not migrated.

## Context

Jobs created by a subagent belong to the root conversation, but OpenCode's native
shell executor sends completion to its launching session. A subagent can return
before the command finishes. Persisting `completed` in the shared jobs list then
does not wake the root conversation. The user has to ask for the outcome manually.

The existing outbox already supports durable synthetic notifications with stable
admission IDs, `delivery: queue` and `resume: true`. Native completion is sufficient
when the launcher and owner are the same session. Changing the shell execution
context to the root would also change the permissions context and is rejected.
Suppressing or redirecting the host's native notification is not required.

Scheduled and repeating jobs run in a separate worker. Existing result delivery
targets the root only, so the creating child cannot automatically continue its
own task when that worker finishes. The owner requested that this correction be
included in the same change without replacing root delivery.

## Decision

Forward observed terminal outcomes of subagent `background` jobs through the
existing outbox as `result`. Identify the job, actual status and exit code. Retain
up to 8,000 characters of redacted output, with the cursor in the same durable
update. Read a terminal output window of up to 32,768 bytes from the native capture
before redaction, rather than joining already-redacted pages that can expose the
continuation of a split token. Do not persist raw output in plugin state. Mark
output as untrusted data with a random delimiter.
No new service, public endpoint, permission or shell execution is introduced.

| Observed terminal outcome | Subagent background | Action |
|---|---|---|
| No | No | Observe; do not claim a terminal result |
| No | Yes | Observe; do not claim a terminal result or persist raw output |
| Yes | No | Persist the outcome; retain native completion without a second notification to the owner |
| Yes | Yes | Persist the outcome and enqueue a result for the owner; delivery wakes that conversation |

Error exits and native timeouts report their actual outcomes, never success by
default. An active subagent background job reaching its scheduler deadline reports
expiry after cleanup. Explicit cancellation before observation does not enqueue a
terminal result; late cancellation preserves the already observed outcome.
Confirmed terminal results survive delivery failures, restart and the command's
deadline. Repeated attachment of the same shell to a terminal subagent background
job returns the recorded outcome without stopping it or removing its notification;
unconfirmed cleanup remains subject to the existing stop protocol.
Retries use the original admission ID and do not repeat the command.
Queue bounds and overflow policy remain in force.

Monitor matches keep their existing semantics. Direct native background shell
outside jobs is not registered or forwarded. Jobs without subagent/root attribution
retain their recorded ownership; no retroactive notification is generated for
terminal records.

### Schedule and loop recipients

For `schedule`/`loop`, send each observed result or confirmed failure/missed/expiry
notification to the root and the original `createdBy` when they differ. A root
creator still receives one notification. Prompt delivery remains worker-only;
worker snapshot, permissions, execution limits and guards are unchanged.

| Event confirmed | Creator differs from root | Action |
|---|---|---|
| No | No | Observe; do not announce a result |
| No | Yes | Observe; do not announce a result |
| Yes | No | One synthetic notification waking root |
| Yes | Yes | Separate synthetic notifications waking root and original creator |

Use existing outbox records and `messageSessions`, with a distinct stable ID per
recipient. Persist both records before delivery. A successful recipient must not
mask another recipient's pending/failing delivery. Root delivery does not depend
on child acceptance. Retry only the retained record, without creating another
worker or re-executing its prompt. An unavailable child is not replaced.

The complete notification set must fit within the existing 100-message bound.
If it does not, retain confirmed success in `workerResult` or failure in
`deferredFailure`, and wait without admitting another iteration or a partial set.
Confirmed success still survives restart and the worker deadline. Existing
overflow policies for other producers and deadline cleanup are unchanged.

Explicit cancellation of a loop retains already-produced result copies for both
recipients, including queued and accepted copies and their session mappings.
Pending worker prompts are removed. Accepted notification types remain subject
to the existing storage limitation described in ADR 0003. Cancelled work must not
resume; result notifications convey completed work and authorize no new actions.

## Consequences and verification

Native completion can still wake the launching child. The plugin sends one result
to the different owning conversation; it does not claim exactly-once arbitrary
model actions. Processing the owner's result is outside the completed command's
budget and may incur provider costs. Notifications authorize no new work.
For subagent schedules/loops both recipients may incur model costs. Concurrent
notifications do not guarantee non-duplicated subsequent actions by those models.

Observation failure remains uncertainty. Delivery acceptance is not proof of a
model response. Machine, server, pump, inbox ordering and provider availability
limit eventual continuation. Physical process exit and scheduler observation are
not atomic; the contract protects observed completion.

The regression first failed because terminal status was persisted without any
owner notification. The isolated native-host check gates a real command, lets the
child finish its response while that command is running, then releases the command
and requires a new owner model response to its result without another user prompt.
Additional checks cover error delivery, root non-duplication, delivery retry across
restart/deadline, scheduler expiry, cancellation ordering, duplicate attachment and
redaction of synthetic tokens split across observed output pages.
Schedule/loop checks cover distinct recipient IDs, confirmed failures, partial
admission failure and restart, queue backpressure, and cancellation preserving
child routes. Native-host checks hold worker responses until the creator has
returned, then require new model responses in root and creator without new user
prompts.

## Sources

- [OpenCode V2 plugin and session API](https://opencode.ai/v2/docs/build/plugins)
- Checked native shell implementation: OpenCode 2.0.22,
  `packages/core/src/tool/plugin/shell.ts`, completion targets `context.sessionID`.
