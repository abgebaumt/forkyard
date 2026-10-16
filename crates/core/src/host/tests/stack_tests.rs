//! The pull requests of a stack (Paket 8.1) at every host: each part targets the part below it.

use super::{assert_clean, Fixture};
use crate::commands::stack::stack_prs_create;
use crate::error::ErrorCode;
use crate::model::{HostKind, StackPrPart};
use crate::testkit::MockRequest;

const PARTS: [&str; 3] = ["thema-1-modell", "thema-2-import", "thema-3-diagramme"];
const KINDS: [HostKind; 5] = [HostKind::Github, HostKind::Gitlab, HostKind::Gitea, HostKind::Bitbucket, HostKind::AzureDevops];

fn parts(branches: &[&str]) -> Vec<StackPrPart> {
    branches
        .iter()
        .enumerate()
        .map(|(index, branch)| StackPrPart { branch: branch.to_string(), title: format!("Teil {} – Größen", index + 1), body: format!("- Schritt {}", index + 1), draft: false })
        .collect()
}

/// The create requests of `kind` (the path its API creates pull requests at).
fn creates(fx: &Fixture, kind: HostKind) -> Vec<MockRequest> {
    let path = match kind {
        HostKind::Github | HostKind::Gitea => "/pulls",
        HostKind::Gitlab => "/merge_requests",
        HostKind::Bitbucket | HostKind::AzureDevops => "/pullrequests",
    };
    fx.sent("POST", path)
}

/// Source and target branch of a create request, as each host's API names them.
fn source_target(kind: HostKind, request: &MockRequest) -> (String, String) {
    let body = request.json();
    let text = |value: &serde_json::Value| value.as_str().unwrap_or_default().to_string();
    match kind {
        HostKind::Github | HostKind::Gitea => (text(&body["head"]), text(&body["base"])),
        HostKind::Gitlab => (text(&body["source_branch"]), text(&body["target_branch"])),
        HostKind::Bitbucket => (text(&body["source"]["branch"]["name"]), text(&body["destination"]["branch"]["name"])),
        HostKind::AzureDevops => (text(&body["sourceRefName"]), text(&body["targetRefName"])),
    }
}

/// What each host must receive – written out from the hosts' documented field names.
fn expected(kind: HostKind) -> Vec<(String, String)> {
    let pairs = [("thema-1-modell", "main"), ("thema-2-import", "thema-1-modell"), ("thema-3-diagramme", "thema-2-import")];
    pairs
        .iter()
        .map(|(source, target)| match kind {
            HostKind::AzureDevops => (format!("refs/heads/{source}"), format!("refs/heads/{target}")),
            _ => (source.to_string(), target.to_string()),
        })
        .collect()
}

async fn fixture(kind: HostKind) -> Fixture {
    let fx = Fixture::new(kind).await;
    for branch in PARTS {
        fx.repo.branch(branch);
    }
    fx
}

#[tokio::test]
async fn every_host_gets_each_part_onto_the_previous_one() {
    for kind in KINDS {
        let fx = fixture(kind).await;
        let outcome = stack_prs_create(&fx.tc, fx.id(), "main".into(), parts(&PARTS), 0, None).await.unwrap();
        assert!(outcome.failed.is_none(), "{kind:?}: {:?}", outcome.failed);
        assert_eq!(outcome.created.iter().map(|created| created.part).collect::<Vec<_>>(), [1, 2, 3], "{kind:?}");
        let sent: Vec<(String, String)> = creates(&fx, kind).iter().map(|request| source_target(kind, request)).collect();
        assert_eq!(sent, expected(kind), "{kind:?}");
        fx.assert_token_stays_secret();
    }
}

#[tokio::test]
async fn titles_and_bodies_go_out_as_given() {
    let fx = fixture(HostKind::Github).await;
    stack_prs_create(&fx.tc, fx.id(), "main".into(), parts(&PARTS), 0, None).await.unwrap();
    let first = creates(&fx, HostKind::Github)[0].json();
    assert_eq!((first["title"].as_str(), first["body"].as_str(), first["draft"].as_bool()), (Some("Teil 1 – Größen"), Some("- Schritt 1"), Some(false)));
}

#[tokio::test]
async fn a_failed_part_stops_the_rest() {
    let fx = Fixture::new(HostKind::Github).await;
    // The GitHub mock answers 422 "already exists" for the head "schon-da".
    let branches = ["thema-1-modell", "schon-da", "thema-3-diagramme"];
    for branch in branches {
        fx.repo.branch(branch);
    }
    let outcome = stack_prs_create(&fx.tc, fx.id(), "main".into(), parts(&branches), 0, None).await.unwrap();
    assert_eq!(outcome.created.iter().map(|created| created.part).collect::<Vec<_>>(), [1]);
    let failed = outcome.failed.expect("part 2 failed");
    assert_eq!((failed.part, failed.error.code), (2, ErrorCode::NameExists));
    assert_clean(&failed.error);
    assert_eq!(creates(&fx, HostKind::Github).len(), 2, "part 3 was never sent");

    // Continue from part 3 later: it targets part 2.
    fx.server.clear();
    let outcome = stack_prs_create(&fx.tc, fx.id(), "main".into(), parts(&branches), 2, None).await.unwrap();
    assert_eq!(outcome.created.iter().map(|created| created.part).collect::<Vec<_>>(), [3]);
    assert_eq!(source_target(HostKind::Github, &creates(&fx, HostKind::Github)[0]), ("thema-3-diagramme".to_string(), "schon-da".to_string()));

    // A rejected token stops at the first part, too.
    fx.server.clear();
    fx.mode("401");
    let outcome = stack_prs_create(&fx.tc, fx.id(), "main".into(), parts(&PARTS[..1]), 0, None).await.unwrap();
    assert_eq!(outcome.failed.map(|failed| (failed.part, failed.error.code)), Some((1, ErrorCode::HostAuthFailed)));
    assert_eq!(creates(&fx, HostKind::Github).len(), 1);
}

#[tokio::test]
async fn invalid_input_sends_nothing() {
    let fx = fixture(HostKind::Github).await;
    let create = |target: &str, parts: Vec<StackPrPart>, from: u32| stack_prs_create(&fx.tc, fx.id(), target.to_string(), parts, from, None);
    let mut empty_title = parts(&PARTS);
    empty_title[2].title = "  ".into();
    assert_eq!(create("main", empty_title, 0).await.unwrap_err().code, ErrorCode::EmptyMessage);
    let mut two_lines = parts(&PARTS);
    two_lines[1].title = "Zeile\nzwei".into();
    assert_eq!(create("main", two_lines.clone(), 0).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert!(create("main", two_lines, 2).await.is_ok(), "parts before `from` are not sent, so their titles don't matter");
    fx.server.clear();
    assert_eq!(create("main", parts(&["thema-1-modell", "fehlt"]), 0).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(create("main", parts(&["thema-1-modell", "thema-1-modell"]), 0).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(create("thema-1-modell", parts(&PARTS), 0).await.unwrap_err().code, ErrorCode::NotAllowed, "the target is no part");
    assert_eq!(create(" ", parts(&PARTS), 0).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(create("main", parts(&PARTS), 3).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(create("main", parts(&["-x"]), 0).await.unwrap_err().code, ErrorCode::InvalidName);
    assert!(fx.server.requests().is_empty(), "nothing was sent");
}
