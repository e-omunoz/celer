# Security policy

Celer stores database credentials and can run SQL against production systems, so we take security reports seriously.

## Supported versions

Security fixes go into the latest release. Celer updates itself, so please update before you report.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub Security Advisories](https://github.com/e-omunoz/celer/security/advisories/new).

Include:

- the Celer version and Windows version;
- what an attacker can do, and what they need to do it (for example a crafted `.sql` file, a malicious server, or
  an MCP client);
- steps to reproduce or a proof of concept.

We will acknowledge the report within a few days, keep you informed, and credit you in the release notes if you wish.

## Scope

These are especially relevant:

- Credentials or API keys leaving the OS credential store, being written to disk, or appearing in logs.
- Bypassing a read-only or production connection.
- Bypassing MCP permission levels, row limits, column masking or the audit log.
- Row data reaching the AI assistant without permission.
- Code execution from opening a `.sql` file, a crafted server response or a tampered update.

## Verifying a download

Every release publishes `SHA256SUMS.txt` with the SHA-256 of each file. The packages are not code-signed yet.

```powershell
Get-FileHash .\Celer-Setup-Windows.exe -Algorithm SHA256   # Windows: compare with the line in SHA256SUMS.txt
```

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing               # Linux (macOS: shasum -a 256 -c …)
```

Every file is built from the tagged commit by GitHub Actions (`.github/workflows/release-desktop.yml`); nothing is built
on a developer's machine.

## What Celer does on your computer

Celer is a database client, so it is useful to know exactly what it touches. Nothing below needs administrator rights.

- **Updates.** Celer asks the GitHub API whether there is a newer release (at start-up and every few hours; it can be
  turned off). It downloads nothing until you press *Actualizar*. Then, and only in a copy installed by Celer Setup, it
  downloads `Celer-Setup-Windows.exe` from this repository's releases into `%LOCALAPPDATA%\es.celer.app\updates`,
  checks it against the release's `SHA256SUMS.txt` (no sums, no update), checks it again right before running it, and
  runs it directly with `--update`: no command interpreter or script in between. Portable copies, macOS and Linux only
  open the release page.
- **Processes it starts.** The installer above; Java (`java -version`, and the JDBC bridge for Informix connections over
  JDBC), started directly with fixed arguments and without a console window; the browser or file manager when you ask
  for it. Celer Setup starts Celer when it finishes. No hidden chains of processes, and no other program's process is
  stopped or modified: Celer Setup only *reads* the list of processes to wait until Celer has closed.
- **Installer and uninstaller.** Celer Setup installs per user into `%LOCALAPPDATA%\Programs\Celer` (it refuses system
  and *Program Files* folders), and writes only under `HKEY_CURRENT_USER`: its entry in *Settings › Apps*
  (`…\CurrentVersion\Uninstall\Celer`) and, if you ask for it, the `.sql` file association under `Software\Classes`.
  No `Run` or `RunOnce` keys, services or scheduled tasks. Uninstalling removes all of that; the running `uninstall.exe`
  stays in its folder (Windows does not let a program delete itself) and the next installation removes it.
- **Registry reads.** Celer reads the proxy of the Windows Internet settings (`HKCU\…\Internet Settings`) for driver
  downloads; Celer Setup reads whether WebView2 is installed.
- **Other programs' files.** Only on request: *Importar conexiones* reads DBeaver's `data-sources*.json` and
  DbVisualizer's `dbvis.xml`; DBeaver's encrypted `credentials-config.json` is read only if you tick *Importar también
  las contraseñas guardadas* and press *Importar*. Celer looks for Java and the Informix JDBC driver in DBeaver's
  folders. The MCP settings read Claude Desktop's configuration file to show whether Celer is in it, and *Configurar*
  adds Celer to it (keeping a backup). Nothing is ever written to DBeaver or DbVisualizer.
- **Credentials.** Your passwords and API keys go to the operating system's credential store (Windows Credential
  Manager, macOS Keychain, Secret Service), under the service `Celer`. Celer does not read other programs' entries.
- **Files.** Its own data folders (`%APPDATA%\es.celer.app`, `%LOCALAPPDATA%\es.celer.app`), and the files you open,
  save or export. For Informix over DRDA it writes a `db2dsdriver.cfg` there (database, host and port of those
  connections, no passwords) that turns off the IBM driver's own reconnection, unless you have your own.
