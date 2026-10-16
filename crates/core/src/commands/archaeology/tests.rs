//! `line_archaeology` against real repositories: the working directory, renames, old dates in
//! other time zones, CRLF and Latin-1, a leading dash, references of the remote's host.

use super::*;
use crate::commands::settings::repo_settings_set;
use crate::error::ErrorCode;
use crate::model::ArchaeologyRefKind;
use crate::testkit::{TestCore, TestRepo};
use serde_json::json;

pub(super) async fn setup(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

fn shas(found: &LineArchaeology) -> Vec<String> {
    found.steps.iter().map(|step| step.commit.sha.clone()).collect()
}

#[tokio::test]
async fn the_worktree_line_is_followed_from_the_commit_that_last_changed_it() {
    let repo = TestRepo::new();
    let path = "src/-wetter daten.py";
    let one = repo.commit_file(path, "kopf\nINTERVALL = 10\nfuss\n", "Erster Stand");
    let two = repo.commit_file(path, "kopf\nINTERVALL = 5\nfuss\n", "Intervall halbiert (#12)");
    // Two uncommitted lines above: the line is line 4 in the working directory, line 2 in the commit.
    repo.write_file(path, "neu oben\nnoch eine\nkopf\nINTERVALL = 5\nfuss\n");
    let (tc, id) = setup(&repo).await;

    let found = line_archaeology(&tc, id.clone(), path.into(), 4, None).await.unwrap();
    assert_eq!((found.sha.as_str(), found.path.as_str(), found.line), (two.as_str(), path, 2), "starts at the commit that wrote the line");
    assert_eq!(shas(&found), vec![two.clone(), one.clone()]);
    assert_eq!(found.steps[0].message, "Intervall halbiert (#12)");
    assert_eq!(found.steps[0].diff, vec!["-INTERVALL = 10".to_string(), "+INTERVALL = 5".to_string()]);
    assert_eq!((found.code_start, found.code.clone()), (1, vec!["kopf".to_string(), "INTERVALL = 5".to_string(), "fuss".to_string()]), "the committed text around the line");
    assert!(!found.may_have_more);
    assert!(found.steps[0].refs.is_empty(), "no remote, no rules: no links");

    let code = |result: CoreResult<LineArchaeology>| result.unwrap_err().code;
    assert_eq!(code(line_archaeology(&tc, id.clone(), path.into(), 1, None).await), ErrorCode::NotAllowed, "an uncommitted line has no history");
    assert_eq!(code(line_archaeology(&tc, id.clone(), path.into(), 99, None).await), ErrorCode::NotFound);
    assert_eq!(code(line_archaeology(&tc, id.clone(), path.into(), 0, None).await), ErrorCode::NotAllowed);
    assert_eq!(code(line_archaeology(&tc, id.clone(), "../draußen.txt".into(), 1, None).await), ErrorCode::NotAllowed);
    assert_eq!(code(line_archaeology(&tc, id.clone(), path.into(), 2, Some("--all".into())).await), ErrorCode::NotFound);

    let at_head = line_archaeology(&tc, id, path.into(), 2, Some("HEAD".into())).await.unwrap();
    assert_eq!((at_head.sha.as_str(), shas(&at_head)), (two.as_str(), vec![two.clone(), one]), "a given commit is used as is");
}

#[tokio::test]
async fn an_old_renamed_file_in_other_time_zones_with_crlf_and_latin1() {
    let repo = TestRepo::new();
    repo.write_file("alt.txt", b"kopf\r\nGr\xfc\xdfe aus 2009\r\nfuss\r\n");
    let old = repo.commit_as("Gruß angelegt", "Ana Pérez", "ana@example.org", "2009-02-13T23:31:30-08:00");
    repo.subdir("ordner mit leer");
    repo.git(&["mv", "alt.txt", "ordner mit leer/neu ä.txt"]);
    repo.commit_as("Umbenannt", "Kenji Sato", "kenji@example.jp", "2015-07-01T08:00:00+09:00");
    repo.write_file("ordner mit leer/neu ä.txt", b"kopf\r\nGr\xfc\xdfe aus 2026\r\nfuss\r\n");
    let edited = repo.commit_as("Jahr aktualisiert", "Jörg Müller", "joerg@example.com", "2026-03-01T10:00:00+05:30");
    let (tc, id) = setup(&repo).await;

    let found = line_archaeology(&tc, id, "ordner mit leer/neu ä.txt".into(), 2, Some("HEAD".into())).await.unwrap();
    let steps: Vec<(&str, &str, &str)> = found.steps.iter().map(|step| (step.commit.sha.as_str(), step.path.as_str(), step.commit.authored_at.as_str())).collect();
    assert_eq!(
        steps,
        vec![(edited.as_str(), "ordner mit leer/neu ä.txt", "2026-03-01T04:30:00.000Z"), (old.as_str(), "alt.txt", "2009-02-14T07:31:30.000Z")],
        "the pure rename did not change the line; times in UTC"
    );
    assert_eq!(found.code, vec!["kopf".to_string(), "Grüße aus 2026".to_string(), "fuss".to_string()], "Latin-1 decoded, CR removed");
    assert_eq!(found.steps[0].diff, vec!["-Grüße aus 2009".to_string(), "+Grüße aus 2026".to_string()]);
    assert_eq!(found.steps[1].commit.author.name, "Ana Pérez");
}

#[tokio::test]
async fn references_link_to_the_remotes_host_and_to_ticket_rules() {
    let repo = TestRepo::with_commit();
    repo.git(&["remote", "add", "origin", "https://gitlab.com/gruppe/projekt.git"]);
    repo.commit_file("werte.txt", "eins\n", "Werte angelegt\n\nSiehe #12 und !7, Ticket OPS-3, nochmal #12.");
    let (tc, id) = setup(&repo).await;
    repo_settings_set(&tc, id.clone(), json!({"linkRules": {"hostRules": true, "presets": [{"kind": "jira", "baseUrl": "https://jira.example", "keys": ["OPS"]}], "custom": []}})).await.unwrap();

    let found = line_archaeology(&tc, id, "werte.txt".into(), 1, Some("HEAD".into())).await.unwrap();
    assert_eq!(found.steps[0].message, "Werte angelegt\n\nSiehe #12 und !7, Ticket OPS-3, nochmal #12.");
    let refs: Vec<(&str, &str, ArchaeologyRefKind)> = found.steps[0].refs.iter().map(|r| (r.text.as_str(), r.url.as_str(), r.kind)).collect();
    assert_eq!(
        refs,
        vec![
            ("#12", "https://gitlab.com/gruppe/projekt/-/issues/12", ArchaeologyRefKind::Issue),
            ("!7", "https://gitlab.com/gruppe/projekt/-/merge_requests/7", ArchaeologyRefKind::PullRequest),
            ("OPS-3", "https://jira.example/browse/OPS-3", ArchaeologyRefKind::Ticket),
        ]
    );
}

#[tokio::test]
async fn at_most_twenty_steps_and_long_messages_and_changes_are_clipped() {
    let repo = TestRepo::new();
    let mut made = Vec::new();
    for n in 1..=25 {
        let body = "x".repeat(5_000);
        made.push(repo.commit_file("zähler.txt", format!("Stand {n}\n"), &format!("Änderung {n}\n\n{body}")));
    }
    let lines: String = (1..=60).map(|n| format!("zeile {n}\n")).collect();
    repo.commit_file("gross.txt", &lines, "Sechzig Zeilen");
    let replaced = repo.commit_file("gross.txt", "neu\n", "Durch eine Zeile ersetzt");
    let (tc, id) = setup(&repo).await;

    let found = line_archaeology(&tc, id.clone(), "zähler.txt".into(), 1, Some("HEAD".into())).await.unwrap();
    assert_eq!(shas(&found), made.iter().rev().take(20).cloned().collect::<Vec<_>>());
    assert!(found.may_have_more, "exactly 20 came back: older changes may exist");
    assert!(found.steps.iter().all(|step| step.message.len() <= MAX_MESSAGE_BYTES + "…".len() && step.message.ends_with('…')));

    // Sixty lines replaced by one: `git log -L1,1` shows the whole rewritten hunk – 60 removed lines
    // and 1 added line – and for the first commit its 60 added lines (lines 1–60 there).
    let rewritten = line_archaeology(&tc, id, "gross.txt".into(), 1, Some(replaced)).await.unwrap();
    assert_eq!(rewritten.steps.len(), 2);
    assert_eq!(rewritten.steps[0].diff.len(), MAX_DIFF_LINES + 1);
    assert_eq!(rewritten.steps[0].diff[0], "-zeile 1");
    assert_eq!(rewritten.steps[0].diff[MAX_DIFF_LINES], "… 21 more lines", "61 lines, 40 shown");
    assert_eq!((rewritten.steps[1].start_line, rewritten.steps[1].end_line), (1, 60));
    assert_eq!(rewritten.steps[1].diff[MAX_DIFF_LINES], "… 20 more lines", "60 lines, 40 shown");
}
