//! Units of "Compose commits": what `compose_units` lists, checked against Git's own diff of the
//! same fixtures (hunk headers, numstat), never against the implementation's own formulas.

use std::collections::BTreeMap;

use super::units::MAX_UNIT_LINES;
use super::*;
use crate::commands::trust::repo_trust_set;
use crate::error::ErrorCode;
use crate::model::{ComposeUnitKind, DiffLineKind};
use crate::testkit::{TestCore, TestRepo};

pub(super) async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

/// 20 numbered lines; lines 2 and 18 are far enough apart for two hunks.
pub(super) fn twenty() -> String {
    (1..=20).map(|n| format!("zeile {n}\n")).collect()
}

pub(super) fn two_hunks() -> String {
    twenty().replace("zeile 2\n", "Zeile zwei\n").replace("zeile 18\n", "Zeile achtzehn\n")
}

/// Writes an executable hook. Hooks are written before the repository is opened: `TestCore::open`
/// then agrees to the trust prompt as the user would.
pub(super) fn write_hook(repo: &TestRepo, name: &str, body: &str) {
    let dir = repo.path().join(".git").join("hooks");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// Every kind of whole-file unit that works on every platform: a rename with an edit, a deletion,
/// a new text file, a new binary, a file under `filter=lfs` and a submodule with a new commit.
pub(super) fn mixed_repo() -> TestRepo {
    let repo = TestRepo::with_commit();
    let ten: String = (1..=10).map(|n| format!("Zeile {n} des alten Namens\n")).collect();
    repo.commit_file("alt/name.txt", &ten, "Alter Name");
    repo.commit_file("weg.txt", "wird gelöscht\n", "Weg");
    repo.write_file(".gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\n");
    repo.commit_file("bild.psd", "alte Ebene\n", "LFS-Bild");
    let sub = repo.subdir("lib/sub");
    let in_sub = |args: &[&str]| {
        let mut all = vec!["-C", "lib/sub", "-c", "user.name=Sub", "-c", "user.email=sub@example.com"];
        all.extend_from_slice(args);
        repo.git(&all)
    };
    in_sub(&["init", "-q", "-b", "main"]);
    std::fs::write(sub.join("x.txt"), "x\n").unwrap();
    in_sub(&["add", "x.txt"]);
    in_sub(&["commit", "-q", "-m", "eins"]);
    repo.git(&["add", "lib/sub"]);
    repo.git(&["commit", "-q", "-m", "Submodul"]);

    repo.subdir("neu");
    repo.git(&["mv", "alt/name.txt", "neu/näme.txt"]);
    repo.write_file("neu/näme.txt", ten.replace("Zeile 1 des", "Zeile eins des"));
    repo.remove_file("weg.txt");
    repo.write_file("notizen/über uns.md", "# Über uns\n");
    repo.write_file("bild.bin", [0u8, 159, 146, 150, 0, 255]);
    repo.write_file("bild.psd", "neue Ebene\n");
    std::fs::write(sub.join("x.txt"), "y\n").unwrap();
    in_sub(&["commit", "-q", "-am", "zwei"]);
    repo
}

#[tokio::test]
async fn text_files_split_into_the_hunks_git_shows() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig Zeilen");
    repo.write_file("a.txt", two_hunks());
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id).await.unwrap();

    let headers: Vec<String> = state.units.iter().map(|u| u.header.clone()).collect();
    let git: Vec<String> = repo.git(&["diff", "HEAD", "--", "a.txt"]).lines().filter(|l| l.starts_with("@@")).map(str::to_string).collect();
    assert_eq!(headers, vec!["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@ zeile 14"]);
    assert_eq!(headers, git, "the same hunks as `git diff HEAD`");

    let first = &state.units[0];
    assert_eq!((first.kind, first.hunk_index, first.added, first.removed), (ComposeUnitKind::Hunk, Some(0), 1, 1));
    assert!(first.id.starts_with("a.txt#0@") && state.units[1].id.starts_with("a.txt#1@"), "{first:?}");
    let shown: Vec<(DiffLineKind, Option<u32>, Option<u32>, &str)> = first.lines.iter().map(|l| (l.kind, l.old_no, l.new_no, l.text.as_str())).collect();
    assert_eq!(shown[0], (DiffLineKind::Context, Some(1), Some(1), "zeile 1"));
    assert_eq!(shown[1], (DiffLineKind::Remove, Some(2), None, "zeile 2"));
    assert_eq!(shown[2], (DiffLineKind::Add, None, Some(2), "Zeile zwei"));
    assert_eq!(state.branch, "main");
    assert_eq!(state.head, repo.head());
    assert!(!state.signing);
}

#[tokio::test]
async fn new_deleted_renamed_binary_lfs_and_submodule_files_are_whole_units() {
    let repo = mixed_repo();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id).await.unwrap();

    let kinds: BTreeMap<String, (Option<String>, ComposeUnitKind)> = state.units.iter().map(|u| (u.path.clone(), (u.old_path.clone(), u.kind))).collect();
    let expected: BTreeMap<String, (Option<String>, ComposeUnitKind)> = [
        ("bild.bin", None, ComposeUnitKind::Binary),
        ("bild.psd", None, ComposeUnitKind::Lfs),
        ("lib/sub", None, ComposeUnitKind::Submodule),
        ("neu/näme.txt", Some("alt/name.txt"), ComposeUnitKind::Renamed),
        ("notizen/über uns.md", None, ComposeUnitKind::Added),
        ("weg.txt", None, ComposeUnitKind::Deleted),
    ]
    .into_iter()
    .map(|(path, old, kind)| (path.to_string(), (old.map(str::to_string), kind)))
    .collect();
    assert_eq!(kinds, expected);
    assert_eq!(state.units.len(), 6, "one unit per whole file");
    for unit in &state.units {
        assert_eq!(unit.hunk_index, None, "{}", unit.path);
        assert!(unit.id.starts_with(&format!("{}#file@", unit.path)), "{}", unit.id);
    }
    let added = state.units.iter().find(|u| u.path == "notizen/über uns.md").unwrap();
    assert_eq!(added.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["# Über uns"], "a new text file shows its content");
}

#[cfg(unix)]
#[tokio::test]
async fn mode_changes_and_symlinks_are_whole_units() {
    use std::os::unix::fs::PermissionsExt;
    let repo = TestRepo::with_commit();
    repo.commit_file("skript.sh", "#!/bin/sh\necho hallo\n", "Skript");
    std::fs::set_permissions(repo.path().join("skript.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("README.md", repo.path().join("verweis")).unwrap();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id).await.unwrap();
    let kinds: Vec<(&str, ComposeUnitKind)> = state.units.iter().map(|u| (u.path.as_str(), u.kind)).collect();
    assert_eq!(kinds, vec![("skript.sh", ComposeUnitKind::Mode), ("verweis", ComposeUnitKind::Link)]);
}

#[tokio::test]
async fn odd_paths_keep_their_names() {
    let repo = TestRepo::with_commit();
    repo.commit_file("-führend #1@home.txt", "eins\n", "Strich");
    repo.commit_file("[x] notiz.md", "zwei\n", "Klammer");
    repo.write_file("-führend #1@home.txt", "EINS\n");
    repo.write_file("[x] notiz.md", "ZWEI\n");
    repo.write_file("mit leerzeichen/ä ö.txt", "neu\n");
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id).await.unwrap();
    let paths: Vec<&str> = state.units.iter().map(|u| u.path.as_str()).collect();
    assert_eq!(paths, vec!["-führend #1@home.txt", "[x] notiz.md", "mit leerzeichen/ä ö.txt"]);
    assert!(state.units[0].id.starts_with("-führend #1@home.txt#0@"), "{}", state.units[0].id);
    assert!(state.units[2].id.starts_with("mit leerzeichen/ä ö.txt#file@"), "{}", state.units[2].id);
}

#[tokio::test]
async fn a_huge_hunk_is_cut_for_display_only() {
    let repo = TestRepo::with_commit();
    let old: String = (1..=3000).map(|n| format!("alt {n}\n")).collect();
    repo.commit_file("gross.txt", &old, "Groß");
    repo.write_file("gross.txt", (1..=3000).map(|n| format!("neu {n}\n")).collect::<String>());
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id).await.unwrap();
    assert_eq!(repo.git(&["diff", "--numstat", "HEAD", "--", "gross.txt"]), "3000\t3000\tgross.txt", "Git's own count");
    let [unit] = state.units.as_slice() else { panic!("one hunk, got {}", state.units.len()) };
    assert_eq!((unit.added, unit.removed), (3000, 3000));
    assert_eq!(unit.lines.len(), MAX_UNIT_LINES);
    assert!(unit.lines_cut);
}

#[tokio::test]
async fn the_token_follows_head_index_and_working_directory() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.write_file("a.txt", two_hunks());
    let (tc, id) = open(&repo).await;
    let first = compose_units(&tc, id.clone()).await.unwrap();
    assert_eq!(compose_units(&tc, id.clone()).await.unwrap().token, first.token, "nothing changed");

    repo.git(&["add", "a.txt"]);
    let staged = compose_units(&tc, id.clone()).await.unwrap();
    assert_ne!(staged.token, first.token, "the index changed");
    let ids = |state: &ComposeState| state.units.iter().map(|u| u.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&staged), ids(&first), "the same changes keep their IDs");

    repo.write_file("neu.txt", "neu\n");
    let untracked = compose_units(&tc, id.clone()).await.unwrap();
    assert_ne!(untracked.token, staged.token, "a new untracked file");

    repo.git(&["commit", "-q", "-m", "Zwischenstand"]);
    let committed = compose_units(&tc, id).await.unwrap();
    assert_ne!(committed.token, untracked.token, "HEAD moved");
    assert_eq!(committed.head, repo.head());
}

#[tokio::test]
async fn unborn_detached_conflicted_and_untrusted_repositories_are_refused() {
    let fresh = TestRepo::new();
    fresh.write_file("a.txt", "a\n");
    let (tc, id) = open(&fresh).await;
    assert_eq!(compose_units(&tc, id).await.unwrap_err().code, ErrorCode::NotAllowed, "unborn branch");

    let detached = TestRepo::with_commit();
    detached.git(&["checkout", "-q", "--detach"]);
    detached.write_file("README.md", "geändert\n");
    let (tc, id) = open(&detached).await;
    assert_eq!(compose_units(&tc, id).await.unwrap_err().code, ErrorCode::NotAllowed, "detached HEAD");

    let conflicted = TestRepo::with_commit();
    conflicted.checkout_new("seite");
    conflicted.commit_file("README.md", "seite\n", "Seite");
    conflicted.checkout("main");
    conflicted.commit_file("README.md", "haupt\n", "Haupt");
    assert!(!conflicted.merge("seite"), "the fixture conflicts");
    let (tc, id) = open(&conflicted).await;
    assert_eq!(compose_units(&tc, id).await.unwrap_err().code, ErrorCode::Conflict);

    let untrusted = TestRepo::with_commit();
    untrusted.write_file("README.md", "x\n");
    let (tc, id) = open(&untrusted).await;
    repo_trust_set(&tc, id.clone(), false).await.unwrap();
    assert_eq!(compose_units(&tc, id).await.unwrap_err().code, ErrorCode::RepoUntrusted);
}
