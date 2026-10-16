//! The secret scan against real repositories with a local bare remote.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Instant;

use sha2::{Digest, Sha256};

use super::*;
use crate::error::ErrorCode;
use crate::jobs::CancelToken;
use crate::testkit::{git_isolation_env, TestCore, TestRemote, TestRepo};

// Built at run time: no literal key format in this file.
fn token() -> String {
    format!("ghp_{}", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")
}
fn aws() -> String {
    format!("AKIA{}", "Q7RZ4M2XK9PLW3NB")
}

async fn scan(tc: &TestCore, id: &str) -> SecretScan {
    scan_outgoing(tc, id, &["refs/heads/main".to_string()], "origin", &CancelToken::new()).await.unwrap()
}

fn places(scan: &SecretScan) -> Vec<(String, u32, SecretRule, String)> {
    scan.findings.iter().map(|f| (f.path.clone(), f.line, f.rule, f.commit.clone())).collect()
}

#[tokio::test]
async fn only_added_lines_of_commits_missing_on_the_remote_are_scanned() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.write_file("alt/zugang.txt", format!("schon gepusht: {}\nzweite Zeile\n", token()));
    repo.write_file("alt/hinweis.txt", "password = \"hunter2-lang\"\n");
    repo.commit("Alter Stand");
    let _remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;

    // Written long ago in another time zone – the graph decides what goes out, not the date.
    repo.write_file("-geheim/zugäng daten.txt", b"erste Zeile\r\nzweite Zeile\r\npassword = \"anders-2026x\"\r\n".to_vec());
    let old = repo.commit_as("Zugang aus alter Zeit", "Ältere Zeit", "alt@example.com", "@1262304000 +1400");
    // The pushed key is deleted, the hint file only moved: neither adds a line.
    repo.write_file("alt/zugang.txt", "zweite Zeile\n");
    repo.subdir("neu");
    repo.git(&["mv", "alt/hinweis.txt", "neu/hinweis.txt"]);
    repo.commit("Aufräumen");
    // Added and removed again: still in what goes out.
    let added = repo.commit_file("tmp.txt", format!("{}\n", token()), "Kurz abgelegt");
    repo.remove_file("tmp.txt");
    repo.commit("Wieder entfernt");
    // A merge: only the side commit has lines of its own.
    repo.checkout_new("seite");
    repo.commit_file("seite.txt", "harmlos\n", "Seite");
    repo.checkout("main");
    // A binary file with a key inside is not read.
    repo.commit_file("bild.dat", [b"\0PNG".as_slice(), aws().as_bytes()].concat(), "Bild");
    assert!(repo.merge("seite"));

    let result = scan(&tc, &id).await;
    assert_eq!(
        places(&result),
        vec![("-geheim/zugäng daten.txt".to_string(), 3, SecretRule::Credential, old.clone()), ("tmp.txt".to_string(), 1, SecretRule::KnownToken, added.clone())]
    );
    assert_eq!(result.commits.to_string(), repo.git(&["rev-list", "--count", "main", "--not", "--remotes=origin"]), "every outgoing commit, counted by Git");
    assert!(!result.partial);
    assert_eq!(result.findings[0].excerpt, "password = \"…026x\"", "CR stripped, value masked");
    assert_eq!(result.findings[1].hint, format!("…{}", &token()[token().len() - 4..]));

    // Pushed: nothing goes out any more.
    repo.git(&["push", "-q", "origin", "main"]);
    let after = scan(&tc, &id).await;
    assert_eq!((after.commits, after.findings.len()), (0, 0));
}

#[tokio::test]
async fn ignored_findings_survive_a_rebase_and_store_only_hashes() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let _remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    let line = format!("AWS_ZUGANG = \"{}\"", aws());
    repo.commit_file("dienst.py", format!("{line}\n"), "Dienst");

    let first = scan(&tc, &id).await;
    assert_eq!(first.findings.len(), 1);
    let expected: String = Sha256::digest([b"dienst.py".as_slice(), b"\0", line.as_bytes()].concat()).iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(first.findings[0].id, expected, "the ID is the hash of path and line content");
    assert_eq!(tc.db.with(|c| ignore_ids(c, &id, &[expected.clone()])).unwrap(), 1);
    let stored = serde_json::to_string(&tc.db.with(|c| crate::db::repo_settings::get_all(c, &id)).unwrap()).unwrap();
    assert!(!stored.contains(&aws()) && !stored.contains("W3NB") && stored.contains(&expected), "only the hash is stored: {stored}");
    assert!(scan(&tc, &id).await.findings.is_empty());

    // Rebased (a new commit with the same line in the same file): stays quiet.
    repo.git(&["commit", "-q", "--amend", "-m", "Dienst (neu geschrieben)"]);
    assert!(scan(&tc, &id).await.findings.is_empty(), "the ID does not depend on the commit");
    // The same key in another line or another file is reported.
    repo.commit_file("dienst.py", format!("{line}\n# {line}\n"), "Kommentar");
    repo.commit_file("kopie.py", format!("{line}\n"), "Kopie");
    let again = scan(&tc, &id).await;
    assert_eq!(again.findings.iter().map(|f| (f.path.as_str(), f.line)).collect::<Vec<_>>(), vec![("dienst.py", 2), ("kopie.py", 1)]);

    // Only IDs are accepted; the newest MAX_IGNORED are kept.
    assert_eq!(tc.db.with(|c| ignore_ids(c, &id, &["W3NB".to_string()])).unwrap_err().code, ErrorCode::NotAllowed);
    let many: Vec<String> = (0..MAX_IGNORED + 5).map(|n| format!("{n:064x}")).collect();
    assert_eq!(tc.db.with(|c| ignore_ids(c, &id, &many)).unwrap(), MAX_IGNORED);
    let kept = tc.db.with(|c| ignored_ids(c, &id)).unwrap();
    assert!(kept.contains(&many[many.len() - 1]) && !kept.contains(&expected), "the oldest go first");
    tc.db.with(|c| forget_ignored(c, &id)).unwrap();
    assert!(tc.db.with(|c| ignored_ids(c, &id)).unwrap().is_empty());
}

#[tokio::test]
async fn a_huge_first_push_stops_at_the_limit_and_says_so() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    // 1 001 commits in one fast-import; the key sits in the oldest one.
    let mut stream = Vec::new();
    for n in 1..=(MAX_COMMITS + 1) {
        let (file, content) = if n == 1 { ("alt.txt".to_string(), format!("{}\n", token())) } else { (format!("teil/{n:04}.txt"), format!("zeile {n}\n")) };
        let message = format!("Teil {n}\n");
        stream.extend_from_slice(
            format!("commit refs/heads/main\ncommitter Test <test@example.com> {} +0100\ndata {}\n{message}M 100644 inline {file}\ndata {}\n{content}\n", 1_500_000_000 + n, message.len(), content.len())
                .as_bytes(),
        );
    }
    let mut child = Command::new("git")
        .current_dir(repo.path())
        .envs(git_isolation_env(&repo.temp_dir().join("gitconfig")))
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("git fast-import");
    child.stdin.take().expect("stdin").write_all(&stream).expect("stream");
    assert!(child.wait().expect("fast-import").success());
    assert_eq!(repo.git(&["rev-list", "--count", "main"]), (MAX_COMMITS + 1).to_string());
    let remote = TestRemote::new();
    repo.git(&["remote", "add", "origin", &remote.url()]);
    let id = tc.open(&repo).await.repo.id;

    let started = Instant::now();
    let result = scan(&tc, &id).await;
    assert_eq!((result.commits as usize, result.partial), (MAX_COMMITS, true));
    assert!(result.findings.is_empty(), "the oldest commit lies beyond the limit: {:?}", result.findings);
    assert!(started.elapsed().as_secs() < 30, "the stream stops instead of reading everything: {:?}", started.elapsed());
}
