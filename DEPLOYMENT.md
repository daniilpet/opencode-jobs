# Installation and operations

## 1. Prerequisites

Use the **same user account** for OpenCode and this scheduler. Confirm
`opencode --version` reports `2.0.22`, `node --version` is at least `20.19`, and
`opencode api get /api/info` reaches the intended local shared server. The plugin
does not connect to a remote server or install/replace OpenCode.

For operation with the terminal UI closed, the existing OpenCode server must
remain running. To survive reboot, it must already have its own startup service.
The installers supervise only the jobs pump. They do not configure server startup,
change provider credentials, or modify existing services. Machine power, network
access to your model provider, and suitable permissions are still required.

On Linux, confirm `systemctl --user` works and inspect
`loginctl show-user "$USER" -p Linger`. Without lingering, user services may stop
after logout. If needed, arrange lingering through your administrator; the
installer does not enable it. On Windows, use an elevated PowerShell **as the
OpenCode user**, not a different administrator account. S4U scheduled tasks may be
restricted by organizational policy; do not bypass that policy.

The preview installers support standard user directories only: leave
`OPENCODE_JOBS_STATE` and `XDG_DATA_HOME` unset during installation and service
operation. Environment overrides are for manually supervised/testing setups.
On Linux, the home directory and Node executable path must not contain spaces;
the generated service does not quote these paths. These are known installer
limitations, not conditions the installer automatically repairs.

## 2. Obtain a verified bundle

Download the versioned archive and `SHA256SUMS` from this repository's Releases.
On Linux, with both files in the current directory:

```sh
sha256sum -c SHA256SUMS
tar -xzf opencode-jobs-0.1.0.tar.gz
cd opencode-jobs-0.1.0
```

On Windows, compare `Get-FileHash .\opencode-jobs-0.1.0.tar.gz -Algorithm SHA256`
with the archive's line in `SHA256SUMS`, then:

```powershell
tar -xzf .\opencode-jobs-0.1.0.tar.gz
Set-Location .\opencode-jobs-0.1.0
```

The archive includes `.runtime/package` and `scripts/`. Do not relocate either
before installation. Source users instead run `npm ci --ignore-scripts`,
`npm test`, `npm run check`, and `npm run build` from the repository root.
Build-only engine warnings are described in [CONTRIBUTING.md](CONTRIBUTING.md).

## 3. Install and verify

Windows, from an elevated PowerShell in the extracted bundle or source checkout:

```powershell
.\scripts\install-windows.ps1
node .\scripts\verify-install.js
Get-ScheduledTask -TaskName 'OpenCode jobs'
```

The installer verifies the copied files, installs the plugin under
`~/.config/opencode/plugins/jobs`, and creates a new limited S4U scheduled task
named `OpenCode jobs`. It has startup and logon triggers, prevents overlapping
instances, and restarts after a process failure. No password is requested or saved.

Linux, as the ordinary OpenCode user:

```sh
sh scripts/install-linux.sh .runtime/package
node scripts/verify-install.js
systemctl --user status opencode-jobs.service
```

A new `~/.config/systemd/user/opencode-jobs.service` runs the pump. The existing
OpenCode service is not stopped. Plugin discovery uses OpenCode's normal watcher.

Both installers refuse to replace an existing plugin directory or jobs service.
If an install fails, inspect the reported error and current state before retrying.
A partially completed install can leave a plugin or service behind; do not treat
file presence as successful installation, and do not delete it without checking
for active jobs. `verify-install.js` creates a technical session and two jobs,
cancels both immediately, and writes `verification.json`; it does not call a model.

In a normal session, use `/jobs` to check scheduler health and try a harmless
`/background` command appropriate to your shell. OpenCode can use different shells
on Windows and Linux; the plugin preserves the command you supply.

## 4. State and updates

Job state is stored through OpenCode's plugin storage in its existing database.
The pump's anchor directory, `pump-status.json`, and verification report live in
`${XDG_DATA_HOME:-~/.local/share}/opencode-jobs`. `OPENCODE_JOBS_STATE` can override
that auxiliary directory; `OPENCODE_JOBS_SERVICE_FILE` can select a service
registration file in a manually supervised setup. Overrides are not supported by
the preview installers; keep the environment consistent for the server and pump.

Do not sync job state or credentials between machines. Do not edit generated
installed copies independently of this repository. Automatic in-place upgrades
are not provided in this preview. Before a manual update, review active jobs,
back up the existing files, stop the pump, and validate the new version in isolation.
An OpenCode upgrade requires another compatibility check before normal operation.

## 5. Stop without erasing data

Windows:

```powershell
Stop-ScheduledTask -TaskName 'OpenCode jobs'
Disable-ScheduledTask -TaskName 'OpenCode jobs'
```

Linux:

```sh
systemctl --user disable --now opencode-jobs.service
```

Stopping the pump does not cancel existing native shell processes. Cancel those
jobs deliberately through `/cancel` before stopping if that is what you need.
Future prompts will not be dispatched while the pump is stopped; missed deadlines
will be reported when it resumes. Stopping does not delete saved state.
For complete plugin removal, first review active jobs and move its directory out
of the discovery directory. Database deletion is not an uninstall procedure.
