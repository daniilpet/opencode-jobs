# Security policy

## Supported scope

The 0.1.x preview is tested with OpenCode 2.0.22 on Windows and Linux only.
Compatibility and security of newer hosts or unsupported platforms are not
claimed. Patches will be handled on a best-effort basis; there is no response SLA.

The hardening described below is **Unreleased** and is not included in v0.1.0.
No security release has been published. Source dependency overrides and runtime
changes do not update existing plugin or OpenCode installations.

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
- Shell launches have finite native execution timeouts and separately bounded
  approval waits. Scheduled model work runs in dedicated sessions with durable
  deadlines, local interruption timers, and pre-dispatch guards. Loops also have
  admission-count limits. Result delivery wakes the original conversation, whose
  subsequent processing is outside the worker budget. See
  [operating limits](docs/operation.md#finite-job-limits).
- Workers use a native fork at first firing, with one session retained per loop.
  Nested subagents, new jobs, and native background shell are forbidden; foreground
  shell keeps native permissions and the remaining execution budget. Enforcement
  requires a functioning host event loop and cancellation-cooperating execution.
  It is not a hard real-time guarantee; third-party tools that ignore cancellation
  are outside it.
- Upgrade validation rejects unbounded active legacy jobs and old scheduled-prompt
  deliveries before recovery side effects. Old deliveries require separate manual
  review; they are not automatically transferred or replayed, and the original
  conversation is not interrupted. See [update requirements](DEPLOYMENT.md#4-state-and-updates).
- The outstanding-message ceiling includes accepted inbox messages, not only the
  local outbox. Saturation stops the producing job and owned process; failed
  cleanup remains visible and is retried without replaying the work.
- Model-facing status excludes raw monitor state and labels redacted diagnostics
  as untrusted. Administrative access and native shell output remain separate
  boundaries. Protect persisted data independently of model-facing presentation.
- Registration is validated before authenticated discovery. Requests remain on
  the validated loopback origin, redirects are forbidden, and transport waits
  are finite even when a caller supplies a cancellation signal.

## Dependency security and compatibility

The source toolchain preserves OpenCode/plugin SDK 2.0.22, OpenTUI 0.5.14, and
Solid/preset 1.9.12. Two targeted `package.json` overrides address advisories that
cannot be fixed by refreshing the lockfile within the upstream ranges:

- `seroval: ^1.6.8` replaces Solid's `~1.5.0` requirement. The previous 1.5.6
  was affected by critical
  [GHSA-p6vx-979v-rg4c](https://github.com/advisories/GHSA-p6vx-979v-rg4c)
  (plugin-produced callable invocation during `fromJSON()`, fixed in 1.6.2) and
  high [GHSA-jp82-f5mq-hwhp](https://github.com/advisories/GHSA-jp82-f5mq-hwhp)
  (memory exhaustion during JSON deserialization, fixed in 1.6.3). The selected
  minimum uses the current patched 1.x release; `seroval-plugins` 1.5.6 permits
  it through its `^1.0` peer range. This override covers all Seroval consumers
  in the source dependency tree to avoid retaining a vulnerable nested copy.
- `@opentui/solid@0.5.14` overrides only its `@babel/core` dependency to
  `^7.29.7`, sharing the patched version already used by the root build. The
  upstream exact 7.28.0 pin is affected by low
  [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8), fixed
  in 7.29.6. Exploitation requires control of compiled source, access to the
  output, and knowledge of a target source-map path. Compile trusted sources only.

These ranges allow subsequent compatible fixes. Reassess the overrides when
upstream constraints change; do not remove them until a clean resolution passes
the full audit and compatibility checks. After `npm ci --ignore-scripts`, run:

```sh
npm run check:security-dependencies
npm audit
```

The compatibility check exercises Seroval with the existing web plugins, Solid's
server resource serialization and generated hydration data, and OpenTUI's own
TSX/Babel transformer. The normal jobs build uses the root Babel and would not
exercise these transitive paths by itself. This check supplements the normal
test/build and isolated host integration checks.

The jobs server and pump do not import Seroval; the vendored client's JavaScript
has no Seroval import. The installed bundle excludes `node_modules`, but its TUI
imports shared Solid/OpenTUI modules supplied by OpenCode. These source overrides
do not update an installed host or establish the safety of its dependency tree.
A clean `npm audit --omit=dev` cannot prove runtime safety. Audit results are a
snapshot of known advisories and must be checked again when dependencies change.
