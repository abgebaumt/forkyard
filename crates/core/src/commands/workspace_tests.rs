//! Tests for workspaces against real repositories with remotes.

use super::*;
use crate::events::names;
use crate::testkit::{TestCore, TestRemote, TestRepo};

/// Repository with a remote to which a colleague has pushed `commits` new commits ahead.
fn repo_behind(commits: usize) -> (TestRepo, TestRemote, TestRepo) {
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    let colleague = TestRepo::clone_of(&remote);
    for n in 0..commits {
        colleague.commit_file(&format!("neu-{n}.txt"), "x\n", &format!("Vom Kollegen {n}"));
    }
    if commits > 0 {
        colleague.git(&["push", "-q", "origin", "main"]);
    }
    (repo, remote, colleague)
}

fn status_of<'a>(run: &'a WorkspaceRunResult, repo_id: &str) -> &'a WorkspaceRepoResult {
    run.results.iter().find(|r| r.repo_id == repo_id).unwrap_or_else(|| panic!("{repo_id} missing in {run:?}"))
}

#[tokio::test]
async fn save_list_rename_and_delete() {
    let tc = TestCore::new().await;
    let (a, b) = (TestRepo::with_commit(), TestRepo::with_commit());
    let (id_a, id_b) = (tc.open(&a).await.repo.id, tc.open(&b).await.repo.id);
    assert!(workspace_list(&tc).await.unwrap().is_empty());
    tc.events.clear();

    let list = workspace_save(&tc, None, "  Kunden   Nord ".into(), vec![id_b.clone(), id_a.clone(), id_b.clone(), " ".into()]).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Kunden Nord");
    assert_eq!(list[0].repo_ids, vec![id_b.clone(), id_a.clone()], "order is kept, duplicates count once");
    assert_eq!(tc.events.named(names::APP_CHANGED)[0]["what"], serde_json::json!(["workspaces"]));
    let first = list[0].id.clone();

    let list = workspace_save(&tc, None, "andere".into(), vec![]).await.unwrap();
    assert_eq!(list.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["andere", "Kunden Nord"], "sorted by name");

    // Changing replaces name and repositories.
    let list = workspace_save(&tc, Some(first.clone()), "Kunden Süd".into(), vec![id_a.clone()]).await.unwrap();
    let changed = list.iter().find(|w| w.id == first).unwrap();
    assert_eq!((changed.name.as_str(), &changed.repo_ids), ("Kunden Süd", &vec![id_a.clone()]));

    // Errors: name empty, too long, taken; unknown workspace; unknown repository.
    assert_eq!(workspace_save(&tc, None, "  ".into(), vec![]).await.unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(workspace_save(&tc, None, "x".repeat(81), vec![]).await.unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(workspace_save(&tc, None, "andere".into(), vec![]).await.unwrap_err().code, ErrorCode::NameExists);
    assert_eq!(workspace_save(&tc, Some("gibt-es-nicht".into()), "neu".into(), vec![]).await.unwrap_err().code, ErrorCode::NotFound);
    let err = workspace_save(&tc, Some(first.clone()), "Kunden Süd".into(), vec!["unbekannt".into()]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let list = workspace_list(&tc).await.unwrap();
    assert_eq!(list.iter().find(|w| w.id == first).unwrap().repo_ids, vec![id_a.clone()], "unchanged after the error");

    // A forgotten repository drops out of the workspace; a restart keeps everything.
    crate::commands::repos::repo_forget(&tc, id_a).await.unwrap();
    let tc = tc.restart().await;
    let list = workspace_list(&tc).await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().find(|w| w.id == first).unwrap().repo_ids.is_empty());

    let list = workspace_delete(&tc, first.clone()).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(workspace_delete(&tc, first).await.unwrap_err().code, ErrorCode::NotFound);
    assert!(crate::commands::repos::repo_list(&tc).await.unwrap().iter().any(|r| r.id == id_b), "the repositories stay");
}

#[tokio::test]
async fn fetch_runs_through_all_repositories_and_reports_each() {
    let tc = TestCore::new().await;
    let (behind, _remote_a, _colleague_a) = repo_behind(2);
    let (current, _remote_b, _colleague_b) = repo_behind(0);
    let lonely = TestRepo::with_commit();
    let (broken, _remote_c, _colleague_c) = repo_behind(1);
    let missing = broken.temp_dir().join("gibt-es-nicht.git").to_string_lossy().replace('\\', "/");
    broken.git(&["remote", "set-url", "origin", &missing]);
    let gone = TestRepo::with_commit();
    let mut ids = Vec::new();
    for repo in [&behind, &broken, &current, &lonely, &gone] {
        ids.push(tc.open(repo).await.repo.id);
    }
    let gone_path = gone.path().to_path_buf();
    drop(gone);
    assert!(!gone_path.exists());
    let workspace = workspace_save(&tc, None, "alle".into(), ids.clone()).await.unwrap()[0].id.clone();
    let before = behind.git(&["rev-parse", "origin/main"]);
    tc.events.clear();

    let run = workspace_fetch(&tc, "job-ws".into(), workspace.clone()).await.unwrap();
    assert_eq!(run.results.iter().map(|r| r.repo_id.as_str()).collect::<Vec<_>>(), ids.iter().map(String::as_str).collect::<Vec<_>>());
    let statuses: Vec<WorkspaceRepoStatus> = run.results.iter().map(|r| r.status).collect();
    use WorkspaceRepoStatus::*;
    assert_eq!(statuses, vec![Done, Failed, UpToDate, Skipped, Failed], "{run:?}");
    assert_eq!(run.failed, 2);
    // The failure in the middle did not stop the others.
    assert_ne!(behind.git(&["rev-parse", "origin/main"]), before);
    assert_eq!(status_of(&run, &ids[0]).message, "1 ref updated");
    assert!(status_of(&run, &ids[1]).message.contains("origin"), "{run:?}");
    assert_eq!(status_of(&run, &ids[3]).code, Some(ErrorCode::NoRemote));
    assert_eq!(status_of(&run, &ids[4]).code, Some(ErrorCode::PathNotFound));
    assert_eq!(status_of(&run, &ids[0]).name, "repo");

    // Progress per repository under the run's jobId; exactly one job:done.
    let progress = tc.events.named(names::JOB_PROGRESS);
    assert!(progress.iter().all(|p| p["jobId"] == "job-ws"));
    for (id, status) in ids.iter().zip(["done", "failed", "up_to_date", "skipped", "failed"]) {
        let own: Vec<_> = progress.iter().filter(|p| p["repoId"] == id.as_str()).collect();
        assert_eq!(own.first().map(|p| p["phase"].as_str().unwrap()), Some("start"), "{id}");
        assert_eq!(own.last().map(|p| p["phase"].as_str().unwrap()), Some(status), "{id}");
        assert_eq!(own.last().unwrap()["percent"], 100);
    }
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!(done.len(), 1);
    assert_eq!((done[0]["jobId"].as_str(), done[0]["ok"].as_bool(), done[0]["repoId"].is_null()), (Some("job-ws"), Some(true), true));
    // Only the repository with something new reports a change.
    let changed: Vec<_> = tc.events.named(names::REPO_CHANGED).iter().map(|e| e["repoId"].as_str().unwrap().to_string()).collect();
    assert_eq!(changed, vec![ids[0].clone()]);

    assert_eq!(workspace_fetch(&tc, "job-x".into(), "gibt-es-nicht".into()).await.unwrap_err().code, ErrorCode::NotFound);
    // An empty workspace is not an error.
    let empty = workspace_save(&tc, None, "leer".into(), vec![]).await.unwrap().into_iter().find(|w| w.name == "leer").unwrap().id;
    let run = workspace_fetch(&tc, "job-leer".into(), empty).await.unwrap();
    assert!(run.results.is_empty() && run.failed == 0);
}

#[tokio::test]
async fn pull_integrates_per_repository_and_survives_conflicts() {
    let tc = TestCore::new().await;
    let (behind, _remote_a, _colleague_a) = repo_behind(1);
    // Conflict: the colleague and we change the same line.
    let (clash, _remote_b, colleague) = repo_behind(0);
    colleague.commit_file("README.md", "# Kollege\n", "Kollege ändert README");
    colleague.git(&["push", "-q", "origin", "main"]);
    clash.commit_file("README.md", "# Wir\n", "Wir ändern README");
    let (current, _remote_c, _colleague_c) = repo_behind(0);
    // Without upstream: skipped.
    let (detached, _remote_d, _colleague_d) = repo_behind(1);
    detached.checkout_new("ohne-upstream");
    let mut ids = Vec::new();
    for repo in [&clash, &behind, &current, &detached] {
        ids.push(tc.open(repo).await.repo.id);
    }
    let workspace = workspace_save(&tc, None, "pull".into(), ids.clone()).await.unwrap()[0].id.clone();
    tc.events.clear();

    let run = workspace_pull(&tc, "job-pull".into(), workspace.clone(), Some(PullMode::Ff)).await.unwrap();
    use WorkspaceRepoStatus::*;
    assert_eq!(run.results.iter().map(|r| r.status).collect::<Vec<_>>(), vec![Conflict, Done, UpToDate, Skipped], "{run:?}");
    assert_eq!(run.failed, 1);
    assert!(status_of(&run, &ids[0]).message.contains("1 file"), "{run:?}");
    assert_eq!(status_of(&run, &ids[0]).code, Some(ErrorCode::Conflict));
    assert_eq!(status_of(&run, &ids[3]).code, Some(ErrorCode::NoUpstream));
    // The second repository moved ahead despite the conflict in the first.
    assert!(behind.path().join("neu-0.txt").exists());
    assert_eq!(behind.head(), behind.git(&["rev-parse", "origin/main"]));
    assert!(clash.path().join(".git").join("MERGE_HEAD").exists(), "the conflict waits in the repository");
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["ok"].as_bool()), (1, Some(true)));

    // Cancelling ends the whole run with `cancelled` (requested as soon as the job is registered).
    tc.events.clear();
    let jobs = tc.core.jobs.clone();
    let cancel = tokio::spawn(async move {
        for _ in 0..5000 {
            if jobs.cancel("job-stop") {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        false
    });
    let stopped = workspace_fetch(&tc, "job-stop".into(), workspace).await;
    assert!(cancel.await.unwrap(), "the job was never registered");
    assert_eq!(stopped.unwrap_err().code, ErrorCode::Cancelled);
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["ok"].as_bool(), done[0]["cancelled"].as_bool()), (1, Some(false), Some(true)));
}
