# Security policy

## Supported scope

The 0.5.1 preview runs on OpenCode 2.x (2.0.22 or newer); versions 2.0.22, 2.0.24,
and 2.0.26 are verified on Windows and Linux, and 2.1.0 is verified on macOS.
Compatibility and security of newer hosts or unsupported platforms are not
claimed. Patches will be handled on a best-effort basis; there is no response SLA.

The hardening described below is included starting with preview 0.2.0;
it is absent from v0.1.0. Source dependency overrides and runtime changes do not
automatically update existing plugin or OpenCode installations.

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
  Redirect responses are handled manually and rejected without following
  `Location`; their unread bodies are cancelled. This preserves response-body
  cancellation on the tested Node runtimes despite
  [Undici #4627](https://github.com/nodejs/undici/issues/4627).
  An explicit timer retains the abort controller through response consumption and
  is released in `finally`. Error-body cancellation preserves only the HTTP status,
  including when the underlying stream rejects with a caller's private reason.

## Dependency security and compatibility

The source toolchain pins OpenCode/plugin SDK 2.0.32 and OpenTUI 0.5.17 with
Solid/preset 1.9.12. Targeted `package.json` overrides address advisories that
cannot be fixed by refreshing the lockfile within the upstream ranges. Each
override exists to remediate a specific published vulnerability in a transitive
dependency; it is not a ceiling "just in case", and it is revisited when new
advisories appear.

- `seroval: ^1.8.0` (was ^1.6.8) — fixes the remaining moderate advisory on
  seroval itself; `check-security-dependencies.js` covers JSON round-trips,
  Solid resource serialization with hydration, web plugins and the OpenTUI
  TSX/Babel transformer on Node 20/22.
- npm CLI tooling inside `@opencode/util`: `@npmcli/arborist@10.0.4`,
  `@npmcli/config@11.2.0`, `@npmcli/map-workspaces@6.0.0`,
  `@npmcli/metavuln-calculator@10.0.0`, `@npmcli/package-json@8.0.0`,
  `@npmcli/run-script@11.0.0`, `pacote@22.0.1`, `cacache@21.0.1`,
  `minimatch@11.0.5`, `npm-registry-fetch@20.0.1`, `glob@14.0.4` — upgrades
  the bundled npm toolchain to patched versions, clearing the moderate
  advisories in that chain without changing `@opencode/plugin` or OpenTUI.
- `sigstore@5.0.1`, `@sigstore/sign@5.1.0`, `@sigstore/tuf@5.0.1`,
  `@tufjs/models@5.0.2` — patched sigstore/TUF family used by the same
  toolchain.

The verified result is `npm audit --json: total 0` against registry.npmjs.org
on Windows and Linux, with the full backend/OpenTUI suite, build and isolated
integration green. These are dev-only dependencies: the shipped runtime bundle
does not install them, so their advisories do not affect end users of the
plugin.

## Continuous security checks

The `Checks` workflow queries current npm registry advisories for the committed
lockfile on pull requests, pushes to `main`, manual dispatch, and daily at 05:37 UTC.
Scheduled runs use the default branch and can be delayed by GitHub. They run the
security checks without repeating the build/integration matrix.

`npm run audit:dependencies` includes development, optional, and peer dependencies,
uses the lockfile without installing packages, and fails on every advisory severity,
including informational findings. Scanner or registry errors also fail the job.
The build matrix depends on that job succeeding. `npm-audit.json` is retained as
the `npm-audit` workflow artifact for 30 days, including failed audits that produced
a report. Runner loss or a hard job timeout can prevent report collection. A missing
report fails artifact collection. Dependencies are never
automatically changed by this check.

The npm audit request sends package names and versions to the configured registry;
it does not send the source code. This check covers the project's locked dependency
tree, including build tools. It does not inventory an installed OpenCode host or
discover new vulnerabilities in the plugin's own code. A passing audit reflects
the registry's known advisories at the time of that run.

CodeQL independently analyzes JavaScript/TypeScript and GitHub Actions workflows
with the `security-extended` query suite on the same events. These jobs do not build
or install the project. Results are uploaded to GitHub's **Security / Code scanning**;
the analysis waits for report processing. Only these jobs receive
`security-events: write`; audit and build jobs retain read-only repository access.
The workflow uses `pull_request`, not privileged `pull_request_target` execution.

A successful CodeQL analysis means the scanner and upload completed; it does not
mean there are no alerts. Review the separate Code scanning results and triage
findings before merging. Extended queries may produce false positives. Actions
are pinned to immutable commits; maintainers must review updates to those pins so
the scanners and query suites do not become stale.

Failing the audit blocks this workflow's build jobs. Enforcing merge restrictions
also requires branch rules or required status checks configured by a repository
administrator; this workflow does not create those rules. Daily scans begin only
after the workflow is present on the default branch.
