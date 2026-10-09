# Contributing

Bug reproductions, tests, documentation, and small compatibility improvements are
welcome. This is an early preview maintained on a best-effort basis. There is no
promised response time or commercial support agreement.

## Development setup

Use Node.js 20.19+, npm, and Bun 1.3.14 for the checked terminal-rendering baseline, then:

```sh
npm ci --ignore-scripts
npm run audit:dependencies
npm test
npm run test:tui
npm run check
npm run check:security-dependencies
npm run check:bridge-lifetime
npm run build
git config core.hooksPath .githooks
```

`npm run check` checks JavaScript syntax, not static typing or a comprehensive
lint rule set. Pre-commit runs tests, syntax checks, dependency compatibility
checks, optimized transport lifetime regressions, terminal-rendering tests, and staged whitespace checks.
Do not bypass failing checks or add broad dependency overrides.
`npm test` enables `--expose-gc`: transport timeout regressions force garbage
collection while reading an unfinished response. Include that flag when running
`test/bridge.test.js` directly; its deadlines must survive collection on Node 20/22.
`npm run check:bridge-lifetime` repeats the timeout and cancellation regressions
with forced optimization, which reproduced premature timeout collection on Node 20.
The targeted Seroval/Babel overrides and their compatibility checks are explained
in [SECURITY.md](SECURITY.md#dependency-security-and-compatibility).

`npm run audit:dependencies` queries current registry advisories for the complete
lockfile, including build dependencies, without installing or fixing packages.
CI runs it before the build matrix and preserves the JSON report even on failure.
It also runs daily together with CodeQL analysis of JavaScript and Actions.
Review Code scanning alerts as well as workflow status. See
[continuous security checks](SECURITY.md#continuous-security-checks) for failure
policy, report retention, data sent to the registry, and merge-protection limits.

OpenCode/plugin SDK 2.0.24 and OpenTUI 0.5.14 are pinned to the tested host API.
The runtime accepts OpenCode hosts 2.x (2.0.22 or newer) by contract stability;
verified releases are listed in the changelog.
Solid and its Babel preset are pinned to 1.9.12 to match OpenTUI's peer requirements.
Node's 20.19 minimum supports the ES modules, workers, and AbortSignal APIs in use.
The bundled TUI executes in OpenCode's Bun runtime. Build dependencies may emit
engine warnings on the tested Node versions; this does not mean the pump imports
OpenTUI or undici. Changes to these pins need new compatibility checks.

## Integration checks

With an installed OpenCode 2.x host, run `node scripts/smoke.js` after the build.
Set `OPENCODE_JOBS_CLI` to the **actual executable** if it is installed elsewhere;
on Windows this must be the native `.exe`, not an npm `.cmd` shim. Linux needs
Python 3 for the real terminal task-management check. `npm run test:tui` runs
OpenTUI rendering and interaction tests on Windows and Linux under Bun. These
component checks do not replace the Linux PTY check in the actual OpenCode host.

Smoke uses its own configuration, database, service registration, and loopback
mock model. It does not submit to a paid model or restart a working OpenCode server.
Before copying the build or starting a server, it atomically creates a new root.
By default, each run gets a unique `jobs-smoke-` directory under `%TEMP%/opencode`
on Windows or `~/.local/share` on Linux. `OPENCODE_JOBS_TEST_ROOT` selects an exact
path that must not exist, including as an empty directory, file, or symbolic link.
Missing parent directories are created automatically; concurrent runs with the same
explicit path allow only one owner. Existing roots are never reused or removed.
Use a parent directory controlled by your account. New roots restrict group/other
access on POSIX; Windows access depends on inherited filesystem permissions.
This does not isolate processes running under the same user account.
It tests native shell/monitor, cancellation, permissions, schedules, loops,
restart recovery, missed deadlines, and actual model-request guidance with full,
shell-denied, and no-tools roles. The isolated mock verifies prompt delivery and
permission-filtered recommendations; it does not evaluate real-model tool choice.
Security scenarios also exercise approval expiry and cancellation before launch,
bounded native shell termination without the pump, safe status output, dedicated
worker result delivery, nested-job rejection, and worker interruption without the
pump. Run the smoke check against a fresh build after runtime changes; a prior
successful run does not verify later fixes.
Inspect failed artifacts locally before
sharing sanitized excerpts. Keep credentials out of the test environment.

`npm run package` creates the release bundle and checksum file after a successful
build. It refuses to overwrite an existing version's bundle; inspect it before
discarding or replacing anything. CI builds on Windows/Linux with Node 20.19 and
22.14, and runs isolated OpenCode integration on the 22.14 jobs.

## Pull requests

- Discuss larger changes in an issue first. Keep PRs focused on one problem.
- For a bug, add a failing regression test before the fix. Preserve cancellation,
  stable admission IDs, and the no-shell-replay invariant.
- Update documentation whenever observable behaviour changes.
- Keep unpublished changes under `Unreleased`; do not describe source-only changes
  as included in published bundles or applied to existing installations.
- Use Conventional Commit subjects. Existing comments and tests are Russian;
  do not reformat or translate unrelated files in a functional PR.
- Disclose substantial AI-assisted work and say how you verified it. Review all
  generated code yourself. AI attribution is not a substitute for verification.
- Never commit credentials, job state, databases, session exports, or logs.

## Issues and security

Use the bug/feature templates. Include the version, OS, expected and actual
behaviour, and a minimal reproduction with dummy data. Security vulnerabilities
must follow [SECURITY.md](SECURITY.md), not the public issue tracker.
Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
