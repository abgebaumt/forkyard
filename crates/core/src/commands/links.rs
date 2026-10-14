//! Ticket links: rules that turn references in commit messages (`#123`, `ABC-42` …) into links.
//! Four sources: the detected host, presets (Jira, Linear, YouTrack, Redmine), the user's own rules
//! (both stored in `repo_settings` under `linkRules`) and the repository file `.forkyard/links.json`.
//! The core only checks and collects the rules; the UI matches them. A link only opens the browser,
//! nothing runs – the repository file therefore needs no trust of its own.

mod pattern;

pub use pattern::{check_pattern, MAX_PATTERN_LEN};
