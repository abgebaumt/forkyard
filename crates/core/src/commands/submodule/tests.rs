//! Tests of the submodule commands with local bare repositories as the "server".
//! Git only allows submodules from local paths with `protocol.file.allow=always`; that is set
//! here – and only here – in the sealed-off global configuration of the test core.

use super::*;
use crate::events::names;
use crate::testkit::{TestCore, TestRemote, TestRepo};

const ALLOW_FILE: &str = "[protocol \"file\"]\n\tallow = always\n";

async fn core() -> TestCore {
    TestCore::with_global_config(ALLOW_FILE).await
}

/// A library with two commits, on its "server".
fn library() -> (TestRepo, TestRemote) {
    let lib = TestRepo::new();
    lib.commit_file("lib.txt", "eins\n", "Bibliothek angelegt");
    lib.commit_file("lib.txt", "eins\nzwei\n", "Bibliothek erweitert");
    let remote = lib.add_remote();
    (lib, remote)
}

fn code<T: std::fmt::Debug>(result: CoreResult<T>) -> ErrorCode {
    result.expect_err("Fehler erwartet").code
}

fn sub_git(repo: &TestRepo, sub: &str, args: &[&str]) -> String {
    let dir = repo.path().join(sub).to_string_lossy().into_owned();
    let mut all = vec!["-C", dir.as_str(), "-c", "user.name=Test Person", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
    all.extend_from_slice(args);
    repo.git(&all)
}

#[test]
fn gitmodules_and_status_fields_are_parsed() {
    let config = b"submodule.libs/a.path\nlibs/a\0submodule.libs/a.url\nhttps://u:geheim@example.com/a.git\0submodule.libs/a.branch\nstable\0\
submodule.mit.punkt.path\nx y\0submodule.mit.punkt.URL\n../y.git\0core.bare\nfalse\0";
    let parsed = parse_gitmodules(config);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0], Declared { name: "libs/a".into(), path: Some("libs/a".into()), url: Some("https://u:geheim@example.com/a.git".into()), branch: Some("stable".into()) });
    assert_eq!((parsed[1].name.as_str(), parsed[1].path.as_deref(), parsed[1].url.as_deref()), ("mit.punkt", Some("x y"), Some("../y.git")));

    let a = "a".repeat(40);
    let status = format!(
        "1 .M S.M. 160000 160000 160000 {a} {a} libs/geändert\0\
1 .M SC.. 160000 160000 160000 {a} {a} libs/anderer commit\0\
1 .M N... 100644 100644 100644 {a} {a} datei mit leer.txt\0\
2 R. N... 100644 100644 100644 {a} {a} R100 neu.txt\0alt S.M.\0\
1 .M S..U 160000 160000 160000 {a} {a} unverfolgt\0\
u UU SCMU 160000 160000 160000 160000 {a} {a} {a} konflikt\0"
    );
    let flags = parse_sub_flags(status.as_bytes());
    assert_eq!(flags.len(), 4, "{flags:?}");
    assert_eq!(flags[&"libs/geändert".as_bytes().to_vec()], SubFlags { commit_changed: false, modified: true, untracked: false });
    assert_eq!(flags[&b"libs/anderer commit".to_vec()], SubFlags { commit_changed: true, modified: false, untracked: false });
    assert_eq!(flags[&b"unverfolgt".to_vec()], SubFlags { commit_changed: false, modified: false, untracked: true });
    assert_eq!(flags[&b"konflikt".to_vec()], SubFlags { commit_changed: true, modified: true, untracked: true });
}

#[tokio::test]
async fn add_list_states_and_remove() {
    let tc = core().await;
    let (lib, lib_remote) = library();
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert!(submodule_list(&tc, id.clone()).await.unwrap().is_empty());

    tc.events.clear();
    let list = submodule_add(&tc, id.clone(), "job-add".into(), lib_remote.url(), "libs/werkzeug".into()).await.unwrap();
    assert_eq!(list.len(), 1);
    let sub = &list[0];
    assert_eq!((sub.path.as_str(), sub.name.as_str(), sub.state), ("libs/werkzeug", "libs/werkzeug", SubmoduleState::Initialized));
    assert_eq!(sub.url.as_deref(), Some(lib_remote.url().as_str()));
    assert_eq!((sub.sha.as_str(), sub.head_sha.as_deref()), (lib.head().as_str(), Some(lib.head().as_str())));
    assert_eq!((sub.branch.as_deref(), sub.tracking_branch.as_deref()), (Some("main"), None));
    assert_eq!(repo.read_file("libs/werkzeug/lib.txt"), b"eins\nzwei\n");
    // Staged: .gitmodules and the submodule's entry.
    let status = crate::commands::status::read_status(&tc, &id).await.unwrap();
    let mut staged: Vec<&str> = status.staged.iter().map(|f| f.path.as_str()).collect();
    staged.sort();
    assert_eq!(staged, [".gitmodules", "libs/werkzeug"]);
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["jobId"].as_str(), done[0]["ok"].as_bool()), (1, Some("job-add"), Some(true)));
    let changed = tc.events.named(names::REPO_CHANGED);
    assert!(changed.iter().any(|e| e["what"] == serde_json::json!(["worktree", "index", "config"])), "{changed:?}");
    repo.commit("Submodul hinzugefügt");

    // Changes of its own in the submodule: untracked file, then modified file.
    repo.write_file("libs/werkzeug/notiz.txt", "x\n");
    assert_eq!(submodule_list(&tc, id.clone()).await.unwrap()[0].state, SubmoduleState::Modified);
    repo.remove_file("libs/werkzeug/notiz.txt");
    repo.write_file("libs/werkzeug/lib.txt", "eins\nzwei\nlokal\n");
    assert_eq!(submodule_list(&tc, id.clone()).await.unwrap()[0].state, SubmoduleState::Modified);
    sub_git(&repo, "libs/werkzeug", &["checkout", "-q", "--", "lib.txt"]);
    assert_eq!(submodule_list(&tc, id.clone()).await.unwrap()[0].state, SubmoduleState::Initialized);

    // A different commit is checked out (detached on the older one).
    let older = lib.git(&["rev-parse", "HEAD~1"]);
    sub_git(&repo, "libs/werkzeug", &["checkout", "-q", &older]);
    let list = submodule_list(&tc, id.clone()).await.unwrap();
    assert_eq!((list[0].state, list[0].branch.as_deref()), (SubmoduleState::OutOfSync, None));
    assert_eq!((list[0].sha.as_str(), list[0].head_sha.as_deref()), (lib.head().as_str(), Some(older.as_str())));

    // Removing: with a diverging state only when forced.
    assert_eq!(code(submodule_remove(&tc, id.clone(), "libs/werkzeug".into(), None).await), ErrorCode::DirtyWorktree);
    assert!(repo.path().join("libs/werkzeug/lib.txt").exists());
    assert_eq!(code(submodule_remove(&tc, id.clone(), "gibt/es/nicht".into(), Some(true)).await), ErrorCode::NotFound);
    tc.events.clear();
    let list = submodule_remove(&tc, id.clone(), "libs/werkzeug".into(), Some(true)).await.unwrap();
    assert!(list.is_empty());
    assert!(!repo.path().join("libs/werkzeug").exists());
    assert!(!repo.path().join(".git").join("modules").join("libs").join("werkzeug").exists(), "the submodule's Git directory is gone");
    assert!(!String::from_utf8_lossy(&repo.read_file(".gitmodules")).contains("werkzeug"));
    assert!(!repo.git_output(&["config", "--get", "submodule.libs/werkzeug.url"]).status.success());
    let status = crate::commands::status::read_status(&tc, &id).await.unwrap();
    assert!(status.staged.iter().any(|f| f.path == "libs/werkzeug" && f.status == crate::model::FileStatus::Deleted), "{:?}", status.staged);
    assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["worktree", "index", "config"]));
    repo.commit("Submodul entfernt");

    // Afterwards it can be added again under the same path.
    let list = submodule_add(&tc, id.clone(), "job-add-2".into(), lib_remote.url(), "libs/werkzeug".into()).await.unwrap();
    assert_eq!(list[0].state, SubmoduleState::Initialized);
    // Unchanged: removing without forcing.
    assert!(submodule_remove(&tc, id.clone(), "libs\\werkzeug".replace('\\', if cfg!(windows) { "\\" } else { "/" }), None).await.unwrap().is_empty());
}

#[tokio::test]
async fn update_initializes_and_follows_the_recorded_commit() {
    let tc = core().await;
    let (lib, lib_remote) = library();
    let first = TestRepo::with_commit();
    let first_id = tc.open(&first).await.repo.id;
    submodule_add(&tc, first_id.clone(), "job-1".into(), lib_remote.url(), "extern/lib mit leer".into()).await.unwrap();
    first.commit("Submodul hinzugefügt");
    let server = first.add_remote();

    // A fresh clone: the submodule is recorded but not initialised.
    let clone = TestRepo::clone_of(&server);
    let id = tc.open(&clone).await.repo.id;
    let list = submodule_list(&tc, id.clone()).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].state, list[0].head_sha.as_deref(), list[0].branch.as_deref()), (SubmoduleState::Uninitialized, None, None));
    assert_eq!(list[0].sha, lib.head());
    // Without `init` an uninitialised submodule stays as it is.
    let list = submodule_update(&tc, id.clone(), "job-2".into(), None, false).await.unwrap();
    assert_eq!(list[0].state, SubmoduleState::Uninitialized);

    tc.events.clear();
    let list = submodule_update(&tc, id.clone(), "job-3".into(), None, true).await.unwrap();
    assert_eq!((list[0].state, list[0].head_sha.as_deref()), (SubmoduleState::Initialized, Some(lib.head().as_str())));
    assert_eq!(clone.read_file("extern/lib mit leer/lib.txt"), b"eins\nzwei\n");
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["ok"].as_bool()), (1, Some(true)));
    assert!(tc.events.named(names::REPO_CHANGED).iter().any(|e| e["what"] == serde_json::json!(["worktree", "config"])));

    // The library gets a commit; the first repository follows and pushes.
    let newer = lib.commit_file("lib.txt", "eins\nzwei\ndrei\n", "Dritte Zeile");
    lib.git(&["push", "-q", "origin", "main"]);
    sub_git(&first, "extern/lib mit leer", &["pull", "-q", "origin", "main"]);
    first.commit("Bibliothek aktualisiert");
    first.git(&["push", "-q", "origin", "main"]);
    clone.git(&["pull", "-q", "origin", "main"]);
    let list = submodule_list(&tc, id.clone()).await.unwrap();
    assert_eq!((list[0].state, list[0].sha.as_str()), (SubmoduleState::OutOfSync, newer.as_str()));

    // Updating fetches the missing commit from the "server" and checks it out.
    let list = submodule_update(&tc, id.clone(), "job-4".into(), Some(vec!["extern/lib mit leer".into()]), false).await.unwrap();
    assert_eq!((list[0].state, list[0].head_sha.as_deref()), (SubmoduleState::Initialized, Some(newer.as_str())));
    assert_eq!(clone.read_file("extern/lib mit leer/lib.txt"), b"eins\nzwei\ndrei\n");

    // Error cases.
    assert_eq!(code(submodule_update(&tc, id.clone(), "job-5".into(), Some(vec!["kein/submodul".into()]), true).await), ErrorCode::NotFound);
    assert!(submodule_update(&tc, id.clone(), "job-6".into(), Some(vec![]), true).await.is_ok());
    // Local change in the way: setting the recorded submodule back to the old commit does not work.
    clone.git(&["update-index", "--cacheinfo", &format!("160000,{},extern/lib mit leer", lib.git(&["rev-parse", "HEAD~1"]))]);
    clone.write_file("extern/lib mit leer/lib.txt", "lokal ganz anders\n");
    assert_eq!(code(submodule_update(&tc, id.clone(), "job-7".into(), None, false).await), ErrorCode::DirtyWorktree);
    assert_eq!(clone.read_file("extern/lib mit leer/lib.txt"), b"lokal ganz anders\n");
}

#[tokio::test]
async fn add_rejects_bad_input_and_cleans_up_after_a_failure() {
    let tc = core().await;
    let (_lib, lib_remote) = library();
    let repo = TestRepo::with_commit();
    repo.write_file("belegt/datei.txt", "x\n");
    let id = tc.open(&repo).await.repo.id;
    let add = |job: &str, url: String, path: &str| submodule_add(&tc, id.clone(), job.to_string(), url, path.to_string());

    assert_eq!(code(add("j1", "ftp://server.example/lib.git".into(), "libs/a").await), ErrorCode::NotAllowed);
    assert_eq!(code(add("j2", "  ".into(), "libs/a").await), ErrorCode::NotAllowed);
    assert_eq!(code(add("j3", lib_remote.url(), "../draußen").await), ErrorCode::NotAllowed);
    assert_eq!(code(add("j4", lib_remote.url(), ".git/modules/x").await), ErrorCode::NotAllowed);
    assert_eq!(code(add("j5", lib_remote.url(), "belegt").await), ErrorCode::PathExists);
    assert_eq!(code(add("j6", lib_remote.url(), "README.md").await), ErrorCode::PathExists);
    // Each attempt reports exactly one job:done.
    assert_eq!(tc.events.count(names::JOB_DONE), 6);

    // Nothing exists at the address: no half clone, no .gitmodules, no Git directory.
    let nowhere = repo.temp_dir().join("gibt-es-nicht.git").to_string_lossy().replace('\\', "/");
    let err = add("j7", nowhere, "libs/fehlt").await.unwrap_err();
    assert!(matches!(err.code, ErrorCode::NotFound | ErrorCode::NoRemote | ErrorCode::Unknown), "{err:?}");
    assert!(!repo.path().join("libs").exists() && !repo.path().join(".gitmodules").exists());
    assert!(!repo.path().join(".git").join("modules").join("libs").exists());
    assert!(submodule_list(&tc, id.clone()).await.unwrap().is_empty());
    let status = crate::commands::status::read_status(&tc, &id).await.unwrap();
    assert!(status.staged.is_empty(), "{:?}", status.staged);

    // Afterwards it works under the same path.
    assert_eq!(add("j8", lib_remote.url(), "libs/fehlt").await.unwrap().len(), 1);
}

/// Without the exception in the configuration Git rejects local paths – with an explanation.
#[tokio::test]
async fn local_urls_need_the_file_protocol_to_be_allowed() {
    let tc = TestCore::new().await;
    let (_lib, lib_remote) = library();
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let err = submodule_add(&tc, id.clone(), "job".into(), lib_remote.url(), "libs/a".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
    assert!(err.message.contains("protocol.file.allow"), "{}", err.message);
    assert!(!repo.path().join("libs").exists() && !repo.path().join(".gitmodules").exists());
}

#[tokio::test]
async fn move_updates_gitmodules_and_keeps_the_checkout() {
    let tc = core().await;
    let (lib, lib_remote) = library();
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    submodule_add(&tc, id.clone(), "job-add".into(), lib_remote.url(), "libs/werkzeug".into()).await.unwrap();
    repo.commit("Submodul hinzugefügt");
    tc.events.clear();

    let list = submodule_move(&tc, id.clone(), "libs/werkzeug".into(), "extern/neuer Ort".into()).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].path.as_str(), list[0].state), ("extern/neuer Ort", SubmoduleState::Initialized));
    assert_eq!(list[0].sha, lib.head());
    assert_eq!(repo.read_file("extern/neuer Ort/lib.txt"), b"eins\nzwei\n");
    assert!(!repo.path().join("libs").join("werkzeug").exists());
    let gitmodules = String::from_utf8(repo.read_file(".gitmodules")).unwrap();
    assert!(gitmodules.contains("path = extern/neuer Ort"), "{gitmodules}");
    let changed = tc.events.named(names::REPO_CHANGED);
    assert!(changed.iter().any(|e| e["what"] == serde_json::json!(["worktree", "index", "config"])), "{changed:?}");
    let status = crate::commands::status::read_status(&tc, &id).await.unwrap();
    assert!(status.staged.iter().any(|f| f.path == ".gitmodules"), "the move is staged");

    // Errors change nothing: target exists, unknown submodule, outside, into itself, into .git.
    repo.write_file("belegt/datei.txt", "x\n");
    assert_eq!(code(submodule_move(&tc, id.clone(), "extern/neuer Ort".into(), "belegt".into()).await), ErrorCode::PathExists);
    assert_eq!(code(submodule_move(&tc, id.clone(), "gibt/es/nicht".into(), "x".into()).await), ErrorCode::NotFound);
    assert_eq!(code(submodule_move(&tc, id.clone(), "extern/neuer Ort".into(), "../draußen".into()).await), ErrorCode::NotAllowed);
    assert_eq!(code(submodule_move(&tc, id.clone(), "extern/neuer Ort".into(), "extern/neuer Ort/innen".into()).await), ErrorCode::NotAllowed);
    assert_eq!(code(submodule_move(&tc, id.clone(), "extern/neuer Ort".into(), ".git/modules/x".into()).await), ErrorCode::NotAllowed);
    assert_eq!(submodule_list(&tc, id).await.unwrap()[0].path, "extern/neuer Ort");
}
