# Changelog

All notable changes to Forkyard are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Clean up repository: a dialog – from the command palette (“Clean up repository …”) and the context
  menus of a repository in the list and of its tab – shows what takes space (Git objects, loose objects
  and packs, the Git LFS cache, Forkyard’s undo backups, orphaned worktrees, reflog entries older than 90
  days, free disk space) and frees it with `git gc` (Normal) or `git gc --aggressive --prune=now`
  (Thorough), optionally also the LFS cache, orphaned worktrees, undo backups older than N days and the
  reflog beyond 90 days. It says what each option frees and warns where something cannot be brought
  back. The run counts its steps and seconds, can be cancelled, goes on when the dialog is closed, waits
  for fetches and other actions in the repository and all its worktrees, never touches lock files of
  other programs and keeps the objects of open undo steps. The result reads like “Git objects: 1.2 GB →
  340 MB”.
- Terminal tabs: the built-in terminal can hold several sessions per repository tab. “New shell” opens
  another one; each tab shows its name and its state as a word with a coloured dot, the arrow keys move
  between tabs, and closing a running session asks first.
- Commit search: `code:text` finds commits that add or remove the text, `path:src/app` limits the search
  to a file or folder, and `since:2026-01-01` / `until:2026-06-30` to a time window (also with a time and
  time zone, e.g. `since:2026-01-31T18:00:00Z`).
- Groundwork for 1.2 without visible AI: a runner for programs other than Git (time limit, cancel ends
  the whole process tree, output limits, nothing of stdin or stdout in the log, batch files only with safe
  arguments), cancellable HTTP calls with their own time limit, undo entries that move several refs and
  restore a snapshot together, taking over lines from a range of commits (`rangeApply`), terminals that
  run a program in a worktree and report bells, titles and notifications, locating coding-agent CLIs, the
  history of a single line (`lineHistory`), and a check that every error code exists in Rust, TypeScript
  and both languages.
- AI foundation, off until you turn it on: Settings › AI connects one provider for every profile –
  Anthropic, OpenAI, Google Gemini, an OpenAI-compatible service with its own address, or Ollama /
  LM Studio on this computer. Keys live only in the operating system's keychain (Forkyard shows at most
  the last four characters); “Check” lists the models and stores the key only after the provider
  accepted it. Every function can be switched off on its own, and every repository (“AI off for this
  repository”).
- “What is sent?” shows the exact text without sending anything. Secrets, `.env` files, keys and
  patterns from `.forkyard/ai-ignore` (gitignore syntax) or the global list are never sent; lock files
  and binaries only by name and size; keys inside the text are redacted. Forkyard asks before the first
  use of a function, before a provider gets content of a repository for the first time, above 100,000
  characters and above a cost threshold (default 0.10 USD).
- AI costs: an estimate for providers with a known price (dated price list, own price per model), an
  optional monthly limit and this month's usage – counted locally, numbers only, never contents.
- Until AI is set up, the start page shows one muted entry “Set up AI features” and the command palette
  “Set up AI …”; turned off on purpose, nothing of it appears. After the update a one-time notice
  introduces the new features.
- AI through the command-line tools you already use: Claude Code, Codex and opencode, each with its own
  sign-in – Forkyard stores nothing of it. They run in an empty temporary folder, never in the
  repository, get the prompt on stdin and run without tools, MCP servers, project settings or stored
  sessions (Codex in its read-only sandbox, opencode with every permission denied); a version without
  these safety switches is refused instead of being used less safely. Their paths are found
  automatically or set in Settings › AI; costs a tool reports are counted, the monthly limit does not
  apply to them.
- Set up AI: a dialog finds the command-line tools (version, path, sign-in), Ollama and LM Studio on
  this computer and stored keys within about two seconds, without sending anything. With exactly one
  signed-in tool, “Turn on with Claude Code” is one click; otherwise provider, model and functions
  step by step. If nothing is found it offers an API key, a local model or only the coding-agent
  cockpit. A signed-out tool can be signed in in the built-in terminal. It opens from Settings › AI
  (“Set up …”) and when AI is switched on without a provider.
- Commit message from the staged changes: “Write” in the summary field (also Ctrl+Shift+M and the
  command palette) asks the AI provider for a summary of at most 72 characters and a body, styled like
  the last 30 commits and in the language the repository's commits use; the commit template and an own
  instruction per repository (Project › AI and agents) go along. Empty fields get the draft, your own
  text is never replaced unasked (Replace / Append / Discard), Ctrl+Z takes an inserted draft back, and
  “What is sent?” shows the exact text first. Nothing is committed without you.
- Pull request description from the commits: “Write from commits” in “Create pull request” writes
  title and description from the branch's commits, the changed files (statistics only, no contents),
  ticket references and the repository's template – every heading of the template stays. Issues the
  commits mention on GitHub, GitLab and Gitea/Forgejo become “Closes #n”; the AI cannot add any
  others. A description you wrote is never replaced unasked, the title only while it is still the
  automatic suggestion, and Ctrl+Z takes an insertion back. “What is sent?” shows the exact text first.
- Conflicts with intent: the conflict tool has a new column “Intent” to the right of the sides and the
  result (collapsible, width remembered). On “Explain intent” it shows for every conflict what each side
  wanted – from the block texts, the commit messages of both sides and, with a connected host account,
  the pull request texts of both branches – and proposes a text that keeps both. The proposal appears as a
  small diff against the block's current text; “Apply” replaces only that block in the result (undo it there
  like typing), “Discard” leaves it; saving stays with you. Blocks too large for one request or containing
  masked values are explained only. Needs AI to be on; nothing is sent before the click, “What is sent?”
  shows the exact text, and files with secrets, excluded files and lock files are never sent.
- Key check before every push: Forkyard looks at the lines the outgoing commits add – locally, without
  AI – and stops a push when one looks like a key, token, password or private key. The dialog names
  file and line and shows only the last four characters; “Back” pushes nothing, “Push anyway” pushes,
  “Don't report again” remembers only a hash of file and line. Applies to Push, “Push …” with more
  branches and tags, tag push, commit and push, the push of a pull request branch and the push at the
  end of a Gitflow finish. Settings › Project › Git can report every finding again.
- Review before a push (AI, optional): “Review and push …” in the Push menu and the command palette asks
  the AI provider about debug output, commented-out code and likely mistakes in what the push sends.
  Hints only; “Push anyway” is always possible, cancelling never pushes. Settings › Project › AI and
  agents can run the review before every push (off by default).
- Release notes: “Write release notes” in the tag dialog – and “Write release notes …” on a commit or
  tag – groups the commits since the last tag into Added, Changed, Fixed and Other, in the language of
  the repository (an existing changelog keeps its headings). The text can go into the tag message, into
  CHANGELOG.md (Keep a Changelog is recognised; inserted as a normal change you commit yourself), into a
  release on GitHub, GitLab or Gitea/Forgejo (the tag is pushed first; confirmed separately because it
  cannot be undone) and to the clipboard. “What is sent?” shows the exact text; hidden while AI is off.
- Bisect autopilot: describe a bug (and, if you know one, a test command), and the AI writes a test
  script for the range – shown and editable, nothing runs before “Run”. The script then runs commit by
  commit in a temporary worktree next to the repository (`<repo>.agents/bisect-<n>`), so your own
  working directory may have changes and a manual bisect stays as it is. Each step has a time limit
  (default 10 minutes; a step over it counts as skipped), a bar above the graph shows the progress and
  then the first bad commit, and the worktree can be kept for a closer look or is removed. Start it from
  the bisect bar, a commit’s context menu or the command palette; “What is sent?” shows the exact request.

### Changed

- Undoing a rebase that moved dependent branches along now happens all or nothing: if a branch is locked
  or the working directory has changes, nothing moves.

## [1.1.0] – 2026-10-16

### Added

- Crash reports: the app now keeps a redacted log (`logs/forkyard.log` in the data folder). If it
  panics or ends without shutting down, it saves a report there and offers it on the next start
  (View, Save…, Discard; also “Show crash reports” in the command palette). Nothing is uploaded.
- Reflog: a view of where HEAD or a branch has pointed, newest first – including commits no branch
  reaches any more (shown, but without actions). Selecting an entry shows the commit; its menu creates a
  branch there, checks it out, resets the current branch to it (with undo) or copies the SHA. Open it
  from the command palette (“Show reflog”) or from a branch’s menu.
- Bisect: “Start bisect …” on one or two commits in the graph. A bar above the graph shows “Step n of ~m”
  with Good, Bad, Skip and End, the rows mark good, bad and skipped commits, and the first bad commit is
  named as soon as it is certain. A bisect started on the command line is picked up, including its own terms.
- Collapse merges: the arrow on a merge row (or ← / → on the selected merge) hides the commits the merge
  brought in and shows “+n commits”; “Collapse all merges” / “Expand all merges” (Ctrl+Shift+[ /
  Ctrl+Shift+]) also covers pages loaded later. Commits a branch or tag points to stay visible.
- The graph marks commits of the checked-out branch that are not pushed yet (↑) and commits of its
  upstream that are not pulled yet (↓).
- Image diff: besides side by side, images can be compared by swiping, as an onion skin (opacity
  slider) or as a pixel difference that highlights changed pixels and dims the rest. Images of
  different sizes are aligned at the top left; the last mode is remembered.
- Ticket links: issue numbers and ticket keys in commit messages (details and graph) open in the
  browser. Sources: the repository's host (`#123`, on GitLab also `!123`), presets for Jira, Linear,
  YouTrack and Redmine, own patterns with an address template (Settings › Project › Ticket links),
  and a `.forkyard/links.json` in the repository
  (`{ "version": 1, "rules": [{ "id": "ops", "pattern": "OPS-(\\d+)", "url": "https://ops.example/t/$1" }] }`).
  Patterns are checked; the file only creates links and runs nothing.
- Conflict preview: before a merge, rebase, cherry-pick or revert the app checks – without touching
  the working directory – whether Git would stop on conflicts, names the files (for a series also
  the first conflicting commit) and lets you go ahead anyway. The rebase tool shows the result live.
- Partial stash: selected lines and hunks from the diff view can be stashed (“Stash selection …”);
  everything else stays in the index and the working directory. Undo restores the lines and drops
  the stash.
- Rebase with dependent branches: “Move dependent branches along” rebases stacked branches in the
  same step (`--update-refs`); one undo resets all of them.
- Push several branches and tags at once (“Push with more branches and tags …”), with “All or
  nothing” (`--atomic`) and a result per ref. Forcing a branch always uses `--force-with-lease`.
- Delete a remote branch on its server: “Delete … on origin …” in the menu of a remote branch (sidebar
  and graph), “Delete … on remote …” on a local branch with an upstream, and “Delete branch on remote …”
  in the command palette. The prompt names remote and branch and the local branch that stays; if
  someone else already deleted it, the app says so and removes the stale remote branch.
- Submodules can be moved to another folder (“Move …”).
- After checkout (also of a new branch or a pull request), pull, merge, cherry-pick, revert, hard
  reset, a finished rebase, gitflow finish, bisect steps and undo/redo, changed submodules are
  updated in the background; a failure shows a warning. A submodule with commits checked out that
  no branch holds is left alone and named in the warning. Can be switched off per project.
- Git LFS file locks: the Git LFS dialog lists the repository’s locks with a filter and unlocks
  your own or – after a prompt naming owner and file – other people’s locks. Changed files and the
  file list of a commit show a lock symbol with the owner, a right-click locks or unlocks files,
  and the commit panel warns when staged files are locked by someone else (committing stays
  possible). The list is read again after every fetch; a server without file locking says so
  instead of showing an empty list.
- Custom commands: your own programs, Git commands and web addresses with placeholders (`${repo}`,
  `${sha}`, `${branch}`, `${file}`, `${remote}`, `${input:<id>}`) and an input form, in the command
  palette and the context menus of commits, branches, files and submodules (Settings → Custom
  commands, with import and export as JSON). Values are always passed as single arguments, never
  through a shell; a command can show the finished line before it runs, and runs can be cancelled.
  A repository can bring commands in `.forkyard/commands.json`; they only run after you approve
  exactly that version of the file. See `docs/custom-commands.md`.
- Command line: `forkyard --help` and `forkyard --version` answer without opening a window. The
  Windows installers put the program folder on the PATH and remove it on uninstall, deb and rpm
  install `/usr/bin/forkyard`, and for the AppImage and the macOS app the command palette offers
  “Install command-line command”.
- Statistics: a “Statistics” view per repository (toolbar or command palette) with commits by
  weekday and hour, commits over time, authors, a treemap of the most changed files, hotspots,
  knowledge per folder with bus factor, code age from `git blame` on the largest text files,
  and records. It runs as a cancellable background job for a period and branch; results are
  cached per commit and period (numbers only, never commit contents).
- Hosts: Gitea and Forgejo (including Codeberg and self-hosted instances), Bitbucket Cloud and Azure
  DevOps join GitHub and GitLab – pull requests (list, read, create, change, comment, merge, close,
  check out) and issues; on Azure DevOps these are work items, which can also be created from the app.
  Remotes are recognised in their HTTPS and SSH forms (including `ssh.dev.azure.com`,
  `vs-ssh.visualstudio.com` and `altssh.bitbucket.org`). Tokens stay in the system keychain;
  Bitbucket signs in with the account e-mail and an API token.
- Update check: once a day (and on “Check for updates…” in the command palette or Settings › About)
  the app asks GitHub for the newest stable release. A newer version shows up quietly in the status
  bar and once as a message with an excerpt of the release notes; “View release” opens the release
  page in the browser, “Skip this version” silences it. The request sends nothing but the app version
  in the user agent; drafts and prereleases are ignored, nothing is downloaded or installed. Turn it
  off under Settings › About › Check for updates automatically.

### Changed

- Redaction also removes bare GitHub (`ghp_…`, `github_pat_…`) and GitLab (`glpat-…`) tokens.
- The app only offers what a host can do: merge methods, drafts, reviewers, labels, reopening, checking
  out pull requests from forks and the issue tracker follow the host (and the repository's settings).
- Settings › "GitHub and GitLab" is now Settings › Hosts.
- Redaction also removes Atlassian API tokens and Bitbucket app passwords (`ATATT…`, `ATBB…`).
- Switching profiles and the author name hint only promise the profile identity when it is written to
  the gitconfig; a new profile takes over the active profile's gitconfig setting.
- Ending the app with SIGTERM, SIGINT, SIGHUP or by closing the console counts as a clean exit.

### Fixed

- A host request whose network read is interrupted by a signal (for example when a Git process ends at
  the same moment) is retried and no longer reported as "not reachable".
- Statistics: the code age is measured against today instead of the last commit, so a repository
  nobody touched for years no longer looks young; a cached result is sorted again against today.
- Statistics: a renamed file or moved folder keeps its history from before the rename in hotspots,
  the treemap and knowledge per folder.
- Statistics: knowledge per folder says what it measures – the share of changed lines per person.
- Statistics left open past midnight are computed again for the new day instead of showing
  yesterday's period and code age as up to date.
- Statistics of a repository without commits say "No commits yet" instead of pointing to a longer
  period.
- Statistics: the dates under “Commits over time” no longer overlap when the period spans two years.
- A failed commit signature is reported as a signing error instead of "not found".
- Applying a stash restores its untracked files through the stash itself, and a patch from a stash
  includes them.
- Partial patches keep an old last line without a final newline behind the lines it followed.
- Backups and patch exports copy the index with its original timestamp, so files rewritten in the
  same instant are no longer seen as unchanged.
- Opening a repository reads the LFS patterns from `.gitattributes` and no longer installs LFS hooks.
- A remembered account also answers the credential prompts of `git-lfs`.
- The rebase step counter counts only the commits that are replayed.
- Resetting to a commit outside the loaded graph counts only the commits that really leave the branch.
- New refs in freshly created ref folders are noticed without a reload.
- "Load more" in the sidebar sits below the pull request rows.
- The pull request view leaves out the labels block for hosts without labels.
- A commit's changed files show the LFS lock symbol.
- A local (`file://`) remote counts as an LFS server without file locking.
- The reflog keeps its selection when new entries arrive and shows the highlighted entry in the commit
  panel when it opens.
- A bisect started in a terminal is noticed.
- A custom command's confirmation shows the full command line.
- A cancelled first statistics run says so and offers to compute again.
- The crash dialog no longer shows a doubled period, and a killed run's report lists its Git calls up
  to the next start.

## [1.0.0] – 2026-10-13

First public release.

[Unreleased]: https://github.com/abgebaumt/forkyard/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/abgebaumt/forkyard/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/abgebaumt/forkyard/releases/tag/v1.0.0
