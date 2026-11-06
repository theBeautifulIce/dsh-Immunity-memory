# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

This is an early-stage project; security fixes land on the latest release line.

## Reporting a vulnerability

Please **do not** open a public issue for a vulnerability, leaked token, or
exposed memory database.

Use GitHub's **private vulnerability reporting**:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version, a minimal reproduction, and the impact.

If private reporting is unavailable, contact the maintainer through the
GitHub profile [`theBeautifulIce`](https://github.com/theBeautifulIce) and ask
for a private channel. Do not attach a real memory database or a live token.

You can expect an initial acknowledgement within a few days. Please allow time
for a fix and coordinated disclosure before publishing details.

## Scope

In scope:

- the Node control layer, HTTP API, and client UI;
- the Go memory service and its local HTTP API;
- the Rust native core and its JSON-lines protocol;
- SQLite migrations, backup/restore, export/import;
- prompt-injection boundaries and memory content handling;
- dependency and build-script issues.

Out of scope:

- vulnerabilities in DSH itself (report them to the DSH project);
- a compromised local machine or a user who intentionally shares their
  database;
- denial of service caused by an attacker who already controls the host
  process;
- secrets pasted into a public issue.

## Sensitive data

The memory database, backups, audit history, and injected prompts may contain
personal or project-confidential information. When reporting a bug:

- redact titles, content, tags, paths, tokens, and IDs;
- reproduce with a fresh temporary store whenever possible;
- never upload `memory.sqlite3`, `store.json`, or `backups/` to an issue.

## Token hygiene

This project never needs a GitHub token at runtime. A token is only used by a
maintainer to push or publish. If a token is exposed, revoke it immediately in
GitHub Settings → Developer settings → Personal access tokens, then audit the
repository and release assets for unintended changes.
