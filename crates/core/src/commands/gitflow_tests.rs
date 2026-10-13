//! Tests for Gitflow against real repositories.

use super::*;
use crate::commands::merge::{conflict_resolve, operation_continue};
use crate::commands::undo::{redo, undo, undo_peek};
use crate::events::names;
use crate::model::ConflictSide;
use crate::testkit::{TestCore, TestRepo};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

async fn init(tc: &TestCore, id: &str) -> GitflowStatus {
    gitflow_init(tc, id.to_string(), "main".into(), "develop".into(), None).await.unwrap()
}

fn options() -> Option<GitflowFinishOptions> {
    Some(GitflowFinishOptions::default())
}

fn parents(repo: &TestRepo, rev: &str) -> Vec<String> {
    repo.git(&["log", "-1", "--format=%P", rev]).split_whitespace().map(str::to_string).collect()
}

fn exists(repo: &TestRepo, name: &str) -> bool {
    repo.git_output(&["rev-parse", "-q", "--verify", name]).status.success()
}

#[tokio::test]
async fn status_suggests_and_init_writes_the_usual_keys() {
    let (tc, repo, id) = setup().await;
    let before = gitflow_status(&tc, id.clone()).await.unwrap();
    assert!(!before.initialized);
    assert_eq!((before.main.as_str(), before.develop.as_str()), ("main", "develop"));
    assert_eq!(before.prefixes, GitflowPrefixes::default());
    assert!(before.active.is_empty());
    tc.events.clear();

    let state = init(&tc, &id).await;
    assert!(state.initialized);
    assert_eq!(repo.git(&["config", "--local", "gitflow.branch.master"]), "main");
    assert_eq!(repo.git(&["config", "--local", "gitflow.branch.develop"]), "develop");
    assert_eq!(repo.git(&["config", "--local", "gitflow.prefix.feature"]), "feature/");
    assert_eq!(repo.git(&["config", "--local", "gitflow.prefix.release"]), "release/");
    assert_eq!(repo.git(&["config", "--local", "gitflow.prefix.hotfix"]), "hotfix/");
    assert_eq!(repo.git(&["config", "--local", "gitflow.prefix.versiontag"]), "");
    // So that `git flow` itself considers the setup complete.
    assert_eq!(repo.git(&["config", "--local", "gitflow.prefix.bugfix"]), "bugfix/");
    assert_eq!(repo.git(&["config", "--local", "gitflow.prefix.support"]), "support/");
    assert_eq!(repo.git(&["rev-parse", "develop"]), repo.head(), "develop is created from the main branch");
    assert_eq!(repo.current_branch(), "main", "HEAD stays");
    assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["refs", "config"]));

    // Own prefixes; a second setup overwrites.
    let custom = GitflowPrefixes { feature: "feat/".into(), release: "rel/".into(), hotfix: "fix/".into(), version_tag: "v".into() };
    let state = gitflow_init(&tc, id.clone(), "main".into(), "develop".into(), Some(custom.clone())).await.unwrap();
    assert_eq!(state.prefixes, custom);
    assert_eq!(repo.git(&["config", "--local", "gitflow.prefix.versiontag"]), "v");
}

#[tokio::test]
async fn an_existing_setup_from_the_command_line_tool_is_recognized() {
    let (tc, repo, id) = setup().await;
    repo.branch("entwicklung");
    repo.branch("thema/eins");
    repo.branch("release/1.0");
    repo.branch("feature/nicht-gemeint");
    for (key, value) in [
        ("gitflow.branch.master", "main"),
        ("gitflow.branch.develop", "entwicklung"),
        ("gitflow.prefix.feature", "thema/"),
        ("gitflow.prefix.release", "release/"),
        ("gitflow.prefix.hotfix", "hotfix/"),
        ("gitflow.prefix.versiontag", "v"),
    ] {
        repo.git(&["config", key, value]);
    }
    let state = gitflow_status(&tc, id).await.unwrap();
    assert!(state.initialized);
    assert_eq!(state.develop, "entwicklung");
    assert_eq!(state.prefixes.feature, "thema/");
    assert_eq!(state.prefixes.version_tag, "v");
    let active: Vec<(GitflowKind, &str, &str)> = state.active.iter().map(|a| (a.kind, a.name.as_str(), a.branch.as_str())).collect();
    assert_eq!(active, vec![(GitflowKind::Release, "1.0", "release/1.0"), (GitflowKind::Feature, "eins", "thema/eins")]);
}

#[tokio::test]
async fn init_refuses_bad_input() {
    let (tc, repo, id) = setup().await;
    let err = gitflow_init(&tc, id.clone(), "main".into(), "main".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = gitflow_init(&tc, id.clone(), "gibt-es-nicht".into(), "develop".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let err = gitflow_init(&tc, id.clone(), "main".into(), "mit leer".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    let same = GitflowPrefixes { feature: "x/".into(), release: "x/".into(), ..GitflowPrefixes::default() };
    let err = gitflow_init(&tc, id.clone(), "main".into(), "develop".into(), Some(same)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    let empty = GitflowPrefixes { hotfix: " ".into(), ..GitflowPrefixes::default() };
    let err = gitflow_init(&tc, id.clone(), "main".into(), "develop".into(), Some(empty)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    assert!(!exists(&repo, "refs/heads/develop"), "nothing created");
    assert!(!gitflow_status(&tc, id.clone()).await.unwrap().initialized);

    // Does not work without a commit.
    let fresh = TestRepo::new();
    let fresh_id = tc.open(&fresh).await.repo.id;
    let err = gitflow_init(&tc, fresh_id, "main".into(), "develop".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);

    // Starting and finishing without a setup.
    let err = gitflow_start(&tc, id.clone(), GitflowKind::Feature, "x".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("set up"), "{}", err.message);
    let err = gitflow_finish(&tc, id, GitflowKind::Feature, "x".into(), None, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
}

#[tokio::test]
async fn start_uses_the_right_base_and_is_undoable() {
    let (tc, repo, id) = setup().await;
    init(&tc, &id).await;
    repo.checkout("develop");
    let develop = repo.commit_file("d.txt", "d\n", "Auf develop");
    repo.checkout("main");
    let main = repo.head();
    tc.events.clear();

    let state = gitflow_start(&tc, id.clone(), GitflowKind::Feature, "anmeldung".into(), None).await.unwrap();
    assert_eq!(repo.current_branch(), "feature/anmeldung");
    assert_eq!(repo.head(), develop, "feature starts on develop");
    assert_eq!(state.active.len(), 1);
    assert_eq!(state.active[0].branch, "feature/anmeldung");
    assert_eq!(tc.events.named(names::REPO_CHANGED).len(), 1);

    gitflow_start(&tc, id.clone(), GitflowKind::Hotfix, "1.0.1".into(), None).await.unwrap();
    assert_eq!(repo.current_branch(), "hotfix/1.0.1");
    assert_eq!(repo.head(), main, "hotfix starts on the main branch");
    gitflow_start(&tc, id.clone(), GitflowKind::Release, "1.1".into(), Some(main.clone())).await.unwrap();
    assert_eq!(repo.head(), main, "own starting point");

    // At most one release and one hotfix at a time; names are checked.
    let err = gitflow_start(&tc, id.clone(), GitflowKind::Release, "1.2".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("release/1.1"), "{}", err.message);
    let err = gitflow_start(&tc, id.clone(), GitflowKind::Feature, "anmeldung".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NameExists);
    let err = gitflow_start(&tc, id.clone(), GitflowKind::Feature, "mit leer".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    let err = gitflow_start(&tc, id.clone(), GitflowKind::Feature, "  ".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    let err = gitflow_start(&tc, id.clone(), GitflowKind::Feature, "y".into(), Some("gibt-es-nicht".into())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    // Undo takes back the last start: branch gone, HEAD back where it was before.
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "hotfix/1.0.1");
    assert!(!exists(&repo, "refs/heads/release/1.1"));
}

#[tokio::test]
async fn feature_finish_merges_into_develop_and_undo_restores_everything() {
    let (tc, repo, id) = setup().await;
    init(&tc, &id).await;
    gitflow_start(&tc, id.clone(), GitflowKind::Feature, "suche".into(), None).await.unwrap();
    let feature = repo.commit_file("suche.txt", "s\n", "Suche gebaut");
    let develop_before = repo.git(&["rev-parse", "develop"]);
    tc.events.clear();

    let result = gitflow_finish(&tc, id.clone(), GitflowKind::Feature, "suche".into(), options(), None).await.unwrap();
    let OpResult::Done { sha, summary, .. } = result else { panic!("{result:?}") };
    assert_eq!(summary, "Feature “suche” finished: merged into develop, deleted branch");
    assert_eq!(repo.current_branch(), "develop");
    let merge = repo.head();
    assert_eq!(sha.as_deref(), Some(merge.as_str()));
    assert_eq!(parents(&repo, "HEAD"), vec![develop_before.clone(), feature.clone()], "always a merge commit");
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Merge branch 'feature/suche' into develop");
    assert!(!exists(&repo, "refs/heads/feature/suche"));
    assert!(repo.path().join("suche.txt").exists());
    assert_eq!(tc.events.named(names::REPO_CHANGED).len(), 1);
    let entries: i64 = tc.db.with(|c| Ok(c.query_row("select count(*) from undo_entries where state = 'done'", [], |r| r.get(0))?)).unwrap();
    assert_eq!(entries, 2, "start and finish: one step each");

    let state = undo_peek(&tc, id.clone()).await.unwrap();
    assert_eq!(state.undo.unwrap().label, "Undo finishing feature ‘suche’");
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "feature/suche", "HEAD back on the feature");
    assert_eq!(repo.head(), feature);
    assert_eq!(repo.git(&["rev-parse", "develop"]), develop_before);
    assert_eq!(repo.git(&["status", "--porcelain"]), "");

    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "develop");
    assert_eq!(repo.head(), merge);
    assert!(!exists(&repo, "refs/heads/feature/suche"));

    // Finish once more: the branch no longer exists.
    let err = gitflow_finish(&tc, id, GitflowKind::Feature, "suche".into(), options(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn release_finish_merges_tags_and_merges_back() {
    let (tc, repo, id) = setup().await;
    let custom = GitflowPrefixes { version_tag: "v".into(), ..GitflowPrefixes::default() };
    gitflow_init(&tc, id.clone(), "main".into(), "develop".into(), Some(custom)).await.unwrap();
    repo.checkout("develop");
    repo.commit_file("a.txt", "a\n", "Arbeit auf develop");
    gitflow_start(&tc, id.clone(), GitflowKind::Release, "1.2.0".into(), None).await.unwrap();
    let release = repo.commit_file("version.txt", "1.2.0\n", "Version 1.2.0");
    let (main_before, develop_before) = (repo.git(&["rev-parse", "main"]), repo.git(&["rev-parse", "develop"]));

    let finish = GitflowFinishOptions { message: Some("Erste öffentliche Fassung".into()), delete_branch: false, ..GitflowFinishOptions::default() };
    let result = gitflow_finish(&tc, id.clone(), GitflowKind::Release, "1.2.0".into(), Some(finish), None).await.unwrap();
    let OpResult::Done { summary, .. } = &result else { panic!("{result:?}") };
    assert_eq!(summary, "Release “1.2.0” finished: merged into main, created tag “v1.2.0”, merged into develop");
    assert_eq!(repo.current_branch(), "develop");
    let main_after = repo.git(&["rev-parse", "main"]);
    assert_eq!(parents(&repo, "main"), vec![main_before.clone(), release.clone()]);
    assert_eq!(parents(&repo, "develop"), vec![develop_before.clone(), release.clone()]);
    assert_eq!(repo.git(&["cat-file", "-t", "refs/tags/v1.2.0"]), "tag", "annotated tag");
    assert_eq!(repo.git(&["rev-parse", "v1.2.0^{commit}"]), main_after);
    assert_eq!(repo.git(&["tag", "-l", "--format=%(contents)", "v1.2.0"]).trim(), "Erste öffentliche Fassung");
    assert!(exists(&repo, "refs/heads/release/1.2.0"), "deleteBranch: false leaves the branch in place");

    // One undo takes back everything: both merges and the tag.
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "release/1.2.0");
    assert_eq!(repo.git(&["rev-parse", "main"]), main_before);
    assert_eq!(repo.git(&["rev-parse", "develop"]), develop_before);
    assert!(!exists(&repo, "refs/tags/v1.2.0"));
    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "main"]), main_after);
    assert_eq!(repo.git(&["cat-file", "-t", "refs/tags/v1.2.0"]), "tag");
    assert_eq!(repo.current_branch(), "develop");

    // Second call: everything already done.
    let again = GitflowFinishOptions { delete_branch: false, ..GitflowFinishOptions::default() };
    assert_eq!(gitflow_finish(&tc, id, GitflowKind::Release, "1.2.0".into(), Some(again), None).await.unwrap(), OpResult::UpToDate);
}

#[tokio::test]
async fn hotfix_finish_with_own_tag_name_and_without_tag() {
    let (tc, repo, id) = setup().await;
    init(&tc, &id).await;
    gitflow_start(&tc, id.clone(), GitflowKind::Hotfix, "1.0.1".into(), None).await.unwrap();
    repo.commit_file("fix.txt", "f\n", "Fehler behoben");
    let finish = GitflowFinishOptions { tag: Some("stand-1.0.1".into()), ..GitflowFinishOptions::default() };
    let result = gitflow_finish(&tc, id.clone(), GitflowKind::Hotfix, "1.0.1".into(), Some(finish), None).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(repo.git(&["rev-parse", "stand-1.0.1^{commit}"]), repo.git(&["rev-parse", "main"]));
    assert_eq!(repo.git(&["tag", "-l", "--format=%(contents:subject)", "stand-1.0.1"]), "Hotfix 1.0.1");
    assert!(!exists(&repo, "refs/heads/hotfix/1.0.1"));
    assert!(repo.git(&["branch", "--contains", "stand-1.0.1"]).contains("develop") || repo.path().join("fix.txt").exists());

    gitflow_start(&tc, id.clone(), GitflowKind::Hotfix, "1.0.2".into(), None).await.unwrap();
    repo.commit_file("fix2.txt", "f\n", "Noch ein Fehler");
    let finish = GitflowFinishOptions { no_tag: true, ..GitflowFinishOptions::default() };
    gitflow_finish(&tc, id.clone(), GitflowKind::Hotfix, "1.0.2".into(), Some(finish), None).await.unwrap();
    assert_eq!(repo.git(&["tag", "-l"]), "stand-1.0.1", "no further tag");

    // A tag that already exists prevents the finish before anything is merged.
    gitflow_start(&tc, id.clone(), GitflowKind::Hotfix, "1.0.3".into(), None).await.unwrap();
    repo.commit_file("fix3.txt", "f\n", "Dritter Fehler");
    let main_before = repo.git(&["rev-parse", "main"]);
    let finish = GitflowFinishOptions { tag: Some("stand-1.0.1".into()), ..GitflowFinishOptions::default() };
    let err = gitflow_finish(&tc, id, GitflowKind::Hotfix, "1.0.3".into(), Some(finish), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NameExists);
    assert_eq!(repo.git(&["rev-parse", "main"]), main_before);
    assert_eq!(repo.current_branch(), "hotfix/1.0.3");
}

#[tokio::test]
async fn conflict_stops_like_a_merge_and_a_second_call_finishes() {
    let (tc, repo, id) = setup().await;
    init(&tc, &id).await;
    gitflow_start(&tc, id.clone(), GitflowKind::Release, "2.0".into(), None).await.unwrap();
    let release = repo.commit_file("README.md", "# Release\n", "README für das Release");
    // develop moves on in the meantime and changes the same line: the merge back conflicts.
    repo.checkout("develop");
    repo.commit_file("README.md", "# Entwicklung\n", "README auf develop");
    repo.checkout("release/2.0");
    let main_before = repo.git(&["rev-parse", "main"]);

    let result = gitflow_finish(&tc, id.clone(), GitflowKind::Release, "2.0".into(), options(), None).await.unwrap();
    let OpResult::Conflict { files, operation, note } = result else { panic!("{result:?}") };
    assert_eq!(files, vec!["README.md".to_string()]);
    assert_eq!(operation.unwrap().kind, crate::model::OperationKind::Merge);
    let note = note.unwrap();
    assert!(note.contains("“develop”") && note.contains("again"), "{note}");
    // The first part is done: main merged and tagged.
    assert_eq!(parents(&repo, "main"), vec![main_before.clone(), release.clone()]);
    assert_eq!(repo.git(&["rev-parse", "2.0^{commit}"]), repo.git(&["rev-parse", "main"]));
    assert!(exists(&repo, "refs/heads/release/2.0"));

    // While the merge is open, no second finish is possible.
    let err = gitflow_finish(&tc, id.clone(), GitflowKind::Release, "2.0".into(), options(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::OperationInProgress);

    conflict_resolve(&tc, id.clone(), "README.md".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    let merged = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    assert!(matches!(merged, OpResult::Done { .. }), "{merged:?}");

    let result = gitflow_finish(&tc, id.clone(), GitflowKind::Release, "2.0".into(), options(), None).await.unwrap();
    let OpResult::Done { summary, .. } = result else { panic!("{result:?}") };
    assert_eq!(summary, "Release “2.0” finished: deleted branch");
    assert!(!exists(&repo, "refs/heads/release/2.0"));
    assert_eq!(repo.current_branch(), "develop");
    assert_eq!(repo.read_file("README.md"), b"# Release\n");

    // Three steps back: deletion, merge into develop, then the first part (main and tag).
    undo(&tc, id.clone()).await.unwrap();
    assert!(exists(&repo, "refs/heads/release/2.0"));
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.read_file("README.md"), b"# Entwicklung\n");
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "main"]), main_before);
    assert!(!exists(&repo, "refs/tags/2.0"));
    assert_eq!(repo.current_branch(), "release/2.0");
}

#[tokio::test]
async fn finish_needs_a_clean_worktree_and_an_existing_branch() {
    let (tc, repo, id) = setup().await;
    init(&tc, &id).await;
    gitflow_start(&tc, id.clone(), GitflowKind::Feature, "x".into(), None).await.unwrap();
    repo.commit_file("x.txt", "x\n", "X");
    repo.write_file("README.md", "# lokal geändert\n");
    let err = gitflow_finish(&tc, id.clone(), GitflowKind::Feature, "x".into(), options(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(repo.current_branch(), "feature/x");
    let err = gitflow_finish(&tc, id.clone(), GitflowKind::Feature, "gibt-es-nicht".into(), options(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let err = gitflow_finish(&tc, id, GitflowKind::Feature, "".into(), options(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn finish_with_push_sends_branches_and_tag() {
    let (tc, repo, id) = setup().await;
    let remote = repo.add_remote();
    init(&tc, &id).await;
    repo.git(&["push", "-q", "-u", "origin", "develop"]);
    gitflow_start(&tc, id.clone(), GitflowKind::Release, "3.0".into(), None).await.unwrap();
    repo.commit_file("v.txt", "3.0\n", "Version 3.0");
    tc.events.clear();

    let finish = GitflowFinishOptions { push: true, ..GitflowFinishOptions::default() };
    let result = gitflow_finish(&tc, id.clone(), GitflowKind::Release, "3.0".into(), Some(finish), Some("job-flow".into())).await.unwrap();
    let OpResult::Done { summary, .. } = result else { panic!("{result:?}") };
    assert!(summary.ends_with("; pushed"), "{summary}");
    assert_eq!(remote.git(&["rev-parse", "refs/heads/main"]), repo.git(&["rev-parse", "main"]));
    assert_eq!(remote.git(&["rev-parse", "refs/heads/develop"]), repo.git(&["rev-parse", "develop"]));
    assert_eq!(remote.git(&["rev-parse", "refs/tags/3.0"]), repo.git(&["rev-parse", "refs/tags/3.0"]));
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!(done.len(), 1);
    assert_eq!(done[0]["jobId"], "job-flow");
    assert_eq!(done[0]["ok"], true);
}
