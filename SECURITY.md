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
  GitHub/GitLab APIs you connect, author avatars from GitHub (can be turned off in Settings) and a
  daily update check to api.github.com that sends nothing but the app version (can be turned off in
  Settings › About).
- AI is off until you set it up in Settings › AI. Requests then go only to the provider you chose
  (Anthropic, OpenAI, Google Gemini, an OpenAI-compatible server, Ollama, or a local AI command-line
  tool: Claude Code, Codex or opencode, via that tool's own sign-in). "What is sent?" shows the exact
  text of a request without sending it. Forkyard asks before the first send of each function and of
  each repository's content to a remote provider, for large or costly requests, and when your
  monthly limit is reached. Files that look like secrets (`.env*`, private keys, certificates) are
  never sent, and known secret patterns in the remaining content are redacted on a best-effort
  basis. Review with "What is sent?" and add your own exclusions in Settings › AI.
