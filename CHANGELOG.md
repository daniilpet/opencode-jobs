# Changelog

## Unreleased

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
