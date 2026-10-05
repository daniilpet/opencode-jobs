# Security policy

## Supported scope

The 0.1.x preview is tested with OpenCode 2.0.22 on Windows and Linux only.
Compatibility and security of newer hosts or unsupported platforms are not
claimed. Patches will be handled on a best-effort basis; there is no response SLA.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** button on this repository's Security tab:
https://github.com/daniilpet/opencode-jobs/security/advisories/new

Describe impact, affected versions, and a minimal reproduction with dummy data.
Do not post exploits involving real secrets or private job/session contents in a
public issue. If private reporting is unavailable, request a private contact in
an issue without including vulnerability details. Coordinate disclosure with the
maintainer and keep affected users' data out of the report.

## Threat boundaries

- The plugin delegates shell launch to OpenCode's native executor and permissions.
  It is not an OS sandbox, a multi-tenant authorization system, or a guarantee of
  exactly-once arbitrary side effects.
- The scheduler reaches only the authenticated loopback shared server. Protect
  your OS account, service registration, and OpenCode database accordingly.
- Commands and prompts are persisted. Do not embed credentials in them.
- Command output is untrusted; redaction and framing are best effort. They do not
  reliably remove all secrets or prevent all prompt-injection attempts.
- Recurring work can cause model-provider costs. Choose permissions and intervals
  suitable for unattended use.

## Known dependency advisory

GHSA-4x5r-pxfx-6jf8 affects the Babel version pulled by the tested OpenTUI toolchain.
The initial audit reports three low-severity entries for the same dependency
chain, with no high/critical entries. Babel compiles only this repository's TUI
source; build dependencies are not included in the installed runtime bundle.
Do not compile untrusted JSX or source-map references through this build process.
Upgrading the toolchain requires compatibility testing rather than a forced pin
override. Run `npm audit` yourself; advisory status can change after release.
