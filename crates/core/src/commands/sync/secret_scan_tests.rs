//! The secret scan before every push (v1.2, 6.2) against a local bare remote: the push stops
//! until exactly the findings shown are accepted – for every kind of push.

use serde_json::json;

use super::*;
use crate::commands::commit::commit_create;
use crate::commands::gitflow::{gitflow_finish, gitflow_init, gitflow_start};
use crate::commands::tags::{tag_create, tag_push, tag_push_checked};
use crate::events::names;
use crate::model::{GitflowFinishOptions, GitflowKind, PushExtra, PushRefStatus, SecretFinding, SecretRule};
use crate::testkit::{TestCore, TestRemote, TestRepo};

// Built at run time: no literal key format in this file.
fn fake_key() -> String {
    format!("AKIA{}", "Q7RZ4M2XK9PLW3NB")
}
fn fake_token() -> String {
    format!("ghp_{}", "Zx9Qm2Lr7Tv4Wk8Np3Hs6Bd1Fg5Jc0Ya1234")
}

struct Fixture {
    tc: TestCore,
    repo: TestRepo,
    remote: TestRemote,
    id: String,
}

/// One commit, pushed as `origin/main` (upstream), opened in the core.
async fn fixture() -> Fixture {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    Fixture { tc, repo, remote, id }
}

fn remote_sha(remote: &TestRemote, name: &str) -> Option<String> {
    let out = remote.git_output(&["rev-parse", "--verify", "-q", name]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn places(result: &PushResult) -> Vec<(String, u32, SecretRule)> {
    let PushResult::SecretsFound { findings, .. } = result else { panic!("expected secrets_found, got {result:?}") };
    findings.iter().map(|f| (f.path.clone(), f.line, f.rule)).collect()
}

fn ids(result: &PushResult) -> Vec<String> {
    let PushResult::SecretsFound { findings, .. } = result else { panic!("expected secrets_found, got {result:?}") };
    findings.iter().map(|f| f.id.clone()).collect()
}

async fn push_plain(f: &Fixture, accepted: Option<Vec<String>>) -> PushResult {
    push_checked(&f.tc, f.id.clone(), util::new_id(), None, None, None, false, None, accepted).await.unwrap()
}

#[test]
fn secrets_found_reaches_the_ui_as_a_push_result() {
    let finding = SecretFinding {
        id: "ab".repeat(32),
        path: "einstellungen/dienst.py".into(),
        line: 2,
        commit: "c".repeat(40),
        rule: SecretRule::KnownToken,
        excerpt: "AWS_ZUGANG = \"…W3NB\"".into(),
        hint: "…W3NB".into(),
    };
    assert_eq!(
        serde_json::to_value(PushResult::SecretsFound { findings: vec![finding], commits: 1, partial: false }).unwrap(),
        json!({
            "status": "secrets_found",
            "findings": [{"id": "ab".repeat(32), "path": "einstellungen/dienst.py", "line": 2, "commit": "c".repeat(40), "rule": "known_token", "excerpt": "AWS_ZUGANG = \"…W3NB\"", "hint": "…W3NB"}],
            "commits": 1,
            "partial": false
        })
    );
}

#[tokio::test]
async fn a_push_with_a_key_stops_until_exactly_these_findings_are_accepted() {
    let f = fixture().await;
    let before = f.repo.head();
    f.repo.commit_file("einstellungen/dienst.py", format!("REGION = \"eu-central-1\"\nAWS_ZUGANG = \"{}\"\n", fake_key()), "Dienst anbinden");

    let stopped = push(&f.tc, f.id.clone(), util::new_id(), None, None, None, false, None).await.unwrap();
    assert_eq!(places(&stopped), vec![("einstellungen/dienst.py".to_string(), 2, SecretRule::KnownToken)]);
    let PushResult::SecretsFound { findings, commits, partial } = &stopped else { unreachable!() };
    assert_eq!((*commits, *partial), (1, false));
    assert_eq!(findings[0].hint, "…W3NB");
    assert!(!serde_json::to_string(&stopped).unwrap().contains(&fake_key()), "the value never leaves the core");
    assert_eq!(remote_sha(&f.remote, "refs/heads/main"), Some(before.clone()), "nothing was sent");
    assert_eq!(f.tc.events.named(names::JOB_DONE)[0]["ok"], true, "a stop is a result, not an error");
    assert!(f.tc.events.named(names::REPO_CHANGED).is_empty());

    // Accepting something else does not let it through.
    assert!(matches!(push_plain(&f, Some(vec!["0".repeat(64)])).await, PushResult::SecretsFound { .. }));
    // A new finding after the dialog asks again – and lists both.
    let shown = ids(&stopped);
    f.repo.commit_file("zweit.txt", format!("token = \"{}\"\n", fake_token()), "Zweiter Zugang");
    let again = push_plain(&f, Some(shown)).await;
    assert_eq!(places(&again).len(), 2);
    assert_eq!(remote_sha(&f.remote, "refs/heads/main"), Some(before));

    let done = push_plain(&f, Some(ids(&again))).await;
    assert_eq!(done, PushResult::Done { remote: "origin".into(), branch: "main".into(), created_upstream: false, forced: false });
    assert_eq!(remote_sha(&f.remote, "refs/heads/main"), Some(f.repo.head()));
    // On the remote now: nothing goes out, nothing is reported.
    assert_eq!(push_plain(&f, None).await, PushResult::UpToDate);
}

#[tokio::test]
async fn every_kind_of_push_is_checked() {
    let f = fixture().await;
    let base = f.repo.head();

    // "Push …" with more refs: the extra branch carries the key.
    f.repo.checkout_new("feature/zugang");
    f.repo.commit_file("zugang.env", format!("AWS={}\n", fake_key()), "Zugang");
    f.repo.checkout("main");
    let extra = vec![PushExtra { local: "refs/heads/feature/zugang".into(), remote_name: None, force: false }];
    let stopped = push_with(&f.tc, f.id.clone(), util::new_id(), None, None, None, false, None, Some(extra.clone()), Some(true), None).await.unwrap();
    assert_eq!(places(&stopped), vec![("zugang.env".to_string(), 1, SecretRule::KnownToken)]);
    assert_eq!(remote_sha(&f.remote, "refs/heads/feature/zugang"), None);
    let pushed = push_with(&f.tc, f.id.clone(), util::new_id(), None, None, None, false, None, Some(extra), Some(true), Some(ids(&stopped))).await.unwrap();
    let PushResult::Multi { refs, .. } = &pushed else { panic!("{pushed:?}") };
    assert!(refs.iter().all(|r| r.status != PushRefStatus::Rejected), "{refs:?}");
    assert!(remote_sha(&f.remote, "refs/heads/feature/zugang").is_some());

    // Tag push: the tag's commit is not on any remote branch.
    let pem = format!("-----BEGIN {}PRIVATE KEY-----\n", "OPENSSH ");
    f.repo.commit_file("schluessel/deploy", pem, "Schlüssel für die Bereitstellung");
    tag_create(&f.tc, f.id.clone(), "v1".into(), None, Some("Version 1".into())).await.unwrap();
    let stopped = tag_push(&f.tc, f.id.clone(), util::new_id(), "v1".into(), "origin".into()).await.unwrap();
    assert_eq!(places(&stopped), vec![("schluessel/deploy".to_string(), 1, SecretRule::PrivateKey)]);
    assert_eq!(remote_sha(&f.remote, "refs/tags/v1"), None);
    let done = tag_push_checked(&f.tc, f.id.clone(), util::new_id(), "v1".into(), "origin".into(), Some(ids(&stopped))).await.unwrap();
    assert!(matches!(done, PushResult::Done { .. }), "{done:?}");
    assert!(remote_sha(&f.remote, "refs/tags/v1").is_some());

    // Commit and push: the commit stays, the push stops.
    f.repo.git(&["push", "-q", "origin", "main"]);
    let pushed_main = f.repo.head();
    f.repo.write_file("dienst.py", format!("AWS_ZUGANG = \"{}\"\n", fake_key()));
    let result = commit_create(&f.tc, f.id.clone(), util::new_id(), "Dienst".into(), String::new(), false, false, true, true, None).await.unwrap();
    assert_eq!(places(result.push.as_ref().expect("push result")), vec![("dienst.py".to_string(), 1, SecretRule::KnownToken)]);
    assert_ne!(f.repo.head(), pushed_main, "the commit exists");
    assert_eq!(remote_sha(&f.remote, "refs/heads/main"), Some(pushed_main));
    assert_ne!(base, f.repo.head());
}

#[tokio::test]
async fn the_push_of_a_gitflow_finish_stops_and_names_the_place() {
    let f = fixture().await;
    gitflow_init(&f.tc, f.id.clone(), "main".into(), "develop".into(), None).await.unwrap();
    f.repo.git(&["push", "-q", "-u", "origin", "develop"]);
    let develop_before = f.repo.git(&["rev-parse", "develop"]);
    gitflow_start(&f.tc, f.id.clone(), GitflowKind::Feature, "zugang".into(), None).await.unwrap();
    f.repo.commit_file("geheim.txt", format!("{}\n", fake_token()), "Zugang");

    let finish = GitflowFinishOptions { push: true, ..GitflowFinishOptions::default() };
    let err = gitflow_finish(&f.tc, f.id.clone(), GitflowKind::Feature, "zugang".into(), Some(finish), Some("job-flow".into())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("finished locally") && err.message.contains("was not pushed") && err.message.contains("geheim.txt:1"), "{}", err.message);
    assert!(!err.message.contains(&fake_token()));
    assert_eq!(remote_sha(&f.remote, "refs/heads/develop"), Some(develop_before.clone()), "nothing was sent");
    assert_ne!(f.repo.git(&["rev-parse", "develop"]), develop_before, "the finish itself is done");
}
