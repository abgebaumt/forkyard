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
  sessions (Codex in its read-only sandbox without its shell and image tools or your config.toml, opencode
  with every permission denied); a version without
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
- Compose commits: “Compose …” (small, next to the commit button of the Commit Panel, or “Compose
  commits …” in the command palette) opens a view in the centre that splits all local changes – staged,
  unstaged and new files – into several commits. A strip on top shows the history as it will look
  afterwards. The AI provider suggests the grouping and the messages and gives a short reason for every
  change; where it was unsure, “Review n unsure” (or U) goes there and Enter or “Looks right” confirms.
  Each row shows the first changed lines of its hunk. Forkyard checks without the AI whether a commit
  needs something that only comes later or is not committed at all (a new file it imports, a new
  function it calls, the source file of a changed test) and says so on the change, on the commit and in
  the history strip; creating such commits asks first (“Go to the problem” / “Create anyway”). Changes
  can be selected with Ctrl and Shift (also Shift+↑/↓) and moved together by keyboard (1–9, 0 for
  “Don't commit”, Alt+↑/↓), by dragging, or into a new commit with N; Ctrl+↑/↓ reorders commits and the
  message is edited right in the commit's header with a 72-character counter. “By files” shows which
  file goes into which commit. An instruction for the AI (“Tests in a separate commit”) asks for a new
  proposal that leaves every change you moved where it is. Secret and excluded files such as `.env.local`
  stay locked in “Don't commit”. New, deleted, renamed, binary, LFS and submodule files move as a whole.
  “Create n commits” shows each commit and its hooks while it runs, never touches the working directory
  and creates one undo step for all commits (“Undo” right in the dialog); a failing hook, a hook that
  edits files or Cancel takes every commit of the run back. Changes that are not assigned stay as they
  are.
- Git in plain language: with AI on, type `?` in the command palette – or a sentence that matches
  nothing – and press Enter. Forkyard turns it into a plan of its own commands (create, check out,
  rename or delete branches, reset, rebase, cherry-pick, revert, merge, stash, tag, change a commit
  message, fetch, pull, push, delete a remote branch, push a tag) and shows every step with its class
  and a conflict check before anything runs; E edits a step, Del removes it, Esc goes back to the text.
  Steps that go out to a remote are confirmed one by one, say they can’t be undone and pass the same
  secret scan as every push; Ctrl+Z takes the whole plan back locally (for 14 days). Settings,
  repository trust, custom commands, the terminal, coding agents and cleaning up can never be part of
  a plan, and a plan expires when the repository changes before it runs.
- Why is this so? Right-click a line in Blame (or press W, the menu key or Shift+F10) or a line in a
  diff and choose “History of this line”: the right panel lists every commit that shaped the line,
  newest first, with its message, the change of the line and the pull requests, issues and tickets it
  names (titles from the host when an account is connected). A line of the working directory is
  traced to the commit that last changed it; renames are followed. Each step opens its diff. With AI
  on, the entry reads “Why is this so?” and “Explain” lets the provider summarise the history – shown
  next to the commits it refers to, with “What is sent?” beforehand; author e-mails and excluded files
  are never sent. The Blame line menu also copies the line, shows its commit and opens the blame of
  the previous version.
- Coding agents: start Claude Code, Codex, opencode or an own program on a task (“New coding agent …”,
  Ctrl+Shift+A). Each agent works in a worktree of its own next to the repository
  (`<repo>.agents/<name>`) on a branch `agent/<name>`; your working directory stays untouched. The
  task is typed in after the start. “Without prompts” only uses switches that keep the agent inside
  its worktree and is marked as such everywhere.
- Agent cockpit: the toolbar button “Agents”, the “Agents” section in the left panel and the status
  bar show every agent with its status as a word (running, waiting for you, done, failed, stopped,
  orphaned) and whether the agent reported it or it is guessed, its changed files, commits ahead of
  the base, runtime and test result. A system notification tells you when an agent waits or is done
  while the window is in the background. Agents run in their own terminal tabs; quitting asks first.
- “Stop agent and clean up” removes worktree and branch after a warning about unpushed commits;
  Undo brings both back, including uncommitted changes, for 14 days. Stopped agents can be resumed,
  orphaned entries removed.
- Settings › Coding agents: own templates with placeholders `${task}`, `${taskFile}`, `${worktree}`,
  `${branch}`; switches that lift an agent's safety limits are refused. Project setting “Test
  command for coding agents” runs in the agent's worktree when it is done.
- Collision warning for coding agents: about ten seconds after an agent changes something,
  Forkyard compares the work of all agents of the repository – uncommitted changes included – with
  each other and with the current tip of their base, without touching any working directory,
  index or branch. The cockpit shows ““a” and “b” would collide in src/auth.ts (lines 40–62)” or
  “… both change …”, with a preview of both sides of each conflict and “Inform agent …”, which types
  a note you confirmed into that agent's terminal. A failed check shows up in the cockpit with
  “Check again”.
- Agent review: “Review changes” in the cockpit (or “Review coding agent …” in the command palette)
  shows a coding agent's work against the commit it started from – its working state including
  uncommitted and new files, or only its commits. Files are listed as “Selected” and “Not selected”,
  single lines are checked in the diff. Take the selection into your working directory unstaged or
  staged (a conflict with your own changes stops before anything changes and names the files),
  commit it on your branch with the message prefilled from the task, merge the agent's branch or
  rebase it onto its base in the agent's worktree, or discard what is left uncommitted there – each
  with undo. Two agents can be compared side by side.
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
  branches and tags, tag push, commit and push, the push of a pull request branch, the push of stacked
  pull requests and the push at the end of a Gitflow finish. Settings › Project › Git can report every finding again.
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
- Stacked pull requests: “Split into stacked pull requests …” in a branch’s menu (and in the command
  palette) shows the branch’s commits oldest first and cuts them at commit boundaries – with the
  keyboard (Space) or, with AI on, from a suggestion of names, cuts and titles. “Check each part” runs
  the project’s test command on every part in a temporary worktree that is removed afterwards.
  “Create branches” makes `<branch>-1-…`, `<branch>-2-…` without a checkout as one undo step; the parts
  are pushed in one atomic push and get pull requests that each target the part below them (GitHub,
  GitLab, Gitea/Forgejo, Bitbucket Cloud, Azure DevOps). After a change further down, “Restack” rebases
  the parts above with `--update-refs` and names the parts it leaves behind because they are checked
  out in another worktree.
- Review comments: the pull request view lists the open review threads (file, lines, comments) for
  GitHub, GitLab, Gitea/Forgejo, Bitbucket Cloud and Azure DevOps. With AI on, “Suggest fix” proposes a
  replacement for the commented lines as a small diff with a reason; Forkyard builds the patch itself,
  picks the commit it belongs to (blame of the commented lines inside the pull request) and “Take over
  as fixup” commits it as `fixup! <subject>` on the checked-out branch – hooks and signing included,
  one undo step for several takeovers in a row. Replies are posted only on click (on Gitea/Forgejo as a
  quoted comment on the same line). Afterwards “Squash now” opens the interactive rebase with the fixups
  below their commits (autosquash, new action “Fixup”).
- Search by meaning: while AI is on, the commit search gets a switch “Text | Meaning”. A question such
  as “where was the sign-in fixed?” finds commits by what they are about, each with a reason, on Enter.
  It uses an embedding provider on this computer (Ollama or LM Studio, chosen in Settings › AI),
  otherwise the main provider's embeddings, and without embeddings the main provider turns the question
  into a search with terms, code, paths, author and time window and sorts the matches. The index lives
  in its own file in the data folder, per repository and model (the newest 200,000 commits), grows after
  fetches and commits once the search was used, follows rewritten history and can be deleted in
  Settings › AI. What goes out passes the same exclusions, redaction and confirmations as every AI request.
- **Version in the status bar**: the running version at the right end of the status bar; a click opens
  the changelog on GitHub.
- Stashes sit at the top of the graph, below the uncommitted changes, newest first; a line at the side
  leads down to the commit each one was made on.

### Changed

- Undoing a rebase that moved dependent branches along now happens all or nothing: if a branch is locked
  or the working directory has changes, nothing moves.

### Fixed

- A request that is still waiting for its answer – an AI suggestion, a new pull request – is no longer
  ended with “connection was interrupted” when a Git process finishes at the same moment (Linux, macOS).
- Forkyard no longer opens a new keychain session for every token it reads or stores (Linux). With
  GNOME Keyring 50 that could crash the keyring service, which then came back locked.
- A branch that follows a remote branch of another name – created with
  `git checkout -b qa/blackbox origin/develop` – is no longer pushed onto that branch. A push without a
  chosen target went to `origin/develop`, while the branch showed “↑0 ↓0” and “nothing to push”. Like
  Git’s default (`push.default=simple`), Push now asks where to push it and records the new upstream.
  Pushing goes to an upstream of another name only with `push.default=upstream`, or after you pushed the
  branch there yourself in Forkyard.
- A branch that is local but not on its remote – no upstream, an upstream that is gone, or one of another
  name – now shows as to push: the status bar reads “↑3 · not on origin yet”, Push carries a badge (a
  dot for a branch without commits of its own), the branch menu says “creates origin/<name>”, the sidebar
  shows the outgoing arrow, and the push dialog lists the branch as new with its commits. The count is
  the commits that are on no remote branch.
- Faster start on Linux laptops with two GPUs: the window no longer waits about 3 seconds while the
  powered-down second GPU (e.g. NVIDIA) wakes up. WebKitGTK woke it to watch the display's refresh; with
  more than one GPU Forkyard now has it use its timer instead (`WEBKIT_FORCE_VBLANK_TIMER`, a value you
  set yourself is kept), and the GPU stays asleep.
- The start no longer waits for the system keychain; only the screens that store secrets ask for it.
- Setting up file watching for a very large working directory (hundreds of thousands of folders, e.g.
  node_modules) no longer holds up the app's other work while it walks the tree.
- The start no longer runs the coding-agent tools (`claude`, `codex`, `opencode` with `--version` and
  their sign-in check, one after another): the left panel's Agents section only asks for the templates
  once an agent could be resumed.
- Less code to load at startup: the diff, file, blame, conflict, rebase, pull request, statistics and
  other views and most dialogs load when first opened (CodeMirror with them).
- The log now says how long the phases of a start took (`Startup: …`), including the window's own
  milestones up to the first graph rows and the slowest calls of the start.

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
