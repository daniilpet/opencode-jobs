# OpenCode jobs

[![Checks](https://github.com/daniilpet/opencode-jobs/actions/workflows/checks.yml/badge.svg)](https://github.com/daniilpet/opencode-jobs/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Persistent, machine-local background jobs for **OpenCode V2** on Windows and Linux.
Run shell commands in the background, watch their output, schedule prompts, and
receive results in the session that created the job. No OpenCode fork is required.

**Early preview. Tested against OpenCode 2.0.22 only.** The scheduler keeps working
with the terminal UI closed, provided the machine, shared OpenCode server, and
local scheduler process are running. It does not automatically replay interrupted
shell commands or silently execute missed prompts late.

**Version scope:** this checkout describes **0.2.0 preview**, including finite job
limits and dedicated scheduled-work sessions. These changes are absent from the
v0.1.0 bundle. Existing installations require a separately reviewed manual update;
installers refuse to overwrite them.

## What you can do

```text
/background npm test
/monitor --regex "ERROR|FAILED" --before 3 --after 3 --debounce 5 -- npm run build
/schedule in 10m check the build result
/schedule at 2026-10-06T15:00:00+03:00 check the result
/loop 5m check whether the deployment is healthy
/jobs
/cancel job_<id>
```

The model can also call the six `opencode_jobs_*` tools. A small terminal indicator
shows the scheduler's status. Each machine has its own jobs; no shared coordinator
or extra HTTP server is installed.

**Unreleased interface:** click the bottom jobs indicator or use `/joblist` to open
the current session's task manager. Inspect active jobs and history, read captured
command output, open a worker session, or stop a selected job directly without a
model request. This interface is not included in the published v0.2.0 bundle.
See [task management](docs/operation.md#12-terminal-task-management-unreleased).

The plugin adds [tool-selection guidance](docs/operation.md#11-model-tool-selection)
to the model's working system context: prefer background jobs for long commands,
monitor meaningful output events, and schedule only requested future work. Guidance
includes only jobs tools available in that request and preserves existing instructions
and permissions. It is advice, not a guarantee of model behaviour or scheduler health.

Scheduled prompts and notifications can wake your configured model and incur
provider costs. Review permissions and intervals before leaving recurring jobs
unattended. Never place secrets in command arguments or prompts.

## Install

Requirements: OpenCode **2.0.22**, Node.js **20.19 or newer**, and an existing
shared OpenCode server configured to remain available without the terminal UI.
Windows installation requires an elevated PowerShell under the same account as
OpenCode. Linux installation requires a user systemd service manager; unattended
operation also requires user lingering and an independently supervised OpenCode
server. The preview installers support standard state directories; Linux paths
must not contain spaces. macOS is not supported by the installers.

Download the `.tar.gz` bundle and `SHA256SUMS` from
[Releases](https://github.com/daniilpet/opencode-jobs/releases), verify the checksum,
and extract it. The bundle contains the built plugin and installers; users do not
need build dependencies. Follow the [installation guide](DEPLOYMENT.md), including
the post-install check. Installers refuse to overwrite an existing installation.

For a source checkout:

```sh
git clone https://github.com/daniilpet/opencode-jobs.git
cd opencode-jobs
npm ci --ignore-scripts
npm run audit:dependencies
npm test
npm run check
npm run check:security-dependencies
npm run build
```

Then run `scripts/install-windows.ps1` or
`sh scripts/install-linux.sh .runtime/package` as described in the guide.
Do not add an unbuilt source checkout directly with `opencode plugin add`:
generated entrypoints and the supervised scheduler are required.
This project is not published to npm.

## Guarantees and limits

- Future deadlines survive a server restart; missed deadlines produce an explicit
  failure notification instead of a late execution of the original prompt.
- Delivery uses the session inbox and a stable admission ID. This is not an
  exactly-once guarantee for arbitrary model actions or shell side effects.
- Background commands delegate to OpenCode's native shell executor and its
  permission checks. Cancelling a job cannot undo side effects already performed.
- Shell work has finite execution and approval-wait limits. Scheduled model work
  uses a dedicated snapshot session with a durable deadline; loops also limit
  admissions. Results wake the original conversation outside the worker budget.
- Loops coalesce ticks while a previous iteration is queued or executing. Nested
  jobs, subagents, and native background shell are disabled in worker sessions.
  This is not a real-time scheduler or an operating-system sandbox. Third-party
  tools that ignore cancellation are outside the execution-limit guarantee.
- Legacy unbounded active jobs and old scheduled-prompt deliveries can block
  loading. Review the [manual update requirements](DEPLOYMENT.md#4-state-and-updates)
  before replacing an existing installation.
- Output redaction is best effort. Command output remains untrusted data.
- Reboot/logout behaviour and visual rendering of the Windows indicator have not
  been validated. Linux indicator rendering and isolated server restart recovery
  have been tested. Runtime messages and source comments are currently Russian;
  command syntax and public documentation are English.

## Documentation and participation

- [Install, verify, stop](DEPLOYMENT.md)
- [Commands, recovery, limits, and troubleshooting](docs/operation.md)
- [Architecture decision](docs/adr/0001-node-local-automation.md)
- [Finite execution and dedicated sessions](docs/adr/0002-finite-job-execution.md)
- [Contributing](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md),
  [security reports](SECURITY.md), [changelog](CHANGELOG.md)
- [Issues](https://github.com/daniilpet/opencode-jobs/issues) for bugs and feature requests

The repository is the canonical source. Installed bundles are generated copies.
MIT licensed; dependencies retain their own notices in
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). The workflow was inspired by
[opencode-monitor-plugin](https://github.com/Shodocan/opencode-monitor-plugin);
that package is not a dependency. This is an independent community plugin, not an
official OpenCode product.
