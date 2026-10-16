//! Fixtures for the clean-up tests: real repositories, dates relative to now, Git's own numbers.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::testkit::{git_isolation_env, TestCore, TestRemote, TestRepo};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

pub(super) const DAY: i64 = 86_400;

pub(super) fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(super) async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

/// `git count-objects -v` as Git prints it, field by field (KiB values).
pub(super) fn git_count_objects(repo: &TestRepo) -> HashMap<String, u64> {
    repo.git(&["count-objects", "-v"])
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(": ")?;
            Some((key.to_string(), value.trim().parse().ok()?))
        })
        .collect()
}

/// Git in `cwd` with author and committer date `when` (Unix seconds) in time zone `zone`; the
/// reflog entries it writes carry the same time. Returns stdout without the trailing newline.
pub(super) fn git_dated_at(cwd: &Path, global_config: &Path, when: i64, zone: &str, args: &[&str]) -> String {
    let stamp = format!("@{when} {zone}");
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .envs(git_isolation_env(global_config))
        .env("GIT_AUTHOR_DATE", &stamp)
        .env("GIT_COMMITTER_DATE", &stamp)
        .output()
        .expect("start git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

/// `git_dated_at` for a `TestRepo` (its own global configuration).
pub(super) fn git_dated(repo: &TestRepo, cwd: &Path, when: i64, zone: &str, args: &[&str]) -> String {
    git_dated_at(cwd, &repo.temp_dir().join("gitconfig"), when, zone, args)
}

/// An undo entry naming `before` and `after` (as a reset records it), without any backup ref.
pub(super) async fn record_plain_entry(tc: &TestCore, id: &str, before: &str, after: &str) -> String {
    let entry_id = undo::new_id();
    undo::record(
        tc,
        UndoRecord {
            id: entry_id.clone(),
            repo_id: id.to_string(),
            worktree_path: String::new(),
            action: UndoAction::Reset,
            label: "Undo reset".into(),
            ref_name: Some("refs/heads/main".into()),
            ref_before: Some(before.to_string()),
            ref_after: Some(after.to_string()),
            head_before: "refs/heads/main".into(),
            head_after: Some("refs/heads/main".into()),
            payload: serde_json::json!({}),
        },
    )
    .await
    .unwrap();
    entry_id
}

/// An undo entry with a backup ref on `sha`, recorded at `created_at` (ISO, as in the database).
pub(super) async fn record_entry(tc: &TestCore, id: &str, sha: &str, created_at: &str) -> String {
    let entry_id = record_plain_entry(tc, id, sha, sha).await;
    undo::create_backup_ref(tc, id, &entry_id, "head", sha).await.unwrap();
    tc.db
        .with(|c| {
            c.execute("update undo_entries set created_at = ?2 where id = ?1", rusqlite::params![entry_id, created_at])?;
            Ok(())
        })
        .unwrap();
    entry_id
}

pub(super) struct UndoFixture {
    pub old_entry: String,
    pub old_entry_at: String,
    pub young_entry: String,
    pub young_entry_at: String,
    pub old_orphan: String,
    pub old_orphan_time: i64,
    pub young_orphan: String,
    pub young_orphan_time: i64,
    pub tree_orphan: String,
}

/// Two undo entries with backup refs (30 and 2 days old by their database date) and three
/// backup ref groups without an entry: on a commit from 400 days ago, on one from yesterday, on a tree.
pub(super) async fn undo_fixture(tc: &TestCore, repo: &TestRepo, id: &str) -> UndoFixture {
    let now = now();
    let head = repo.head();
    let old_entry_at = util::unix_to_iso(now - 30 * DAY);
    let young_entry_at = util::unix_to_iso(now - 2 * DAY);
    let old_entry = record_entry(tc, id, &head, &old_entry_at).await;
    let young_entry = record_entry(tc, id, &head, &young_entry_at).await;
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    let old_orphan_time = now - 400 * DAY;
    let young_orphan_time = now - DAY;
    let old_commit = git_dated(repo, repo.path(), old_orphan_time, "+0530", &["commit-tree", &tree, "-m", "forkyard: backup"]);
    let young_commit = git_dated(repo, repo.path(), young_orphan_time, "-0800", &["commit-tree", &tree, "-m", "forkyard: backup"]);
    let old_orphan = util::new_id();
    let young_orphan = util::new_id();
    let tree_orphan = util::new_id();
    repo.git(&["update-ref", &undo::backup_ref_name(&old_orphan, "head"), &old_commit]);
    repo.git(&["update-ref", &undo::backup_ref_name(&young_orphan, "head"), &young_commit]);
    repo.git(&["update-ref", &undo::backup_ref_name(&young_orphan, "worktree"), &young_commit]);
    repo.git(&["update-ref", &undo::backup_ref_name(&tree_orphan, "index"), &tree]);
    UndoFixture { old_entry, old_entry_at, young_entry, young_entry_at, old_orphan, old_orphan_time, young_orphan, young_orphan_time, tree_orphan }
}

/// Ids of the backup ref groups below `refs/forkyard/undo/`, sorted – as Git lists them.
pub(super) fn backup_ref_ids(repo: &TestRepo) -> Vec<String> {
    let mut ids: Vec<String> = repo
        .git(&["for-each-ref", "--format=%(refname)", "refs/forkyard/undo/"])
        .lines()
        .filter_map(|name| Some(name.strip_prefix("refs/forkyard/undo/")?.split('/').next()?.to_string()))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Three pushed versions of `daten/modell.bin` (5000, 7000 and 3000 bytes) behind Git LFS, with
/// the recency windows at 0 days, so `git lfs prune` may take the two older ones. `None` (and a
/// note) without Git LFS – the caller skips the test then, like the existing LFS tests.
pub(super) async fn lfs_fixture(tc: &TestCore, repo: &TestRepo, id: &str) -> Option<TestRemote> {
    if !crate::commands::lfs::lfs_status(tc, id.to_string()).await.unwrap().installed {
        eprintln!("Git LFS is not installed – test skipped.");
        return None;
    }
    crate::commands::lfs::lfs_track(tc, id.to_string(), "*.bin".into()).await.unwrap();
    for (version, size) in [(1u8, 5000usize), (2, 7000), (3, 3000)] {
        repo.write_file("daten/modell.bin", vec![version; size]);
        repo.commit(&format!("Modell {version}"));
    }
    let remote = TestRemote::new();
    let url = format!("file:///{}", remote.url().trim_start_matches('/'));
    repo.git(&["remote", "add", "origin", &url]);
    repo.git(&["push", "-q", "-u", "origin", "main"]);
    for key in ["lfs.fetchrecentrefsdays", "lfs.fetchrecentcommitsdays", "lfs.pruneoffsetdays"] {
        repo.git(&["config", key, "0"]);
    }
    Some(remote)
}
