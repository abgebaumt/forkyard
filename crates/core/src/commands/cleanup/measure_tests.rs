//! Measuring: `count-objects`, free space, old reflog entries.

use super::test_support::*;
use super::{disk, measure};
use crate::model::ObjectStats;

/// The counting tests are about the count: the app's 2 s budget is too tight for a few Git starts
/// on a loaded Windows machine (the budget itself is tested with `Duration::ZERO`).
const COUNTING_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

#[test]
fn count_objects_fields_are_kib_and_become_bytes() {
    let text = "count: 10\nsize: 40\nin-pack: 1234\npacks: 2\nsize-pack: 3075\nprune-packable: 0\ngarbage: 1\nsize-garbage: 7\n";
    assert_eq!(
        measure::parse_count_objects(text),
        ObjectStats {
            loose_count: 10,
            loose_bytes: 40_960,
            in_pack: 1234,
            packs: 2,
            pack_bytes: 3_148_800,
            garbage_count: 1,
            garbage_bytes: 7_168,
            total_bytes: 3_196_928,
        }
    );
    assert_eq!(measure::parse_count_objects(""), ObjectStats::default());
}

#[tokio::test]
async fn object_counts_are_the_ones_git_reports() {
    let (tc, repo, id) = setup().await;
    for n in 0..5 {
        repo.commit_file(&format!("daten/messung-{n}.csv"), format!("station;wert\nNord;{n}\n"), "Messung");
    }
    repo.git(&["gc", "-q"]);
    for n in 0..3 {
        repo.commit_file(&format!("neu/Größe {n}.txt"), format!("{n}\n"), "Nach dem Packen");
    }
    let git = git_count_objects(&repo);
    assert!(git["count"] > 0 && git["packs"] >= 1, "fixture has loose objects and a pack: {git:?}");
    let stats = measure::count_objects(&tc, &id).await.unwrap();
    assert_eq!((stats.loose_count, stats.loose_bytes), (git["count"], git["size"] * 1024));
    assert_eq!((stats.packs, stats.in_pack, stats.pack_bytes), (git["packs"], git["in-pack"], git["size-pack"] * 1024));
    assert_eq!(stats.total_bytes, (git["size"] + git["size-pack"] + git["size-garbage"]) * 1024);
}

#[cfg(target_os = "linux")]
#[test]
fn free_space_is_the_one_df_reports() {
    let dir = crate::testkit::temp_folder();
    let out = std::process::Command::new("df").arg("-Pk").arg(dir.path()).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let available_kib: u64 = text.lines().nth(1).unwrap().split_whitespace().nth(3).unwrap().parse().unwrap();
    let ours = disk::free_bytes(dir.path()).expect("free space known");
    let df = available_kib * 1024;
    // Other tests write meanwhile; a quarter GiB of slack.
    assert!(ours.abs_diff(df) < 256 * 1024 * 1024, "ours {ours}, df {df}");
}

#[test]
fn free_space_of_a_missing_folder_is_unknown() {
    let dir = crate::testkit::temp_folder();
    assert_eq!(disk::free_bytes(&dir.path().join("gibt es nicht")), None);
}

#[test]
fn reflog_lines_and_selectors_carry_their_time() {
    let line = "0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 Mats Öztürk <mats@example.com> 1767225600 +0545\tcommit (initial): Erster";
    assert_eq!(measure::reflog_time(line.as_bytes()), Some(1_767_225_600));
    // A '>' in the name and digits in the message do not confuse the time.
    assert_eq!(measure::reflog_time(b"a b Bob <bob> Bobsen <b@x> 1700000000 -0700\tmerge 1600000000"), Some(1_700_000_000));
    assert_eq!(measure::reflog_time(b""), None);
    assert_eq!(measure::reflog_time(b"kaputt ohne Zeit"), None);
    assert_eq!(measure::selector_time(b"refs/heads/feature/x@{1767225600}"), Some(1_767_225_600));
    assert_eq!(measure::selector_time(b"main"), None);
}

/// Commits around the 90-day line in five time zones, plus a worktree with an old commit. Each
/// commit writes one entry to HEAD's and one to its branch's reflog (Git's documented behaviour).
#[tokio::test]
async fn old_reflog_entries_are_counted_in_every_worktree() {
    let tc = crate::testkit::TestCore::new().await;
    let repo = crate::testkit::TestRepo::new();
    let now = now();
    for (days, zone) in [(400, "+0200"), (200, "-0700"), (91, "+0545"), (89, "+0000"), (1, "+1300")] {
        git_dated(&repo, repo.path(), now - days * DAY, zone, &["commit", "-q", "--allow-empty", "-m", &format!("vor {days} Tagen")]);
    }
    let worktree = repo.temp_dir().join("zweiter Baum");
    git_dated(&repo, repo.path(), now - DAY, "+0100", &["worktree", "add", "-q", "-b", "wt", &worktree.to_string_lossy()]);
    git_dated(&repo, &worktree, now - 300 * DAY, "-0300", &["commit", "-q", "--allow-empty", "-m", "alt im Worktree"]);
    let id = tc.open(&repo).await.repo.id;
    let common = measure::common_dir(&tc, &id).await.unwrap();
    // 3 old commits on main × (HEAD + main) + 1 old commit in the worktree × (its HEAD + wt).
    assert_eq!(measure::count_old_reflog(&tc, &id, &common, COUNTING_BUDGET).await.unwrap(), Some(8));
}

#[tokio::test]
async fn reflog_count_gives_up_after_its_time_budget() {
    let (tc, _repo, id) = setup().await;
    let common = measure::common_dir(&tc, &id).await.unwrap();
    assert_eq!(measure::count_old_reflog(&tc, &id, &common, std::time::Duration::ZERO).await.unwrap(), None);
}

#[tokio::test]
async fn old_reflog_entries_are_counted_with_reftable() {
    let tc = crate::testkit::TestCore::new().await;
    let dir = crate::testkit::temp_folder();
    let global = dir.path().join("gitconfig");
    std::fs::write(&global, "[user]\n\tname = Test Person\n\temail = test@example.com\n").unwrap();
    let root = dir.path().join("Reftable Repo");
    let init = std::process::Command::new("git")
        .args(["init", "-q", "-b", "main", "--ref-format=reftable"])
        .arg(&root)
        .envs(crate::testkit::git_isolation_env(&global))
        .output()
        .unwrap();
    if !init.status.success() {
        eprintln!("This Git has no reftable – test skipped.");
        return;
    }
    let now = now();
    for (days, zone) in [(120, "+0100"), (95, "-0500"), (3, "+0900")] {
        git_dated_at(&root, &global, now - days * DAY, zone, &["commit", "-q", "--allow-empty", "-m", "Messung"]);
    }
    let id = crate::commands::repos::repo_open(&tc, root.to_string_lossy().into_owned()).await.unwrap().repo.id;
    crate::commands::trust::repo_trust_set(&tc, id.clone(), true).await.unwrap();
    let common = measure::common_dir(&tc, &id).await.unwrap();
    // 2 old commits × (HEAD + main).
    assert_eq!(measure::count_old_reflog(&tc, &id, &common, COUNTING_BUDGET).await.unwrap(), Some(4));
}
