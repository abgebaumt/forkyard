//! `compose_apply`: the commits are checked with Git itself (blobs byte by byte, `git status`,
//! `git show`, `git ls-files -s`); the expected bytes are literal fixtures.

use super::units_tests::{mixed_repo, open, twenty, two_hunks, write_hook};
use super::*;
use crate::app::Core;
use crate::commands::undo::{redo, undo, undo_peek};
use crate::error::{CoreResult, ErrorCode};
use crate::model::{ComposeGroup, ComposePlan, ComposeResult, ComposeState};
use crate::testkit::TestRepo;
use crate::util;

pub(super) fn commit(title: &str, body: &str, units: &[&str]) -> ComposeGroup {
    ComposeGroup { title: title.to_string(), body: body.to_string(), units: units.iter().map(|unit| unit.to_string()).collect() }
}

pub(super) async fn apply(tc: &Core, id: &str, state: &ComposeState, commits: Vec<ComposeGroup>) -> CoreResult<ComposeResult> {
    compose_apply(tc, id.to_string(), util::new_id(), ComposePlan { commits, skip_hooks: false }, state.token.clone()).await
}

pub(super) fn unit<'a>(state: &'a ComposeState, path: &str, hunk: Option<u32>) -> &'a str {
    state.units.iter().find(|u| u.path == path && u.hunk_index == hunk).map(|u| u.id.as_str()).unwrap_or_else(|| panic!("no unit {path} {hunk:?}"))
}

pub(super) fn backup_refs(repo: &TestRepo) -> String {
    repo.git(&["for-each-ref", "--format=%(refname)", "refs/forkyard/"])
}

fn blob(repo: &TestRepo, spec: &str) -> Vec<u8> {
    repo.git_output(&["show", spec]).stdout
}

#[tokio::test]
async fn hunks_of_one_file_go_into_two_commits_byte_exact() {
    let repo = TestRepo::with_commit();
    let middle: Vec<u8> = (1..=10).flat_map(|n| format!("mitte {n}\r\n").into_bytes()).collect();
    let file = |second: &[u8], last: &[u8]| [b"Kopf\r\n".as_slice(), second, b"\r\n", &middle, b"Fu\xdf\r\n", last].concat();
    let head = file(b"Gr\xfc\xdfe", b"ende");
    let first = file(b"Gr\xfc\xdfe aus K\xf6ln", b"ende");
    let both = file(b"Gr\xfc\xdfe aus K\xf6ln", b"ENDE");
    repo.commit_file("daten.txt", &head, "Daten");
    let base = repo.head();
    repo.write_file("daten.txt", &both);
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    assert_eq!(state.units.len(), 2, "two hunks: line 2 and the last line");

    let result = apply(
        &tc,
        &id,
        &state,
        vec![
            commit("Gruß ergänzen", "", &[unit(&state, "daten.txt", Some(0))]),
            commit("Ende großschreiben", "Zweiter Teil.", &[unit(&state, "daten.txt", Some(1))]),
        ],
    )
    .await
    .unwrap();

    assert_eq!(result.commits.len(), 2);
    assert_eq!(repo.head(), result.commits[1]);
    assert_eq!(repo.git(&["rev-parse", "HEAD~2"]), base);
    assert_eq!(blob(&repo, "HEAD~1:daten.txt"), first, "commit 1 has only the first hunk (CRLF, Latin-1, no final newline)");
    assert_eq!(blob(&repo, "HEAD:daten.txt"), both, "commit 2 has the bytes on disk");
    assert_eq!(repo.read_file("daten.txt"), both, "the working directory is never touched");
    assert_eq!(repo.git(&["status", "--porcelain"]), "", "the index follows HEAD for the committed file");
    assert_eq!(repo.git(&["log", "-1", "--format=%s", "HEAD~1"]), "Gruß ergänzen");
    assert!(repo.git(&["cat-file", "commit", "HEAD"]).ends_with("\n\nEnde großschreiben\n\nZweiter Teil."));
}

#[tokio::test]
async fn unassigned_units_stay_and_other_staged_files_stay_staged() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.commit_file("b.txt", "b\n", "B");
    repo.write_file("a.txt", two_hunks());
    repo.write_file("b.txt", "b gestagt\n");
    repo.git(&["add", "b.txt"]);
    repo.write_file("c.txt", "neu und ungetrackt\n");
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();

    apply(&tc, &id, &state, vec![commit("Zeile zwei", "", &[unit(&state, "a.txt", Some(0))])]).await.unwrap();

    assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "b.txt", "b.txt was not committed and stays staged");
    assert_eq!(repo.git(&["show", "HEAD:a.txt"]), twenty().replace("zeile 2\n", "Zeile zwei\n").trim_end());
    assert_eq!(repo.read_file("a.txt"), two_hunks().as_bytes());
    let rest: Vec<String> = repo
        .git(&["diff", "--", "a.txt"])
        .lines()
        .filter(|l| (l.starts_with('-') || l.starts_with('+')) && !l.starts_with("---") && !l.starts_with("+++"))
        .map(str::to_string)
        .collect();
    assert_eq!(rest, vec!["-zeile 18", "+Zeile achtzehn"], "the second hunk is still an unstaged change");
    assert_eq!(repo.git(&["status", "--porcelain", "--", "c.txt"]), "?? c.txt");
}

#[tokio::test]
async fn whole_files_are_committed_as_they_are() {
    let repo = mixed_repo();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let all: Vec<&str> = state.units.iter().map(|u| u.id.as_str()).collect();

    apply(&tc, &id, &state, vec![commit("Alles auf einmal", "", &all)]).await.unwrap();

    assert_eq!(repo.git(&["status", "--porcelain"]), "", "everything is committed");
    let names: Vec<String> = repo.git(&["-c", "core.quotePath=false", "show", "--name-status", "--format=", "-M", "HEAD"]).lines().map(str::to_string).collect();
    for expected in ["A\tbild.bin", "M\tbild.psd", "M\tlib/sub", "A\tnotizen/über uns.md", "D\tweg.txt"] {
        assert!(names.iter().any(|line| line == expected), "{expected} in {names:?}");
    }
    assert!(names.iter().any(|line| line.starts_with('R') && line.ends_with("\talt/name.txt\tneu/näme.txt")), "{names:?}");
    assert_eq!(repo.git(&["rev-parse", "HEAD:bild.bin"]), repo.git(&["hash-object", "bild.bin"]));
    assert_eq!(repo.git(&["rev-parse", "HEAD:lib/sub"]), repo.git(&["-C", "lib/sub", "rev-parse", "HEAD"]));
}

#[tokio::test]
async fn odd_paths_are_committed_literally() {
    let repo = TestRepo::with_commit();
    repo.commit_file("-führend #1@home.txt", "eins\n", "Strich");
    repo.commit_file("[x] notiz.md", "zwei\n", "Klammer");
    repo.commit_file("x notiz.md", "nicht anfassen\n", "Ähnlich");
    repo.write_file("-führend #1@home.txt", "EINS\n");
    repo.write_file("[x] notiz.md", "ZWEI\n");
    repo.write_file("mit leerzeichen/ä ö.txt", "neu\n");
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let all: Vec<&str> = state.units.iter().map(|u| u.id.as_str()).collect();

    apply(&tc, &id, &state, vec![commit("Sonderzeichen", "", &all)]).await.unwrap();

    assert_eq!(repo.git(&["status", "--porcelain"]), "");
    assert_eq!(repo.git(&["show", "HEAD:-führend #1@home.txt"]), "EINS");
    assert_eq!(repo.git(&["show", "HEAD:x notiz.md"]), "nicht anfassen", "a glob pathspec would have matched it");
    assert_eq!(repo.git(&["rev-list", "--count", "HEAD"]), "5");
}

#[tokio::test]
async fn a_changed_state_is_stale_and_nothing_is_written() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.write_file("a.txt", two_hunks());
    let base = repo.head();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    repo.write_file("a.txt", "inzwischen anders\n");

    let err = apply(&tc, &id, &state, vec![commit("X", "", &[unit(&state, "a.txt", Some(0))])]).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::StaleState);
    assert_eq!(repo.head(), base);
    assert_eq!(backup_refs(&repo), "");
    assert_eq!(repo.read_file("a.txt"), b"inzwischen anders\n");
}

#[tokio::test]
async fn invalid_plans_are_refused_before_anything_moves() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.write_file("a.txt", two_hunks());
    let base = repo.head();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let first = unit(&state, "a.txt", Some(0));
    let cases: Vec<(Vec<ComposeGroup>, ErrorCode, &str)> = vec![
        (vec![commit("X", "", &["a.txt#7@0123"])], ErrorCode::NotAllowed, "unknown unit"),
        (vec![commit("X", "", &[first]), commit("Y", "", &[first])], ErrorCode::NotAllowed, "a unit twice"),
        (vec![commit("X", "", &[]), commit("Y", "", &[first])], ErrorCode::NotAllowed, "a commit without units"),
        (vec![commit("  ", "", &[first])], ErrorCode::EmptyMessage, "no summary"),
        (Vec::new(), ErrorCode::NothingToCommit, "no commit at all"),
    ];
    for (commits, code, why) in cases {
        let err = apply(&tc, &id, &state, commits).await.unwrap_err();
        assert_eq!(err.code, code, "{why}: {}", err.message);
    }
    assert_eq!(repo.head(), base);
    assert_eq!(backup_refs(&repo), "");
}

#[tokio::test]
async fn one_undo_takes_back_every_commit_and_restores_index_and_files() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.commit_file("b.txt", "b\n", "B");
    repo.write_file("a.txt", two_hunks());
    repo.write_file("b.txt", "b gestagt\n");
    repo.git(&["add", "b.txt"]);
    let base = repo.head();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();

    let result = apply(
        &tc,
        &id,
        &state,
        vec![
            commit("Erster Teil", "", &[unit(&state, "a.txt", Some(0)), unit(&state, "b.txt", Some(0))]),
            commit("Zweiter Teil", "", &[unit(&state, "a.txt", Some(1))]),
        ],
    )
    .await
    .unwrap();
    let label = undo_peek(&tc, id.clone()).await.unwrap().undo.map(|step| step.label).unwrap_or_default();
    assert!(label.contains("2 commits"), "{label}");

    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), base, "one step takes both commits back");
    assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "b.txt", "what was staged is staged again");
    assert_eq!(repo.read_file("a.txt"), two_hunks().as_bytes());

    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), result.commits[1]);
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}

#[tokio::test]
async fn skip_hooks_skips_pre_commit_and_post_commit_runs_per_commit() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.write_file("a.txt", two_hunks());
    write_hook(&repo, "pre-commit", "echo 'immer abgelehnt'\nexit 1");
    write_hook(&repo, "post-commit", "echo ran >> \"$(git rev-parse --git-dir)/post-commit-ran\"");
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let plan = ComposePlan {
        commits: vec![commit("Erster", "", &[unit(&state, "a.txt", Some(0))]), commit("Zweiter", "", &[unit(&state, "a.txt", Some(1))])],
        skip_hooks: true,
    };

    let result = compose_apply(&tc, id, util::new_id(), plan, state.token.clone()).await.unwrap();

    assert_eq!(result.commits.len(), 2);
    assert_eq!(std::fs::read_to_string(repo.path().join(".git").join("post-commit-ran")).unwrap(), "ran\nran\n");
}

#[tokio::test]
async fn a_signing_failure_changes_nothing_and_signing_is_announced() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.write_file("a.txt", two_hunks());
    let missing = repo.temp_dir().join("kein-gpg");
    repo.git(&["config", "commit.gpgsign", "true"]);
    repo.git(&["config", "gpg.program", &missing.to_string_lossy()]);
    let (base, index) = (repo.head(), repo.git(&["ls-files", "-s"]));
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    assert!(state.signing, "the view warns about passphrase prompts");

    let err = apply(&tc, &id, &state, vec![commit("Signiert", "", &[unit(&state, "a.txt", Some(0))])]).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::SigningFailed);
    assert_eq!(repo.head(), base);
    assert_eq!(repo.git(&["ls-files", "-s"]), index);
    assert_eq!(backup_refs(&repo), "", "the snapshot refs are removed again");
}
