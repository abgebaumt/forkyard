# Changelog

All notable changes to Forkyard are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Changed

- Redaction also removes bare GitHub (`ghp_…`, `github_pat_…`) and GitLab (`glpat-…`) tokens.

## [1.0.0] – 2026-10-13

First public release.
