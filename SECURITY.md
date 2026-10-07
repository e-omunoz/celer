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
