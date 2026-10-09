# Changelog

## Unreleased

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
