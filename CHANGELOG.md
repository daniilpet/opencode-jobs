# Changelog

## Unreleased

- Accept spaces between duration units in every duration input, including the
  tool `timeout` field (`2h 15m` equals `2h15m`), and name the rejected value
  in the duration error message. The model-facing `opencode_jobs_*` tools now
  validate `timeout`/`maxRuns` locally before the RPC call, so an invalid
  duration surfaces as the parser message instead of a host HTTP 500.
- Tolerate a leading `loop`/`schedule` keyword in tool `raw` arguments (the
  slash commands already strip it) and document the bare tool `raw` syntax
  for loop.
- Expiry by the execution budget now reports the worker session and its last
  observed execution status (still active, interrupted, not finished) instead
  of the bare expiry-only reason.
- Add a macOS (darwin) installer. `scripts/install-darwin.sh` installs the
  verified bundle under `~/.config/opencode/plugins/jobs` and supervises the pump
  with a per-user launchd LaunchAgent (`com.daniilpet.opencode-jobs`): it starts
  at login, is restarted by launchd only after a non-zero exit subject to the
  launchd throttle interval (10 seconds, versus `RestartSec=2` on Linux), appends
  output to `pump.log` in the state directory instead of a journal, records the
  absolute Node executable path at installation, and refuses to replace an
  existing installation. Because LaunchAgents do not inherit the login-shell
  environment, the installer also records the path-related environment variables
  (`OPENCODE_JOBS_STATE`, `OPENCODE_JOBS_SERVICE_FILE`, `XDG_STATE_HOME`,
  `XDG_DATA_HOME`, `XDG_CONFIG_HOME`) set in the installing shell into the agent
  so the pump sees the same directories and server registration as OpenCode.
  The single-confirmation updater stops and restarts the agent through
  `launchctl` without elevation. macOS joins the supported
  installer platforms.
- Verified host OpenCode 2.1.0: the local isolated integration run of
  `scripts/smoke.js` (mock provider, no model requests) passed on macOS
  (arm64, Node 24.22.0), covering native background/monitor, subagent result
  delivery, permission denial/ask flows, approval expiry, cancellation races,
  finite timeouts and worker isolation.

## 0.5.0 - updater and subagent completion

- Deliver observed subagent `background` completion to the owning conversation
  through the existing durable outbox and wake its model without a user prompt.
  Include the actual status, exit code and up to 8,000 characters of redacted,
  untrusted output. Preserve this result across delivery failures, restart and
  the completed command's deadline. Subagent background expiry also notifies the
  owner after cleanup. Root-launched commands retain native completion without
  a second plugin notification; explicit cancellation does not resume the task.

- Deliver subagent `schedule`/`loop` results and confirmed failure notifications to
  both the root conversation and the original creating child, waking each with
  separate durable admission IDs. Partial delivery failures do not hide behind a
  successful recipient or repeat worker execution. Preserve produced loop results
  and recipient routes during cancellation. Wait durably for room for both
  notifications without increasing the 100-message limit.

- Add a single-confirmation updater (`scripts/update.js`) shipped in the bundle.
  It verifies the release checksum and a safe archive listing, refuses to update
  while jobs are active or deliveries and results are pending, re-checks that
  gate right before stopping the pump, backs up the previous runtime, replaces
  only the jobs plugin directory, and automatically rolls back when the installed
  version or the preserved job state fails verification (Windows: one UAC per
  stop-and-start cycle, a second one only for a rollback). A new `preflight` RPC
  exposes the sanitized readiness aggregate this relies on; updating from
  versions without it still follows the manual procedure.

## 0.4.0 - host range and subagent attribution

- Accept OpenCode hosts 2.x (2.0.22 or newer) instead of a fixed version list: the
  contract has stayed stable across 2.0.22-2.0.26, and the registration must still
  match the live server exactly. A known-broken host version can be blocked
  individually. Verified hosts: 2.0.22, 2.0.24, 2.0.26 (CI runs isolated
  integration on each).
- Pin the build SDK to @opencode/plugin 2.0.24; the single generated client works
  against supported servers. The build now replaces the vendored client copy
  instead of merging over stale chunks. On hosts since 2.0.24, a job whose working
  directory was deleted on disk is observed as a lost shell (HTTP 404), matching
  the existing recovery reporting.
- Attribute jobs created inside child sessions (subagents) to the root
  conversation: they appear in its task manager marked with the creating agent,
  results wake the root conversation, and every session of the chain can stop
  them. Unrelated sessions remain isolated. Previously saved jobs keep their
  original attribution.

## 0.3.1 - connection diagnostics preview

- Keep connection warnings visible while distinguishing authorization failures,
  transport failures, and other request errors in the task interface. Retain stale
  data and cancellation safeguards; do not expose raw error details.
- Document recovery after managed-service password changes, server connection
  failures, and an unavailable scheduler. This does not repair OpenCode's stale
  terminal-plugin client after reconnect.

## 0.3.0 - task management preview

- Open task management from the bottom indicator, command palette, or local
  `/joblist`: current-session active jobs and history, captured shell output,
  worker-session navigation, and direct cancellation without a model request.
- Keep executing workers visible after scheduling completes. Show pending cleanup
  and connection failures, and preserve already-observed completion during a late
  cancellation, including stored worker results awaiting finalization.
- Add Bun/OpenTUI interaction tests and real-host Linux task-management checks.

## 0.2.0 - security preview

### Security

- Atomically allocate a fresh integration-test root before copying files, refusing
  existing explicit paths and preventing concurrent runs from sharing a root.
- Add a live lockfile advisory gate before builds, including development dependencies,
  with daily/manual checks and retained reports on success or failure.
- Analyze JavaScript and GitHub Actions with CodeQL security-extended queries,
  reporting findings in GitHub Code scanning with job-scoped permissions.

- Bound shell approval and execution separately (background 30m, monitor 1h;
  maximum 24h each); bound loops to 1h/12 admissions by default and 24h/100 maximum.
- Run schedules and loops in native snapshot workers with durable deadlines,
  cancellation guards, and no nested jobs, subagents, or native background shell.
  Schedules retain a 30-day waiting horizon and a separate 30m execution default
  (24h maximum); parent result processing is outside the worker budget.
- Reject unbounded active legacy jobs and old scheduled-prompt deliveries requiring
  manual review before recovery side effects; preserve confirmed bounded worker
  results across unknown stop acknowledgments, restart, and expiry.
- Count accepted pending inbox messages toward the queue ceiling, stop saturated
  producers, restrict model-facing diagnostics, and validate loopback transport
  with finite waits and no redirects.
- Update vulnerable source dependencies with targeted Seroval/Babel overrides
  and add serialization/compiler compatibility checks to local and CI validation.

These changes are not in v0.1.0. Existing installations require a separately
reviewed manual update. Execution limits are not an OS sandbox or a
hard real-time guarantee; third-party tools that ignore cancellation are excluded.

### Guidance

- Automatically append tool-selection guidance to the agent-loop system context,
  limited to jobs tools available in each request without replacing instructions
  or changing permissions.
- Explain numeric-condition monitoring through an authorized script and output
  marker; no new condition language or automatic model polling is introduced.
- Add guidance regression tests and native mock-provider request assertions for
  full, shell-denied, and no-tools roles.

## 0.1.0 - initial preview

- Persistent machine-local schedules and loops for OpenCode V2.
- Native background-shell delegation and regex output monitors.
- Session-scoped jobs, cancellation, durable inbox delivery, and a TUI indicator.
- Explicit missed/interrupted notifications with no automatic shell replay.
- Windows Task Scheduler and Linux user-systemd installers.
- Unit, isolated integration, release-layout, and cross-platform CI checks.

Tested host: OpenCode 2.0.22. Reboot/logout and Windows indicator rendering remain
unverified; this is not a general compatibility or production-readiness claim.
