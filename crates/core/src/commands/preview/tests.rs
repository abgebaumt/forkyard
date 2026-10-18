//! Conflict preview against real temp repositories: clean, conflict, binary file, rename,
//! series (cherry-pick, revert, rebase), patch, limits, cancel. Nothing may change in the repository.

use super::*;
use crate::events::names;
use crate::testkit::{TestCore, TestRepo};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    (tc, repo, id)
}

async fn run(tc: &TestCore, id: &str, op: PreviewOp) -> ConflictPreview {
    conflict_preview(tc, id.to_string(), util::new_id(), op).await.unwrap()
}

fn merge_op(theirs: &str) -> PreviewOp {
    PreviewOp::Merge { theirs: theirs.into() }
}

fn conflicts(files: &[&str], at: Option<&str>) -> ConflictPreview {
    ConflictPreview::Conflicts { files: files.iter().map(|f| f.to_string()).collect(), at_commit: at.map(str::to_string) }
}

#[tokio::test]
async fn merge_preview_is_clean_or_names_the_conflicted_files() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.checkout_new("sauber");
    repo.commit_file("g.txt", "neu\n", "Neue Datei");
    repo.checkout("main");
    repo.checkout_new("seite");
    repo.commit_file("f.txt", "eins\nZWEI seite\ndrei\n", "Seite");
    repo.checkout("main");
    repo.commit_file("f.txt", "eins\nzwei main\ndrei\n", "Main");
    repo.write_file("offen.txt", "ungespeichert\n");
    let head = repo.head();
    let before = repo.git(&["status", "--porcelain"]);

    assert_eq!(run(&tc, &id, merge_op("sauber")).await, ConflictPreview::Clean);
    assert_eq!(run(&tc, &id, merge_op("seite")).await, conflicts(&["f.txt"], None));
    // Nothing changed: HEAD, index and working directory are as before, no merge is running.
    assert_eq!(repo.head(), head);
    assert_eq!(repo.git(&["status", "--porcelain"]), before);
    assert!(!repo.path().join(".git").join("MERGE_HEAD").exists());
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
}

#[tokio::test]
async fn binary_files_and_renames_are_judged_like_a_real_merge() {
    let (tc, repo, id) = setup().await;
    repo.write_file("bild.bin", b"\x00\x01basis");
    let base = repo.commit_file("alt.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.checkout_new("seite");
    repo.write_file("bild.bin", b"\x00\x02seite");
    repo.git(&["mv", "alt.txt", "neu name.txt"]);
    repo.commit("Seite: Bild und Umbenennung");
    repo.checkout("main");
    repo.write_file("bild.bin", b"\x00\x03main");
    repo.commit_file("alt.txt", "eins\nzwei\ndrei\nvier\n", "Main: Bild und Zeile");
    // The rename takes the new line along; only the binary file conflicts.
    assert_eq!(run(&tc, &id, merge_op("seite")).await, conflicts(&["bild.bin"], None));

    // Renamed on one side, deleted on the other.
    repo.git(&["checkout", "-q", "-b", "geloescht", &base]);
    repo.git(&["rm", "-q", "alt.txt"]);
    repo.commit("Gelöscht");
    assert_eq!(run(&tc, &id, merge_op("seite")).await, conflicts(&["neu name.txt"], None));
}

#[tokio::test]
async fn unrelated_histories_and_unknown_commits_are_unknown_not_errors() {
    let (tc, repo, id) = setup().await;
    repo.git(&["checkout", "-q", "--orphan", "fremd"]);
    repo.git(&["rm", "-r", "-f", "-q", "."]);
    repo.commit_file("x.txt", "x\n", "Fremd");
    repo.checkout("main");
    match run(&tc, &id, merge_op("fremd")).await {
        ConflictPreview::Unknown { reason } => assert!(reason.contains("unrelated"), "{reason}"),
        other => panic!("expected unknown, got {other:?}"),
    }
    assert!(matches!(run(&tc, &id, merge_op("gibt-es-nicht")).await, ConflictPreview::Unknown { .. }));
    assert!(matches!(run(&tc, &id, merge_op("--help")).await, ConflictPreview::Unknown { .. }));
}

#[tokio::test]
async fn cherry_pick_series_stops_at_the_first_conflicting_commit() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.checkout_new("seite");
    let c1 = repo.commit_file("g.txt", "g\n", "Seite 1");
    let c2 = repo.commit_file("f.txt", "eins\nZWEI\ndrei\n", "Seite 2");
    let c3 = repo.commit_file("h.txt", "h\n", "Seite 3");
    let c4 = repo.commit_file("g.txt", "g\nmehr\n", "Seite 4");
    repo.checkout("main");
    let pick = |commits: &[&String]| PreviewOp::CherryPick { commits: commits.iter().map(|sha| sha.to_string()).collect() };

    assert_eq!(run(&tc, &id, pick(&[&c1, &c2, &c3])).await, ConflictPreview::Clean);
    repo.commit_file("f.txt", "eins\nzwei main\ndrei\n", "Main");
    assert_eq!(run(&tc, &id, pick(&[&c1, &c2, &c3])).await, conflicts(&["f.txt"], Some(c2.as_str())));
    // c4 changes the file c1 creates: only in this order is it clean – the series runs on the intermediate trees.
    assert_eq!(run(&tc, &id, pick(&[&c1, &c4])).await, ConflictPreview::Clean);
    assert_eq!(run(&tc, &id, pick(&[&c4])).await, conflicts(&["g.txt"], Some(c4.as_str())));
    assert!(repo.git(&["for-each-ref", "--format=%(refname)"]).lines().all(|name| name.starts_with("refs/heads/")), "no refs were created");
}

#[tokio::test]
async fn revert_preview_detects_later_changes_to_the_same_lines() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    let change = repo.commit_file("f.txt", "eins\nZWEI\ndrei\n", "Änderung");
    let revert = |commits: Vec<String>| PreviewOp::Revert { commits };
    assert_eq!(run(&tc, &id, revert(vec![change.clone()])).await, ConflictPreview::Clean);
    repo.commit_file("f.txt", "eins\nZWEI später\ndrei\n", "Später");
    assert_eq!(run(&tc, &id, revert(vec![change.clone()])).await, conflicts(&["f.txt"], Some(change.as_str())));
    // The root commit has no parent: not replayable.
    let root = repo.git(&["rev-list", "--max-parents=0", "HEAD"]);
    assert!(matches!(run(&tc, &id, revert(vec![root])).await, ConflictPreview::Unknown { .. }));
}

#[tokio::test]
async fn rebase_preview_replays_the_branch_onto_the_target() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.checkout_new("feature");
    let f1 = repo.commit_file("g.txt", "g\n", "Feature 1");
    let f2 = repo.commit_file("f.txt", "eins\nZWEI feature\ndrei\n", "Feature 2");
    repo.checkout("main");
    repo.commit_file("h.txt", "h\n", "Main ohne Konflikt");
    repo.checkout("feature");
    let rebase = |branch: Option<&str>, commits: Option<Vec<String>>| PreviewOp::Rebase { onto: "main".into(), upstream: None, branch: branch.map(str::to_string), commits };

    assert_eq!(run(&tc, &id, rebase(None, None)).await, ConflictPreview::Clean);
    repo.checkout("main");
    repo.commit_file("f.txt", "eins\nzwei main\ndrei\n", "Main mit Konflikt");
    // From main the branch is named explicitly.
    assert_eq!(run(&tc, &id, rebase(Some("feature"), None)).await, conflicts(&["f.txt"], Some(f2.as_str())));
    // An interactive plan without the conflicting commit is clean.
    assert_eq!(run(&tc, &id, rebase(None, Some(vec![f1.clone()]))).await, ConflictPreview::Clean);
}

#[tokio::test]
async fn patch_preview_checks_against_the_working_directory() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.write_file("f.txt", "eins\nZWEI\ndrei\n");
    let text = format!("{}\n", repo.git(&["diff"]));
    repo.git(&["checkout", "--", "f.txt"]);
    let op = |text: &str| PreviewOp::Patch { text: text.to_string() };

    assert_eq!(run(&tc, &id, op(&text)).await, ConflictPreview::Clean);
    repo.write_file("f.txt", "eins\nzwei anders\ndrei\n");
    assert_eq!(run(&tc, &id, op(&text)).await, conflicts(&["f.txt"], None));
    assert_eq!(repo.read_file("f.txt"), b"eins\nzwei anders\ndrei\n", "the check changes nothing");
    assert!(matches!(run(&tc, &id, op("kein patch")).await, ConflictPreview::Unknown { .. }));
    assert!(matches!(run(&tc, &id, op("  ")).await, ConflictPreview::Unknown { .. }));
}

#[test]
fn files_named_by_git_apply_are_collected_once() {
    let stderr = "error: patch failed: a b.txt:3\nerror: a b.txt: patch does not apply\nerror: neu.txt: already exists in working directory\nerror: weg.txt: No such file or directory\n";
    assert_eq!(patch_conflicts(stderr), ["a b.txt", "neu.txt", "weg.txt"]);
    assert!(patch_conflicts("error: No valid patches in input").is_empty());
}

#[tokio::test]
async fn long_series_are_unknown_and_the_preview_runs_as_a_cancellable_job() {
    let (tc, repo, id) = setup().await;
    let sha = repo.head();
    match run(&tc, &id, PreviewOp::CherryPick { commits: vec![sha; MAX_SERIES + 1] }).await {
        ConflictPreview::Unknown { reason } => assert!(reason.contains("200"), "{reason}"),
        other => panic!("expected unknown, got {other:?}"),
    }

    tc.events.clear();
    conflict_preview(&tc, id.clone(), "job-preview".into(), merge_op("main")).await.unwrap();
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["jobId"].as_str(), done[0]["ok"].as_bool()), (1, Some("job-preview"), Some(true)));
    assert_eq!(tc.events.count(names::LOG_APPENDED), 0, "background read: not in the activity log");

    let cancelled = CancelToken::new();
    cancelled.cancel();
    assert_eq!(preview(&tc, &id, &cancelled, merge_op("main")).await.unwrap_err().code, ErrorCode::Cancelled);
}

/// The plan pre-check (Paket 5) simulates a step from the state the earlier steps leave – not
/// from HEAD. The oracle is `git merge-tree` itself.
#[tokio::test]
async fn a_simulation_can_start_at_any_commit() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.checkout_new("seite");
    let seite = repo.commit_file("f.txt", "eins\nZWEI seite\ndrei\n", "Seite ändert Zeile 2");
    repo.checkout("main");
    repo.checkout_new("sauber");
    let sauber = repo.commit_file("g.txt", "neu\n", "Neue Datei g");
    repo.checkout("main");
    let main = repo.commit_file("f.txt", "eins\nzwei main\ndrei\n", "Main ändert Zeile 2");
    repo.checkout("sauber");
    let cancel = CancelToken::new();

    let from_seite = repo.git_output(&["merge-tree", "--write-tree", "--name-only", "--no-messages", &seite, &main]);
    assert_eq!(from_seite.status.code(), Some(1), "git itself: seite and main conflict");
    let from_sauber = repo.git_output(&["merge-tree", "--write-tree", "--name-only", "--no-messages", &sauber, &main]);
    assert_eq!(from_sauber.status.code(), Some(0), "git itself: sauber and main merge cleanly");

    assert_eq!(simulate(&tc, &id, &cancel, "HEAD", merge_op(&main)).await.unwrap(), ConflictPreview::Clean, "HEAD is sauber");
    assert_eq!(simulate(&tc, &id, &cancel, &seite, merge_op(&main)).await.unwrap(), conflicts(&["f.txt"], None));
    assert!(
        matches!(simulate(&tc, &id, &cancel, "--output=/tmp/x", merge_op(&main)).await.unwrap(), ConflictPreview::Unknown { .. }),
        "a start with a leading dash is never passed to Git"
    );
    if tc.git.info().unwrap().version >= (2, 40, 0) {
        assert_eq!(
            simulate(&tc, &id, &cancel, &seite, PreviewOp::CherryPick { commits: vec![main.clone()] }).await.unwrap(),
            conflicts(&["f.txt"], Some(main.as_str()))
        );
        let rebase = PreviewOp::Rebase { onto: main.clone(), upstream: None, branch: None, commits: None };
        assert_eq!(simulate(&tc, &id, &cancel, &sauber, rebase).await.unwrap(), ConflictPreview::Clean, "sauber's own commit replays onto main");
    }
    assert_eq!(repo.current_branch(), "sauber");
    assert_eq!(repo.head(), sauber);
    assert_eq!(repo.git(&["status", "--porcelain"]), "", "simulating changes nothing");
}

/// `total` lines "line n"; lines `from..=to` read "<side> n" instead.
fn numbered(total: u32, from: u32, to: u32, side: &str) -> String {
    (1..=total).map(|n| if n >= from && n <= to { format!("{side} {n}\n") } else { format!("line {n}\n") }).collect()
}

#[tokio::test]
async fn merge_tree_with_ranges_reads_the_marker_lines_of_each_conflicted_file() {
    let (tc, repo, id) = setup().await;
    repo.write_file("src/auth.ts", numbered(80, 0, 0, ""));
    repo.write_file("-Größe übersicht.txt", "eins\r\nzwei\r\ndrei\r\n");
    repo.write_file("bild.bin", b"\x00\x01basis");
    let base = repo.commit("Basis");
    repo.checkout_new("seite-a");
    repo.write_file("src/auth.ts", numbered(80, 40, 62, "a"));
    repo.write_file("-Größe übersicht.txt", "eins\r\nzwei\r\nDREI a\r\n");
    repo.write_file("bild.bin", b"\x00\x02a");
    let a = repo.commit("Seite A");
    repo.git(&["checkout", "-q", "-b", "seite-b", &base]);
    repo.write_file("src/auth.ts", numbered(80, 40, 62, "b"));
    repo.write_file("-Größe übersicht.txt", "eins\r\nzwei\r\ndrei b\r\n");
    repo.write_file("bild.bin", b"\x00\x03b");
    let b = repo.commit("Seite B");
    let cancel = CancelToken::new();
    let conflict = |path: &str, ranges: Vec<LineRange>| MergedConflict { path: path.to_string(), raw_path: path.as_bytes().to_vec(), ranges };
    // Lines 40–62 of src/auth.ts and line 3 of the CRLF file were changed on both sides (fixture);
    // the binary file conflicts as a whole and has no lines.
    let expected = vec![
        conflict("-Größe übersicht.txt", vec![LineRange { start: 3, end: 3 }]),
        conflict("bild.bin", vec![]),
        conflict("src/auth.ts", vec![LineRange { start: 40, end: 62 }]),
    ];

    let Merged::Conflicts { tree, files } = merge_tree(&tc, &id, &cancel, Some(base.as_str()), &a, &b, true).await.unwrap() else {
        panic!("conflicts expected")
    };
    assert_eq!(files, expected);
    // The ranges were read from the result tree, which holds the file with markers.
    let merged = repo.git(&["cat-file", "blob", &format!("{tree}:src/auth.ts")]);
    assert!(merged.contains("<<<<<<< ") && merged.contains("a 40\n") && merged.contains("b 62\n"), "{merged}");

    // Without the option: the same files, no ranges.
    let Merged::Conflicts { files: plain, .. } = merge_tree(&tc, &id, &cancel, Some(base.as_str()), &a, &b, false).await.unwrap() else {
        panic!("conflicts expected")
    };
    assert_eq!(plain.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["-Größe übersicht.txt", "bild.bin", "src/auth.ts"]);
    assert!(plain.iter().all(|f| f.ranges.is_empty()));

    // A repository configured for diff3 and a merge base Git finds itself give the same ranges.
    repo.git(&["config", "merge.conflictStyle", "diff3"]);
    let Merged::Conflicts { files: diff3, .. } = merge_tree(&tc, &id, &cancel, None, &a, &b, true).await.unwrap() else {
        panic!("conflicts expected")
    };
    assert_eq!(diff3, expected);

    // Nothing changed.
    assert_eq!(repo.current_branch(), "seite-b");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}
