//! Tests for `file_blame_job` – against real temp repositories, with `git blame -l -s` as the oracle.

use std::sync::atomic::{AtomicU32, Ordering};

use super::*;
use crate::error::ErrorCode;
use crate::events::names;
use crate::testkit::{TestCore, TestRepo};

async fn setup(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    tc.events.clear();
    tc.git.take_spawned();
    (tc, id)
}

fn new_job_id() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    format!("blame-{}", NEXT.fetch_add(1, Ordering::SeqCst))
}

async fn job(tc: &TestCore, id: &str, path: &str, sha: Option<&str>) -> CoreResult<Vec<BlameLine>> {
    file_blame_job(tc, id.to_string(), new_job_id(), path.to_string(), sha.map(str::to_string), None).await
}

async fn porcelain(tc: &TestCore, id: &str, path: &str, sha: Option<&str>) -> Vec<BlameLine> {
    file_blame(tc, id.to_string(), path.to_string(), sha.map(str::to_string), None).await.unwrap()
}

/// Whether a `git blame` was started since the last call.
fn spawned_blame(tc: &TestCore) -> bool {
    tc.git.take_spawned().iter().any(|argv| argv.iter().any(|a| a == "blame"))
}

/// `git blame -l -s [rev] -- path` as (sha, line number) per line. `--root`: a boundary commit
/// would be printed as `^` and only 39 hex digits.
fn git_blame_oracle(repo: &TestRepo, rev: Option<&str>, path: &str) -> Vec<(String, u32)> {
    let mut args = vec!["blame", "-l", "-s", "--root"];
    args.extend(rev);
    args.extend(["--", path]);
    repo.git(&args)
        .lines()
        .map(|line| {
            let (sha, rest) = line.split_at(40);
            let number = rest[..rest.find(") ").or_else(|| rest.find(')')).unwrap()].split_whitespace().last().unwrap();
            (sha.to_string(), number.parse().unwrap())
        })
        .collect()
}

fn sha_and_line(lines: &[BlameLine]) -> Vec<(String, u32)> {
    lines.iter().map(|l| (l.sha.clone(), l.line_no)).collect()
}

/// Uncommitted lines carry the time of the blame run; everything else must match exactly.
fn without_run_time(mut lines: Vec<BlameLine>) -> Vec<BlameLine> {
    for line in lines.iter_mut().filter(|l| l.uncommitted) {
        line.authored_at.clear();
    }
    lines
}

#[tokio::test]
async fn job_lines_match_git_blame_on_hard_files() {
    let repo = TestRepo::new();
    let name = "-bindestrich.txt";
    repo.commit_file("alt.txt", "eins\nzwei\ndrei\nvier\n", "Erster Stand");
    repo.git(&["mv", "--", "alt.txt", name]);
    repo.write_file(name, b"eins\nzwei\r\nGr\xfc\xdfe\ndrei\nvier\n".as_slice());
    repo.commit("Umbenannt, Latin-1 und CRLF");
    repo.commit_file(name, b"eins\nzwei\r\nGr\xfc\xdfe\nDREI\r\nvier ohne Ende".as_slice(), "Ohne Zeilenumbruch am Ende");
    let head = repo.head();
    repo.write_file(name, b"eins\nzwei\r\nGr\xfc\xdfe\nneu\nDREI\r\nvier ohne Ende".as_slice());
    let (tc, id) = setup(&repo).await;

    for rev in [Some(head.as_str()), None] {
        let lines = job(&tc, &id, name, rev).await.unwrap();
        assert_eq!(sha_and_line(&lines), git_blame_oracle(&repo, rev, name), "rev {rev:?}");
        let expected = porcelain(&tc, &id, name, rev).await;
        assert_eq!(lines.iter().map(|l| &l.text).collect::<Vec<_>>(), expected.iter().map(|l| &l.text).collect::<Vec<_>>());
        assert_eq!(without_run_time(lines), without_run_time(expected), "rev {rev:?}");
    }
    let worktree = job(&tc, &id, name, None).await.unwrap();
    assert_eq!(worktree[2].text, "Grüße");
    assert_eq!(worktree.iter().map(|l| l.uncommitted).collect::<Vec<_>>(), [false, false, false, true, false, false]);
    assert_eq!(worktree[3].author.name, ZERO_AUTHOR);
}

#[tokio::test]
async fn chunks_bring_the_text_first_then_spans_and_progress() {
    let repo = TestRepo::new();
    let mut lines: Vec<String> = (0..6000).map(|i| format!("Zeile {i}")).collect();
    repo.commit_file("viel.txt", lines.join("\n") + "\n", "Eins");
    for (n, at) in [(2, 1500), (3, 3000), (4, 4500)] {
        lines[at] = format!("Geändert in Stand {n}");
        repo.commit_file("viel.txt", lines.join("\n") + "\n", &format!("Stand {n}"));
    }
    let (tc, id) = setup(&repo).await;
    let job_id = new_job_id();
    let result = file_blame_job(&tc, id.clone(), job_id.clone(), "viel.txt".into(), None, None).await.unwrap();
    assert_eq!(result.len(), 6000);

    let chunks = tc.events.named(names::BLAME_CHUNK);
    assert!(chunks.iter().all(|c| c["jobId"] == job_id.as_str() && c["repoId"] == id.as_str() && c["total"] == 6000));
    let first = &chunks[0];
    assert_eq!((first["text"].as_array().unwrap().len(), first["done"].as_u64()), (6000, Some(0)));
    assert_eq!(first["text"][1500], "Geändert in Stand 2");
    assert!(first["spans"].as_array().unwrap().is_empty());
    let mut covered = vec![0u32; 6000];
    for chunk in &chunks[1..] {
        assert!(chunk["text"].is_null());
        for span in chunk["spans"].as_array().unwrap() {
            let (start, count) = (span["startLine"].as_u64().unwrap() as usize, span["count"].as_u64().unwrap() as usize);
            for slot in &mut covered[start - 1..start - 1 + count] {
                *slot += 1;
            }
        }
    }
    assert!(covered.iter().all(|&n| n == 1), "every line exactly once");
    assert_eq!(chunks.last().unwrap()["done"], 6000);

    let dones: Vec<u64> = chunks.iter().map(|c| c["done"].as_u64().unwrap()).collect();
    assert!(dones.windows(2).all(|w| w[0] <= w[1]), "{dones:?}");
    // Blame jobs stay out of the status bar's job list.
    assert_eq!(tc.events.count(names::JOB_PROGRESS), 0);
    assert_eq!(tc.events.named(names::JOB_DONE).iter().filter(|d| d["jobId"] == job_id.as_str()).count(), 1);
}

#[tokio::test]
async fn second_run_comes_from_the_cache_without_git_blame() {
    let repo = TestRepo::new();
    let sha = repo.commit_file("a.txt", "eins\nzwei\n", "Eins");
    let (tc, id) = setup(&repo).await;
    for rev in [Some(sha.as_str()), None] {
        let first = job(&tc, &id, "a.txt", rev).await.unwrap();
        assert!(spawned_blame(&tc));
        tc.events.clear();
        let second = job(&tc, &id, "a.txt", rev).await.unwrap();
        assert_eq!(second, first);
        assert!(!spawned_blame(&tc), "rev {rev:?}");
        assert_eq!(tc.events.count(names::BLAME_CHUNK), 0);
        assert_eq!(tc.events.count(names::JOB_PROGRESS), 0);
        assert_eq!(tc.events.named(names::JOB_DONE)[0]["ok"], true);
    }
}

#[tokio::test]
async fn an_edited_worktree_file_misses_the_cache() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "eins\nzwei\ndrei\n", "Eins");
    let (tc, id) = setup(&repo).await;
    assert!(job(&tc, &id, "a.txt", None).await.unwrap().iter().all(|l| !l.uncommitted));
    tc.git.take_spawned();
    repo.write_file("a.txt", "eins\nZWEI\ndrei\n");
    let lines = job(&tc, &id, "a.txt", None).await.unwrap();
    assert_eq!(lines.iter().map(|l| l.uncommitted).collect::<Vec<_>>(), [false, true, false]);
    assert!(spawned_blame(&tc));
}

#[tokio::test]
async fn a_cancelled_job_caches_nothing() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "eins\n", "Eins");
    let (tc, id) = setup(&repo).await;
    let job_id = new_job_id();
    tc.jobs.cancel(&job_id);
    let err = file_blame_job(&tc, id.clone(), job_id.clone(), "a.txt".into(), None, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert_eq!(tc.events.named(names::JOB_DONE)[0]["cancelled"], true);
    tc.git.take_spawned();
    job(&tc, &id, "a.txt", None).await.unwrap();
    assert!(spawned_blame(&tc), "nothing was cached");
}

#[tokio::test]
async fn the_cache_keeps_the_32_most_recently_used() {
    let repo = TestRepo::new();
    for n in 0..=BLAME_CACHE_SIZE {
        repo.write_file(&format!("f{n}.txt"), format!("Datei {n}\n"));
    }
    let head = repo.commit("Viele Dateien");
    let (tc, id) = setup(&repo).await;
    let blame = |n: usize| {
        let (tc, id, head) = (&tc, &id, &head);
        async move { job(tc, id, &format!("f{n}.txt"), Some(head)).await.unwrap() }
    };
    for n in 0..BLAME_CACHE_SIZE {
        blame(n).await;
        if n > 0 {
            // Keeps file 0 the most recently used.
            blame(0).await;
        }
    }
    blame(BLAME_CACHE_SIZE).await;
    tc.git.take_spawned();
    blame(0).await;
    assert!(!spawned_blame(&tc), "file 0 was used recently");
    blame(1).await;
    assert!(spawned_blame(&tc), "file 1 was the least recently used");
}

#[tokio::test]
async fn untracked_binary_missing_and_bad_input_behave_like_file_blame() {
    let repo = TestRepo::new();
    repo.commit_file("bild.bin", [1u8, 0, 2, 0, 3], "Binär");
    let sha = repo.commit_file("text.txt", "a\n", "Text");
    repo.write_file("neu.txt", "x\ny\n");
    let (tc, id) = setup(&repo).await;

    let untracked = job(&tc, &id, "neu.txt", None).await.unwrap();
    assert!(untracked.len() == 2 && untracked.iter().all(|l| l.uncommitted));
    assert!(!spawned_blame(&tc));
    let code = |r: CoreResult<Vec<BlameLine>>| r.unwrap_err().code;
    assert_eq!(code(job(&tc, &id, "bild.bin", None).await), ErrorCode::Unsupported);
    assert_eq!(code(job(&tc, &id, "bild.bin", Some(&sha)).await), ErrorCode::Unsupported);
    assert_eq!(code(job(&tc, &id, "fehlt.txt", None).await), ErrorCode::NotFound);
    assert_eq!(code(job(&tc, &id, "fehlt.txt", Some(&sha)).await), ErrorCode::NotFound);
    assert_eq!(code(job(&tc, &id, "text.txt", Some("--output=x")).await), ErrorCode::NotAllowed);
    assert_eq!(code(job(&tc, &id, "../x", None).await), ErrorCode::NotAllowed);

    let running = tc.start_job("läuft", Some(&id)).unwrap();
    let duplicate = file_blame_job(&tc, id.clone(), "läuft".into(), "text.txt".into(), None, None).await;
    assert_eq!(code(duplicate), ErrorCode::Duplicate);
    running.finish::<()>(&Ok(()));
}

#[cfg(unix)]
#[tokio::test]
async fn a_clean_filter_that_changes_the_lines_falls_back_to_gits_text() {
    let repo = TestRepo::new();
    repo.commit_file("a.dat", "eins\nzwei\n", "Eins");
    repo.write_file(".gitattributes", "*.dat filter=dbl\n");
    repo.git(&["config", "filter.dbl.clean", "sed p"]);
    let (tc, id) = setup(&repo).await;

    let lines = job(&tc, &id, "a.dat", None).await.unwrap();
    assert_eq!(lines.len(), 4, "Git's cleaned text, not the two lines on disk");
    assert_eq!(without_run_time(lines.clone()), without_run_time(porcelain(&tc, &id, "a.dat", None).await));
    tc.git.take_spawned();
    assert_eq!(job(&tc, &id, "a.dat", None).await.unwrap(), lines, "cached");
    assert!(!spawned_blame(&tc));
}

#[cfg(unix)]
#[tokio::test]
async fn a_cancel_during_the_fallback_caches_nothing() {
    let repo = TestRepo::new();
    repo.commit_file("a.dat", "eins\nzwei\n", "Eins");
    repo.write_file(".gitattributes", "*.dat filter=dbl\n");
    // Run 1 is `blame --incremental`; from run 2 on (the fallback `file_blame`) the filter waits for `go`.
    let git_dir = repo.path().join(".git").display().to_string();
    repo.write_file(
        "filter.sh",
        format!(
            "n=$(cat '{git_dir}/runs' 2>/dev/null || echo 0); echo $((n + 1)) > '{git_dir}/runs'\n\
             if [ \"$n\" -ge 1 ]; then touch '{git_dir}/waiting'; while [ ! -e '{git_dir}/go' ]; do sleep 0.01; done; fi\n\
             sed p\n"
        ),
    );
    let filter = repo.path().join("filter.sh").display().to_string();
    repo.git(&["config", "filter.dbl.clean", &format!("sh '{filter}'")]);
    let (tc, id) = setup(&repo).await;

    let job_id = new_job_id();
    let waiting = repo.path().join(".git/waiting");
    let cancel = async {
        while !waiting.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        tc.jobs.cancel(&job_id);
        std::fs::write(repo.path().join(".git/go"), "").unwrap();
    };
    let (result, ()) = tokio::join!(file_blame_job(&tc, id.clone(), job_id.clone(), "a.dat".into(), None, None), cancel);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);

    tc.git.take_spawned();
    assert_eq!(job(&tc, &id, "a.dat", None).await.unwrap().len(), 4);
    assert!(spawned_blame(&tc), "nothing was cached");
}

#[cfg(unix)]
#[tokio::test]
async fn worktree_files_that_clean_to_the_same_blob_do_not_share_a_cache_entry() {
    let repo = TestRepo::new();
    repo.commit_file("a.up", "EINS\n", "Eins");
    repo.write_file(".gitattributes", "*.up filter=up\n");
    repo.git(&["config", "filter.up.clean", "tr a-z A-Z"]);
    repo.write_file("a.up", "eins\n");
    let (tc, id) = setup(&repo).await;

    assert_eq!(job(&tc, &id, "a.up", None).await.unwrap()[0].text, "eins");
    repo.write_file("a.up", "Eins\n");
    assert_eq!(job(&tc, &id, "a.up", None).await.unwrap()[0].text, "Eins", "the displayed bytes changed");
}
