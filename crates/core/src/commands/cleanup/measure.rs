//! Reading what the repository occupies. Read-only; nothing here takes a lock.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::model::ObjectStats;
use crate::util;

/// `git count-objects -v` (values in KiB) as bytes. Unknown or missing fields count as 0.
pub(super) fn parse_count_objects(text: &str) -> ObjectStats {
    let mut fields: HashMap<&str, u64> = HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once(':') {
            if let Ok(number) = value.trim().parse::<u64>() {
                fields.insert(key.trim(), number);
            }
        }
    }
    let get = |key: &str| fields.get(key).copied().unwrap_or(0);
    let loose_bytes = get("size").saturating_mul(1024);
    let pack_bytes = get("size-pack").saturating_mul(1024);
    let garbage_bytes = get("size-garbage").saturating_mul(1024);
    ObjectStats {
        loose_count: get("count"),
        loose_bytes,
        in_pack: get("in-pack"),
        packs: get("packs"),
        pack_bytes,
        garbage_count: get("garbage"),
        garbage_bytes,
        total_bytes: loose_bytes.saturating_add(pack_bytes).saturating_add(garbage_bytes),
    }
}

/// The repository's object numbers (for a worktree: those of the shared object folder).
pub(super) async fn count_objects(core: &Core, repo_id: &str) -> CoreResult<ObjectStats> {
    let out = core.git_for(repo_id)?.args(["count-objects", "-v"]).read_only().no_log().run().await?;
    Ok(parse_count_objects(&out.stdout_text()))
}

/// The common Git directory (for a worktree: the one of the main repository).
pub(super) async fn common_dir(core: &Core, repo_id: &str) -> CoreResult<PathBuf> {
    let root = core.repo_path(repo_id)?;
    crate::commands::trust::common_dir(core, &root).await.ok_or_else(|| CoreError::not_a_repo(util::display_path(&root)))
}
