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
- **Reports to GitHub.** «Reportar / Sugerir» sends nothing on its own. «Abrir en GitHub» opens a prefilled
  `issues/new` page in your browser. «Enviar a GitHub», offered only after you save your own GitHub token (a classic
  token with `public_repo`, kept in the operating system's credential store under its own entry and never shown again
  or written to a file or log), makes one `POST https://api.github.com/repos/e-omunoz/celer/issues` with the text of
  the preview. «Quitar el token» deletes it from the credential store.
- **Processes it starts.** The installer above; Java (`java -version`, and the JDBC bridge for Informix connections over
  JDBC), started directly with fixed arguments and without a console window; the browser or file manager when you ask
  for it. Celer Setup starts Celer when it finishes. No other program's process is stopped or modified: Celer Setup
  only *reads* the list of processes to wait until Celer has closed.
- **WSL (Windows only).** Celer looks for Claude Code in your WSL distributions so the MCP settings and the status
  bar can say whether Celer is registered there: when you open *Ajustes › IA y MCP*, and in the background while MCP
  is turned on. It runs `%SystemRoot%\System32\wsl.exe` directly, without a console window: `wsl.exe -l -q`,
  `-l -q --running` and `-l -v` to list the distributions, then, in each one that is *already running*, a login shell
  (`sh -lc`, so your profile is read) with a fixed script that prints `$HOME`, whether Windows interop is on, where
  `claude` is and `/etc/wsl.conf`, and reads `~/.claude.json` (through `\\wsl.localhost`, or with
  `sh -c 'cat "$HOME/.claude.json"'` when that is not reachable). In the background the reading is kept for 2 minutes
  and repeated while a Celer window is visible (the status bar asks every 15 s), so it runs about every 2 minutes. A
  stopped distribution is started only when you press *Comprobar* on it. *Registrar en WSL* runs, inside that
  distribution and only after you confirm the command shown, `claude mcp remove --scope user celer` and
  `claude mcp add --scope user celer -- <celer.exe as the distribution sees it> --mcp --client=wsl:<distribution>`.
  With MCP off and the settings closed, or on macOS and Linux, Celer does not run `wsl.exe`.
- **Local channel for MCP.** While Celer is open it listens on a port of `127.0.0.1` chosen by the system (never on
  the network) and writes that port, its process id and a random token to `mcp-app.json` in its data folder; the file
  is removed when Celer closes. Only `celer --mcp` (the process an AI assistant starts) uses it, for the tools that act
  in the app: it sends the token with each request, after checking the MCP permissions (*Controlar la aplicación*,
  connection levels, masking) and writing the audit log.
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
  folders. The MCP settings and the status bar read Claude Desktop's configuration file and Claude Code's
  `~/.claude.json` (on Windows, and in each running WSL distribution while MCP is on, see above) to show whether Celer
  is in them; *Configurar* adds Celer to Claude Desktop's file (keeping a backup), and `~/.claude.json` is only
  changed by Claude Code's own `claude mcp add` when you press *Registrar*. Nothing is ever written to DBeaver or
  DbVisualizer.
- **SSH.** For a connection through an SSH tunnel, Celer checks the server's key against its own `known_hosts` in its
  data folder (written only when you press *Confiar en esta clave*) and your `~/.ssh/known_hosts` (only read, never
  written). It reads the private key file you choose, and with *Agente SSH* it asks your SSH agent to sign: on Windows
  the OpenSSH agent (`\\.\pipe\openssh-ssh-agent`) and then Pageant, elsewhere the agent in `SSH_AUTH_SOCK`.
- **Credentials.** Your passwords and API keys go to the operating system's credential store (Windows Credential
  Manager, macOS Keychain, Secret Service), under the service `Celer`. Celer does not read other programs' entries.
  A copy started with its own data folder (`--data-dir <folder>` or `CELER_DATA_DIR`) writes under the service
  `Celer-dev` instead, and reads an entry of the installed copy (`Celer`) only when it has none of its own, so it never
  changes the installed copy's passwords.
- **Files.** Its own data folders (`%APPDATA%\es.celer.app`, `%LOCALAPPDATA%\es.celer.app`; with `--data-dir`, that
  folder instead, with the WebView2 profile in `<folder>\webview`), and the files you open,
  save or export. For Informix over DRDA it writes a `db2dsdriver.cfg` there (database, host and port of those
  connections, no passwords) that turns off the IBM driver's own reconnection, unless you have your own.
