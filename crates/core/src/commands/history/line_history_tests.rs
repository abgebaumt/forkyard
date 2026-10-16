//! `line_history` against real repositories: edits, a rename, another time zone, a leading dash.

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{TestCore, TestRepo};

async fn setup(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

#[tokio::test]
async fn follows_one_line_through_edits_a_rename_and_another_time_zone() {
    let repo = TestRepo::new();
    let one = repo.commit_file("alt name.txt", "a\nb\nc\nd\n", "Eins");
    let two = repo.commit_file("alt name.txt", "a\nB\nc\nd\n", "Zwei: b groß");
    repo.git(&["mv", "alt name.txt", "neu ä.txt"]);
    repo.commit("Umbenannt");
    repo.write_file("neu ä.txt", "x\na\nB2\nc\nd\n");
    let four = repo.commit_as("Vier: Zeile oben, B2", "Jörg Müller", "joerg@example.com", "2026-03-01T10:00:00+05:30");
    repo.commit_file("anderes.txt", "x\n", "Fünf: andere Datei");
    let (tc, id) = setup(&repo).await;

    let steps = line_history(&tc, id, "neu ä.txt".into(), 3, "HEAD".into()).await.unwrap();
    let shown: Vec<(&str, &str, u32, u32)> = steps.iter().map(|step| (step.commit.sha.as_str(), step.path.as_str(), step.start_line, step.end_line)).collect();
    // Line 3 "B2" of today was line 2 "B" before the rename and line 2 "b" in the first commit.
    assert_eq!(shown, vec![(four.as_str(), "neu ä.txt", 3, 3), (two.as_str(), "alt name.txt", 2, 2), (one.as_str(), "alt name.txt", 2, 2)]);
    assert_eq!(steps[0].commit.summary, "Vier: Zeile oben, B2");
    assert_eq!(steps[0].commit.author.name, "Jörg Müller");
    assert_eq!(steps[0].commit.authored_at, "2026-03-01T04:30:00.000Z", "the other time zone in UTC");
    assert!(steps[2].commit.parents.is_empty(), "the first commit has no parent");
}

#[tokio::test]
async fn at_most_twenty_steps_newest_first() {
    let repo = TestRepo::new();
    let mut shas = Vec::new();
    for n in 1..=25 {
        shas.push(repo.commit_file("-zähler.txt", format!("Stand {n}\nfest\n"), &format!("Änderung {n}")));
    }
    let (tc, id) = setup(&repo).await;
    let steps = line_history(&tc, id, "-zähler.txt".into(), 1, repo.head()).await.unwrap();
    assert_eq!(steps.len(), LINE_HISTORY_STEPS as usize);
    let expected: Vec<String> = shas.iter().rev().take(20).cloned().collect();
    assert_eq!(steps.iter().map(|step| step.commit.sha.clone()).collect::<Vec<_>>(), expected);
    assert!(steps.iter().all(|step| step.path == "-zähler.txt" && step.start_line == 1 && step.end_line == 1));
}

#[tokio::test]
async fn wrong_lines_paths_and_commits_are_clear_errors() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let head = repo.head();
    let ask = |path: &str, line: u32, sha: &str| line_history(&tc, id.clone(), path.to_string(), line, sha.to_string());
    assert_eq!(ask("README.md", 0, &head).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(ask("README.md", 99, &head).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(ask("fehlt.txt", 1, &head).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(ask("../draußen.txt", 1, &head).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(ask("README.md", 1, "--all").await.unwrap_err().code, ErrorCode::NotFound);
    let steps = ask("README.md", 1, &head).await.unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!((steps[0].commit.sha.as_str(), steps[0].start_line, steps[0].end_line), (head.as_str(), 1, 1));
}

#[tokio::test]
async fn each_step_keeps_the_lines_of_its_change_with_crlf_and_latin1() {
    let repo = TestRepo::new();
    let one = repo.commit_file("mess werte.txt", b"kopf\r\nalt\r\nfuss\r\n", "Eins");
    // 0xFC is “ü” in Latin-1 / Windows-1252 and invalid UTF-8.
    let two = repo.commit_file("mess werte.txt", b"kopf\r\nneu \xfc\r\nfuss\r\n", "Zwei: Latin-1");
    let (tc, id) = setup(&repo).await;

    let steps = line_history_with_diffs(&tc, &id, "mess werte.txt", 2, "HEAD").await.unwrap();
    assert_eq!(steps.iter().map(|(step, _)| step.commit.sha.clone()).collect::<Vec<_>>(), vec![two, one]);
    assert_eq!(steps[0].1, vec!["-alt".to_string(), "+neu ü".to_string()], "the change of the line, CR removed, Latin-1 decoded");
    assert!(steps[1].1.contains(&"+alt".to_string()), "the first commit adds the line: {:?}", steps[1].1);
    assert!(steps.iter().all(|(_, lines)| lines.iter().all(|line| !line.ends_with('\r') && !line.starts_with("@@"))));

    let public = line_history(&tc, id.clone(), "mess werte.txt".into(), 2, "HEAD".into()).await.unwrap();
    assert_eq!(public, steps.into_iter().map(|(step, _)| step).collect::<Vec<_>>(), "the command returns the same steps as before");
}
