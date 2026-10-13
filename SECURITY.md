# Security policy

Forkyard runs Git on your machine and handles credentials, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/abgebaumt/forkyard/security/advisories/new).

Include what you found, how to reproduce it and which version you used. You will get an answer
within a few days. Once a fix is released, the advisory is published and you are credited if you want.

## Supported versions

Only the latest release receives security fixes.

## What Forkyard does to protect you

- Tokens, passwords and SSH passphrases are stored only in the operating system's keychain.
- Repositories whose configuration or hooks would run programs stay locked until you trust them.
- Everything written to logs, errors or events is scrubbed of secrets.
- No telemetry, no accounts, no server. Network access happens only for Git remotes, the
  GitHub/GitLab APIs you connect and author avatars from GitHub (can be turned off in Settings).
