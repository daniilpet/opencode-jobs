# Contributing

Bug reproductions, tests, documentation, and small compatibility improvements are
welcome. This is an early preview maintained on a best-effort basis. There is no
promised response time or commercial support agreement.

## Development setup

Use Node.js 20.19+ and npm, then:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run check:security-dependencies
npm run build
git config core.hooksPath .githooks
```

`npm run check` checks JavaScript syntax, not static typing or a comprehensive
lint rule set. Pre-commit runs tests, syntax checks, dependency compatibility
checks, and staged whitespace checks.
Do not bypass failing checks or add broad dependency overrides.
The targeted Seroval/Babel overrides and their compatibility checks are explained
in [SECURITY.md](SECURITY.md#dependency-security-and-compatibility).

OpenCode/plugin SDK 2.0.22 and OpenTUI 0.5.14 are pinned to the tested host API.
Solid and its Babel preset are pinned to 1.9.12 to match OpenTUI's peer requirements.
Node's 20.19 minimum supports the ES modules, workers, and AbortSignal APIs in use.
The bundled TUI executes in OpenCode's Bun runtime. Build dependencies may emit
engine warnings on the tested Node versions; this does not mean the pump imports
OpenTUI or undici. Changes to these pins need new compatibility checks.

## Integration checks

With an installed OpenCode 2.0.22, run `node scripts/smoke.js` after the build.
Set `OPENCODE_JOBS_CLI` to the **actual executable** if it is installed elsewhere;
on Windows this must be the native `.exe`, not an npm `.cmd` shim. Linux needs
Python 3 for the terminal-indicator check.

Smoke uses its own configuration, database, service registration, and loopback
mock model. It does not submit to a paid model or restart a working OpenCode server.
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
- Keep unpublished changes under `Unreleased`; do not describe source-only
  hardening as shipped in v0.1.0 or applied to existing installations.
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
