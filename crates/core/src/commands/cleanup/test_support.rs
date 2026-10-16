//! Fixtures for the clean-up tests: real repositories, dates relative to now, Git's own numbers.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::testkit::{git_isolation_env, TestCore, TestRepo};

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
