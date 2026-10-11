# ADR 0004: Subagent background completion delivery

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

## Consequences and verification

Native completion can still wake the launching child. The plugin sends one result
to the different owning conversation; it does not claim exactly-once arbitrary
model actions. Processing the owner's result is outside the completed command's
budget and may incur provider costs. Notifications authorize no new work.

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

## Sources

- [OpenCode V2 plugin and session API](https://opencode.ai/v2/docs/build/plugins)
- Checked native shell implementation: OpenCode 2.0.22,
  `packages/core/src/tool/plugin/shell.ts`, completion targets `context.sessionID`.
