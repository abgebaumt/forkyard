//! The preview: Git's numbers, worktrees, undo backups, LFS cache and estimate.

use super::test_support::*;
use super::*;
use crate::error::ErrorCode;
use crate::model::CleanupLfsEstimate;
use crate::util;

#[tokio::test]
async fn preview_matches_git_and_counts_worktrees() {
    let (tc, repo, id) = setup().await;
    tc.state::<crate::commands::lfs::LfsState>().set_pretend_missing(true);
    for n in 0..4 {
        repo.commit_file(&format!("-führend {n}.txt"), format!("{n}\n"), "Datei mit Strich vorn");
    }
    let kept = repo.temp_dir().join("Baum mit Leerzeichen");
    let gone = repo.temp_dir().join("weg");
    repo.git(&["worktree", "add", "-q", "-b", "bleibt", &kept.to_string_lossy()]);
    repo.git(&["worktree", "add", "-q", "-b", "verwaist", &gone.to_string_lossy()]);
    std::fs::remove_dir_all(&gone).unwrap();
    let porcelain = repo.git(&["worktree", "list", "--porcelain"]);
    assert_eq!(porcelain.matches("\nprunable").count(), 1, "Git sees one orphaned worktree: {porcelain}");

    let git = git_count_objects(&repo);
    let preview = repo_cleanup_preview(&tc, id.clone()).await.unwrap();
    assert_eq!((preview.objects.loose_count, preview.objects.packs), (git["count"], git["packs"]));
    assert_eq!(preview.objects.total_bytes, (git["size"] + git["size-pack"] + git["size-garbage"]) * 1024);
    assert_eq!((preview.orphaned_worktrees, preview.linked_worktrees), (1, 1));
    assert_eq!(preview.lfs_bytes, None, "no Git LFS");
    assert!(preview.undo_backups.is_empty());
    assert!(preview.free_bytes.is_some_and(|free| free > 0));
    assert!(preview.old_reflog_entries.is_some());
}

#[tokio::test]
async fn undo_backups_are_listed_with_their_age() {
    let (tc, repo, id) = setup().await;
    let f = undo_fixture(&tc, &repo, &id).await;
    let preview = repo_cleanup_preview(&tc, id.clone()).await.unwrap();
    let mut listed: Vec<(String, Option<String>, bool)> = preview.undo_backups.iter().map(|b| (b.entry_id.clone(), b.created_at.clone(), b.orphaned)).collect();
    listed.sort();
    let mut expected = vec![
        (f.old_entry.clone(), Some(f.old_entry_at.clone()), false),
        (f.young_entry.clone(), Some(f.young_entry_at.clone()), false),
        (f.old_orphan.clone(), Some(util::unix_to_iso(f.old_orphan_time)), true),
        (f.young_orphan.clone(), Some(util::unix_to_iso(f.young_orphan_time)), true),
        (f.tree_orphan.clone(), None, true),
    ];
    expected.sort();
    assert_eq!(listed, expected);
}

#[tokio::test]
async fn backups_of_a_worktree_opened_on_its_own_belong_to_the_repository() {
    let (tc, repo, id) = setup().await;
    let worktree = repo.temp_dir().join("zweiter Baum");
    repo.git(&["worktree", "add", "-q", "-b", "zwei", &worktree.to_string_lossy()]);
    let worktree_id = crate::commands::repos::repo_open(&tc, worktree.to_string_lossy().into_owned()).await.unwrap().repo.id;
    let entry = record_entry(&tc, &worktree_id, &repo.head(), &util::now_iso()).await;
    let preview = repo_cleanup_preview(&tc, id.clone()).await.unwrap();
    let listed: Vec<(&str, bool)> = preview.undo_backups.iter().map(|b| (b.entry_id.as_str(), b.orphaned)).collect();
    assert_eq!(listed, [(entry.as_str(), false)], "the worktree's entry is not an orphan of the main repository");
    assert_eq!(repo_cleanup_preview(&tc, worktree_id).await.unwrap().undo_backups, preview.undo_backups);
}

#[test]
fn lfs_dry_run_summary_is_read() {
    let parse = measure::parse_lfs_dry_run;
    assert_eq!(parse("3 local objects, 1 retained, done.\n2 files would be pruned (12 KB), done.\n"), CleanupLfsEstimate { files: 2, bytes: 12_000 });
    assert_eq!(parse("prune: 1 file would be pruned (7.0 KB)\r"), CleanupLfsEstimate { files: 1, bytes: 7_000 });
    assert_eq!(parse("12 files would be pruned (980 B), done."), CleanupLfsEstimate { files: 12, bytes: 980 });
    assert_eq!(parse("3 files would be pruned (1.5 MB), done."), CleanupLfsEstimate { files: 3, bytes: 1_500_000 });
    assert_eq!(parse("3 local objects, 3 retained, done."), CleanupLfsEstimate { files: 0, bytes: 0 });
}

#[tokio::test]
async fn lfs_cache_and_estimate_follow_git_lfs() {
    let (tc, repo, id) = setup().await;
    let Some(_remote) = lfs_fixture(&tc, &repo, &id).await else { return };
    let preview = repo_cleanup_preview(&tc, id.clone()).await.unwrap();
    assert_eq!(preview.lfs_bytes, Some(15_000), "5000 + 7000 + 3000 bytes in the cache");
    assert_eq!(repo_cleanup_lfs_estimate(&tc, id.clone()).await.unwrap(), CleanupLfsEstimate { files: 2, bytes: 12_000 });
    assert_eq!(repo_cleanup_preview(&tc, id).await.unwrap().lfs_bytes, Some(15_000), "the estimate only looks");
}

#[tokio::test]
async fn without_git_lfs_there_is_no_lfs_row_and_no_estimate() {
    let (tc, _repo, id) = setup().await;
    tc.state::<crate::commands::lfs::LfsState>().set_pretend_missing(true);
    assert_eq!(repo_cleanup_preview(&tc, id.clone()).await.unwrap().lfs_bytes, None);
    assert_eq!(repo_cleanup_lfs_estimate(&tc, id).await.unwrap_err().code, ErrorCode::Unsupported);
}
