//! App windows of the active profile and their tabs.

use std::collections::BTreeSet;

use crate::app::Core;
use crate::commands::repos;
use crate::model::Tab;

/// Tabs left `window` (closed, moved out, window closed, profile switched). Background work stops
/// for the repositories that no window shows any more.
pub fn tabs_left(core: &Core, window: &str, tabs: &[Tab]) {
    let _ = window;
    for repo_id in tabs.iter().filter_map(|t| t.repo_id.as_deref()).collect::<BTreeSet<_>>() {
        repos::stop_background_if_closed(core, repo_id);
    }
}

#[cfg(test)]
mod tests;
