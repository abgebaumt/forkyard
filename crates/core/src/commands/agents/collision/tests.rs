//! Collision warning against real temp repositories: snapshots, fork point, changed paths, the
//! check between agents and against the base, debounce, preview and informing an agent. Expected
//! values come from Git (`hash-object`, `rev-parse`, `rev-list`, `ls-tree`, `status`) or from the
//! fixtures as written – never from this module's own helpers.

use std::collections::BTreeSet;
use std::path::Path;

use super::*;
use crate::commands::agents::tests::{agent_without_session, setup};
use crate::db;
use crate::testkit::{TestCore, TestRepo};

fn worktree_id(tc: &TestCore, folder: &Path) -> String {
    tc.db.with(|c| db::repos::find_by_path(c, folder)).unwrap().expect("worktree row").id
}

fn dir(folder: &Path) -> String {
    folder.to_string_lossy().into_owned()
}

/// `total` lines "line n"; lines `from..=to` read "<side> n" instead.
fn numbered(total: u32, from: u32, to: u32, side: &str) -> String {
    (1..=total).map(|n| if n >= from && n <= to { format!("{side} {n}\n") } else { format!("line {n}\n") }).collect()
}

#[tokio::test]
async fn the_snapshot_holds_the_worktree_as_on_disk_and_touches_nothing() {
    let (tc, repo, id) = setup().await;
    repo.write_file("bleibt.txt", "bleibt\n");
    repo.write_file("weg.txt", "weg\n");
    repo.commit_file("crlf.txt", "eins\r\nzwei\r\n", "Basis");
    let (_row, folder) = agent_without_session(&tc, &repo, &id, "schnapp").await;
    let wt = worktree_id(&tc, &folder);
    let d = dir(&folder);
    // Staged, then changed again without staging; deleted; untracked with Latin-1 and a leading '-'.
    std::fs::write(folder.join("crlf.txt"), b"eins\r\nZWEI\r\nohne Ende").unwrap();
    repo.git(&["-C", &d, "add", "crlf.txt"]);
    std::fs::write(folder.join("crlf.txt"), b"eins\r\nZWEI\r\nnoch mehr, ungestagt").unwrap();
    std::fs::remove_file(folder.join("weg.txt")).unwrap();
    std::fs::write(folder.join("-neu übersicht.txt"), b"caf\xe9\n").unwrap();
    let status = |repo: &TestRepo| repo.git(&["-C", &d, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let status_before = status(&repo);
    let main_before = repo.git(&["status", "--porcelain=v1", "-z"]);
    let refs_before = repo.git(&["for-each-ref"]);
    let head = repo.git(&["-C", &d, "rev-parse", "HEAD"]);

    let (commit, tree) = snapshot_commit(&tc, &wt).await.unwrap();
    // A loose commit around the tree with the worktree's HEAD as its only parent.
    assert_eq!(repo.git(&["rev-parse", &format!("{commit}^{{tree}}")]), tree);
    assert_eq!(repo.git(&["rev-list", "--parents", "-n", "1", &commit]), format!("{commit} {head}"));
    // The files as they are on disk: the unstaged version, the untracked file, not the deleted one.
    let names: BTreeSet<String> = repo.git(&["ls-tree", "-r", "-z", "--name-only", &tree]).split('\0').filter(|n| !n.is_empty()).map(str::to_string).collect();
    let expected: BTreeSet<String> = ["-neu übersicht.txt", "README.md", "bleibt.txt", "crlf.txt"].into_iter().map(String::from).collect();
    assert_eq!(names, expected);
    for name in ["-neu übersicht.txt", "crlf.txt", "bleibt.txt"] {
        let on_disk = repo.git(&["hash-object", "--", &dir(&folder.join(name))]);
        assert_eq!(repo.git(&["rev-parse", &format!("{tree}:{name}")]), on_disk, "{name}");
    }
    // Nothing changed: index and files of the worktree, the main repository, the refs.
    assert_eq!(status(&repo), status_before);
    assert_eq!(repo.git(&["status", "--porcelain=v1", "-z"]), main_before);
    assert_eq!(repo.git(&["for-each-ref"]), refs_before);
}

#[tokio::test]
async fn the_fork_follows_a_rebase_and_changed_paths_are_byte_exact() {
    let (tc, repo, id) = setup().await;
    let b0 = repo.commit_file("g.txt", "eins\n", "Basis");
    let (_row, folder) = agent_without_session(&tc, &repo, &id, "gabel").await;
    let d = dir(&folder);
    let m1 = repo.commit_file("h.txt", "main\n", "Main geht weiter");

    // Not rebased: the work starts at the recorded base; the tip of main is reported.
    let head = repo.git(&["-C", &d, "rev-parse", "HEAD"]);
    assert_eq!(fork_point(&tc, &id, &head, "main", &b0).await.unwrap(), (b0.clone(), Some(m1.clone())));
    // Rebased onto main: the fork moves to main's tip.
    std::fs::write(folder.join("agent.txt"), "vom Agenten\n").unwrap();
    repo.git(&["-C", &d, "add", "agent.txt"]);
    repo.git(&["-C", &d, "commit", "-q", "-m", "Agent"]);
    repo.git(&["-C", &d, "rebase", "-q", "main"]);
    let head = repo.git(&["-C", &d, "rev-parse", "HEAD"]);
    assert_eq!(fork_point(&tc, &id, &head, "main", &b0).await.unwrap(), (m1.clone(), Some(m1.clone())));
    // A base that no longer exists, or one that looks like an option: the recorded base commit.
    assert_eq!(fork_point(&tc, &id, &head, "gibt-es-nicht", &b0).await.unwrap(), (b0.clone(), None));
    assert_eq!(fork_point(&tc, &id, &head, "--all", &b0).await.unwrap(), (b0.clone(), None));

    // Changed against the fork: added, renamed (both names), deleted – as bytes.
    std::fs::write(folder.join("-Größe übersicht.txt"), "x\n").unwrap();
    std::fs::remove_file(folder.join("g.txt")).unwrap();
    repo.git(&["-C", &d, "mv", "README.md", "Lies mich.md"]);
    let (_, tree) = snapshot_commit(&tc, &worktree_id(&tc, &folder)).await.unwrap();
    let changed = changed_paths(&tc, &id, &m1, &tree).await.unwrap();
    let expected: BTreeSet<Vec<u8>> = ["-Größe übersicht.txt", "Lies mich.md", "README.md", "agent.txt", "g.txt"].iter().map(|p| p.as_bytes().to_vec()).collect();
    assert_eq!(changed, expected);
}
