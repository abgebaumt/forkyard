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

use crate::jobs::CancelToken;
use crate::model::{AgentCollision, CollisionFile, CollisionKind, CollisionSkip, LineRange};

fn overlap_file(path: &str) -> CollisionFile {
    CollisionFile { path: path.to_string(), conflict: false, ranges: Vec::new() }
}

#[tokio::test]
async fn two_agents_with_uncommitted_changes_collide_with_line_ranges() {
    let (tc, repo, id) = setup().await;
    repo.write_file("src/auth.ts", numbered(80, 0, 0, ""));
    // An old base commit from other time zones.
    repo.commit_as_dates("Anmeldung aus alter Zeit", "Ältere Person", "alt@example.com", "@1234567890 +1300", "@1234567899 -0930");
    let (_a, folder_a) = agent_without_session(&tc, &repo, &id, "a-login").await;
    let (_b, folder_b) = agent_without_session(&tc, &repo, &id, "b-auth").await;
    // a: uncommitted, plus an untracked file only it has; b: committed on its branch.
    std::fs::write(folder_a.join("src/auth.ts"), numbered(80, 40, 62, "a")).unwrap();
    std::fs::write(folder_a.join("notiz a.txt"), "nur a\n").unwrap();
    std::fs::write(folder_b.join("src/auth.ts"), numbered(80, 40, 62, "b")).unwrap();
    repo.git(&["-C", &dir(&folder_b), "commit", "-q", "-am", "B ändert die Anmeldung"]);
    let porcelain = |folder: &Path| repo.git(&["-C", &dir(folder), "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let looks = || (repo.git(&["for-each-ref"]), porcelain(repo.path()), porcelain(&folder_a), porcelain(&folder_b));
    let before = looks();
    tc.events.clear();

    let computed = compute(&tc, &id, &CancelToken::new()).await.unwrap();
    // Both changed lines 40–62 (fixture); a was started first (same time, smaller id) and is "ours".
    assert_eq!(
        computed.collisions,
        vec![AgentCollision {
            id: "agent-a-login+agent-b-auth".into(),
            kind: CollisionKind::Conflict,
            agent_id: "agent-a-login".into(),
            other_agent_id: Some("agent-b-auth".into()),
            base: None,
            files: vec![CollisionFile { path: "src/auth.ts".into(), conflict: true, ranges: vec![LineRange { start: 40, end: 62 }] }],
        }]
    );
    assert!(computed.skipped.is_empty());
    // The result tree is kept for the preview and holds both sides.
    let stored = &computed.stored["agent-a-login+agent-b-auth"];
    assert_eq!(stored.files, vec![("src/auth.ts".to_string(), b"src/auth.ts".to_vec())]);
    let merged = repo.git(&["cat-file", "blob", &format!("{}:src/auth.ts", stored.tree)]);
    assert!(merged.contains("a 40\n") && merged.contains("b 62\n"), "{merged}");
    // Nothing changed: refs, the three working directories and their indexes; no repo:changed.
    assert_eq!(looks(), before);
    assert_eq!(tc.events.count(crate::events::names::REPO_CHANGED), 0);
}

#[tokio::test]
async fn overlaps_without_conflict_renames_and_disjoint_files() {
    let (tc, repo, id) = setup().await;
    repo.write_file("f.txt", numbered(10, 0, 0, ""));
    repo.write_file("alt.txt", "eins\nzwei\ndrei\n");
    repo.write_file("x.txt", "x\n");
    repo.commit_file("y.txt", "y\n", "Basis");
    let (_a, folder_a) = agent_without_session(&tc, &repo, &id, "a-umbenennen").await;
    let (_b, folder_b) = agent_without_session(&tc, &repo, &id, "b-ergaenzen").await;
    // a: line 2 of f.txt, renames alt.txt, x.txt. b: line 9 of f.txt, edits alt.txt, y.txt.
    std::fs::write(folder_a.join("f.txt"), numbered(10, 2, 2, "a")).unwrap();
    repo.git(&["-C", &dir(&folder_a), "mv", "alt.txt", "neu name.txt"]);
    std::fs::write(folder_a.join("x.txt"), "x von a\n").unwrap();
    std::fs::write(folder_b.join("f.txt"), numbered(10, 9, 9, "b")).unwrap();
    std::fs::write(folder_b.join("alt.txt"), "eins\nzwei\ndrei\nvier\n").unwrap();
    std::fs::write(folder_b.join("y.txt"), "y von b\n").unwrap();

    let computed = compute(&tc, &id, &CancelToken::new()).await.unwrap();
    // Git merges both (the rename takes b's line along): the same files, but no conflict.
    assert_eq!(
        computed.collisions,
        vec![AgentCollision {
            id: "agent-a-umbenennen+agent-b-ergaenzen".into(),
            kind: CollisionKind::Overlap,
            agent_id: "agent-a-umbenennen".into(),
            other_agent_id: Some("agent-b-ergaenzen".into()),
            base: None,
            files: vec![overlap_file("alt.txt"), overlap_file("f.txt")],
        }]
    );
    assert!(computed.stored.is_empty());

    // a takes back f.txt and the rename: only x.txt and y.txt are left – nothing in common.
    std::fs::write(folder_a.join("f.txt"), numbered(10, 0, 0, "")).unwrap();
    repo.git(&["-C", &dir(&folder_a), "mv", "neu name.txt", "alt.txt"]);
    assert!(compute(&tc, &id, &CancelToken::new()).await.unwrap().collisions.is_empty());
}

#[tokio::test]
async fn the_base_tip_counts_and_a_rebased_agent_is_measured_from_its_new_fork() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("g.txt", "eins\nzwei\ndrei\n", "Basis");
    let (_a, folder_a) = agent_without_session(&tc, &repo, &id, "a-zwei").await;
    let (_b, folder_b) = agent_without_session(&tc, &repo, &id, "b-neben").await;
    std::fs::write(folder_a.join("g.txt"), "eins\nzwei agent\ndrei\n").unwrap();
    repo.git(&["-C", &dir(&folder_a), "commit", "-q", "-am", "Agent ändert zwei"]);
    std::fs::write(folder_b.join("b.txt"), "neben\n").unwrap();
    repo.git(&["-C", &dir(&folder_b), "add", "b.txt"]);
    repo.git(&["-C", &dir(&folder_b), "commit", "-q", "-m", "Agent b"]);
    // main moves on: the same line as a, and a file b does not touch.
    repo.write_file("h.txt", "main\n");
    repo.commit_file("g.txt", "eins\nzwei main\ndrei\n", "Main ändert zwei");
    // b follows main.
    repo.git(&["-C", &dir(&folder_b), "rebase", "-q", "main"]);

    let computed = compute(&tc, &id, &CancelToken::new()).await.unwrap();
    // a against main's tip: line 2. b, measured from main's tip, has only b.txt – no collision,
    // although main's own changes are part of its branch now.
    assert_eq!(
        computed.collisions,
        vec![AgentCollision {
            id: "agent-a-zwei+base".into(),
            kind: CollisionKind::Conflict,
            agent_id: "agent-a-zwei".into(),
            other_agent_id: None,
            base: Some("main".into()),
            files: vec![CollisionFile { path: "g.txt".into(), conflict: true, ranges: vec![LineRange { start: 2, end: 2 }] }],
        }]
    );
}

#[tokio::test]
async fn paths_with_umlauts_spaces_leading_dashes_crlf_and_a_huge_file() {
    let (tc, repo, id) = setup().await;
    repo.write_file("-Größe übersicht.txt", "eins\r\nzwei\r\ndrei\r\n");
    repo.commit_file("groß/daten.csv", numbered(20_000, 0, 0, ""), "Basis");
    let (_a, folder_a) = agent_without_session(&tc, &repo, &id, "a-gross").await;
    let (_b, folder_b) = agent_without_session(&tc, &repo, &id, "b-gross").await;
    std::fs::write(folder_a.join("-Größe übersicht.txt"), "eins\r\nzwei\r\nDREI a\r\n").unwrap();
    std::fs::write(folder_b.join("-Größe übersicht.txt"), "eins\r\nzwei\r\ndrei b\r\n").unwrap();
    std::fs::write(folder_a.join("groß/daten.csv"), numbered(20_000, 15_001, 15_200, "a")).unwrap();
    std::fs::write(folder_b.join("groß/daten.csv"), numbered(20_000, 15_001, 15_200, "b")).unwrap();

    let computed = compute(&tc, &id, &CancelToken::new()).await.unwrap();
    assert_eq!(computed.collisions.len(), 1);
    assert_eq!(
        computed.collisions[0].files,
        vec![
            CollisionFile { path: "-Größe übersicht.txt".into(), conflict: true, ranges: vec![LineRange { start: 3, end: 3 }] },
            CollisionFile { path: "groß/daten.csv".into(), conflict: true, ranges: vec![LineRange { start: 15_001, end: 15_200 }] },
        ]
    );
}

#[tokio::test]
async fn orphaned_agents_are_left_out_and_broken_ones_named_with_a_reason() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "f\n", "Basis");
    let (_c, folder_c) = agent_without_session(&tc, &repo, &id, "c-weg").await;
    let (d, _folder_d) = agent_without_session(&tc, &repo, &id, "d-kaputt").await;
    // c's folder is gone (orphaned); d's recorded base exists no more.
    std::fs::remove_dir_all(&folder_c).unwrap();
    let broken = db::agents::AgentRow { base: "gibt-es-nicht".into(), base_sha: "0000000000000000000000000000000000000001".into(), ..d.clone() };
    tc.db
        .with(|c| {
            db::agents::delete(c, &d.id)?;
            db::agents::insert(c, &broken)
        })
        .unwrap();

    let computed = compute(&tc, &id, &CancelToken::new()).await.unwrap();
    assert!(computed.collisions.is_empty());
    assert_eq!(computed.skipped, vec![CollisionSkip { agent_id: "agent-d-kaputt".into(), reason: "The base commit 0000000 of the agent no longer exists.".into() }]);
}

use std::time::Duration;

use serde_json::json;

use crate::events::names;
use crate::model::{CollisionCheckState, RepoChange};

async fn wait_checks(tc: &TestCore, wanted: u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while checks_run(tc) < wanted {
        assert!(std::time::Instant::now() < deadline, "only {} checks, wanted {wanted}", checks_run(tc));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn changes_are_debounced_and_one_check_runs_at_a_time() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "f\n", "Basis");
    agent_without_session(&tc, &repo, &id, "a-eins").await;
    agent_without_session(&tc, &repo, &id, "b-zwei").await;
    // Off in tests by default, like the file watcher: nothing is scheduled.
    let agents = crate::commands::agents::agent_list(&tc, id.clone()).await.unwrap();
    let worktree = agents[0].worktree_repo_id.clone().unwrap();
    tc.emit_repo_changed(&worktree, &[RepoChange::Worktree]);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(checks_run(&tc), 0);

    set_enabled(&tc, true);
    set_timing(&tc, CollisionTiming { debounce: Duration::from_millis(150), max_delay: Duration::from_millis(600) });
    // The same set of agents again: no check. A new agent changes the set: the list checks right away.
    crate::commands::agents::agent_list(&tc, id.clone()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(checks_run(&tc), 0);
    agent_without_session(&tc, &repo, &id, "c-drei").await;
    crate::commands::agents::agent_list(&tc, id.clone()).await.unwrap();
    wait_checks(&tc, 1).await;
    // A burst of changes in a worktree (through the core's own event) gives one check.
    for _ in 0..4 {
        tc.emit_repo_changed(&worktree, &[RepoChange::Worktree]);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    wait_checks(&tc, 2).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(checks_run(&tc), 2);
    // Unknown repositories, changes that cannot move a tree and the main working directory start nothing.
    tc.emit_repo_changed("unbekannt", &[RepoChange::Worktree]);
    tc.emit_repo_changed(&worktree, &[RepoChange::Config]);
    tc.emit_repo_changed(&id, &[RepoChange::Worktree]);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(checks_run(&tc), 2);
    // The main repository's refs (the base may have moved) count.
    tc.emit_repo_changed(&id, &[RepoChange::Refs]);
    wait_checks(&tc, 3).await;
    // Changes that never stop are checked at the latest after max_delay.
    let start = checks_run(&tc);
    for _ in 0..60 {
        tc.emit_repo_changed(&worktree, &[RepoChange::Worktree]);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(checks_run(&tc) >= start + 2, "{} checks during 3 s of changes", checks_run(&tc) - start);
    tokio::time::sleep(Duration::from_millis(400)).await;
    // Manual checks wait for each other; no two checks ever ran at the same time.
    let (one, two) = tokio::join!(run_check(&tc, &id), run_check(&tc, &id));
    assert_eq!(one.unwrap().state, CollisionCheckState::Done);
    assert_eq!(two.unwrap().state, CollisionCheckState::Done);
    assert_eq!(peak_parallel(&tc), 1);
    // Every check is reported as "checking", then with its result.
    let events = tc.events.named(names::AGENT_COLLISIONS);
    assert!(events.iter().any(|e| e["state"] == json!("checking")));
    let last = events.last().unwrap();
    assert_eq!((last["repoId"].clone(), last["state"].clone()), (json!(id), json!("done")));
    assert_eq!(report(&tc, &id).state, CollisionCheckState::Done);
    // The agents changed nothing, so no conflict result is kept for a preview.
    assert_eq!(stored_conflict(&tc, &id, "a-eins+b-zwei", "f.txt"), None);
}

use crate::commands::agents::{agent_collision_check, agent_collision_preview, agent_collisions, agent_inform, MAX_INFORM_BYTES};
use crate::error::ErrorCode;
use crate::model::{CollisionBlock, CollisionPreview};

#[test]
fn the_preview_is_limited_in_blocks_and_lines() {
    let mut blob = Vec::new();
    for n in 1..=25 {
        blob.extend_from_slice(format!("<<<<<<< a\nA{n}\n=======\nB{n}\n>>>>>>> b\n").as_bytes());
    }
    let preview = preview_of("a+b", "f.txt", &blob);
    assert_eq!(preview.blocks.len(), MAX_PREVIEW_BLOCKS);
    assert!(preview.truncated);
    assert_eq!(preview.blocks[1], CollisionBlock { range: LineRange { start: 2, end: 2 }, ours: "A2\n".into(), theirs: "B2\n".into() });
    let mut long = b"<<<<<<< a\n".to_vec();
    for n in 1..=250 {
        long.extend_from_slice(format!("a {n}\n").as_bytes());
    }
    long.extend_from_slice(b"=======\nb\n>>>>>>> b\n");
    let preview = preview_of("a+b", "f.txt", &long);
    assert_eq!(preview.blocks[0].ours.lines().count(), MAX_PREVIEW_LINES);
    assert_eq!(preview.blocks[0].range, LineRange { start: 1, end: 250 });
    assert!(preview.truncated);
    let short = preview_of("a+b", "f.txt", b"<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
    assert_eq!(short, CollisionPreview { collision_id: "a+b".into(), path: "f.txt".into(), blocks: vec![CollisionBlock { range: LineRange { start: 1, end: 1 }, ours: "x\n".into(), theirs: "y\n".into() }], truncated: false });
}

#[tokio::test]
async fn the_preview_shows_both_sides_of_each_conflict() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("src/auth.ts", numbered(80, 0, 0, ""), "Basis");
    let (_a, folder_a) = agent_without_session(&tc, &repo, &id, "a-login").await;
    let (_b, folder_b) = agent_without_session(&tc, &repo, &id, "b-auth").await;
    std::fs::write(folder_a.join("src/auth.ts"), numbered(80, 40, 62, "a")).unwrap();
    std::fs::write(folder_b.join("src/auth.ts"), numbered(80, 40, 62, "b")).unwrap();
    // Never checked: pending.
    assert_eq!(agent_collisions(&tc, id.clone()).await.unwrap().state, CollisionCheckState::Pending);

    let report = agent_collision_check(&tc, id.clone()).await.unwrap();
    assert_eq!(report.state, CollisionCheckState::Done);
    assert!(report.checked_at.is_some());
    let preview = agent_collision_preview(&tc, id.clone(), "agent-a-login+agent-b-auth".into(), "src/auth.ts".into()).await.unwrap();
    let side = |prefix: &str| (40..=62).map(|n| format!("{prefix} {n}\n")).collect::<String>();
    assert_eq!(preview.blocks, vec![CollisionBlock { range: LineRange { start: 40, end: 62 }, ours: side("a"), theirs: side("b") }]);
    assert!(!preview.truncated);
    // Only files and collisions of the last report.
    let unknown_file = agent_collision_preview(&tc, id.clone(), "agent-a-login+agent-b-auth".into(), "README.md".into()).await.unwrap_err();
    assert_eq!(unknown_file.code, ErrorCode::NotFound);
    let unknown = agent_collision_preview(&tc, id.clone(), "x+y".into(), "src/auth.ts".into()).await.unwrap_err();
    assert_eq!(unknown.code, ErrorCode::NotFound);
    // The last report is kept.
    assert_eq!(agent_collisions(&tc, id.clone()).await.unwrap(), report);
}

#[tokio::test]
async fn an_untrusted_repository_is_refused_and_a_failed_check_is_a_state() {
    let (tc, _repo, id) = setup().await;
    tc.db.with(|c| db::repos::set_trusted(c, &id, false)).unwrap();
    assert_eq!(agent_collision_check(&tc, id.clone()).await.unwrap_err().code, ErrorCode::RepoUntrusted);
    assert_eq!(agent_collisions(&tc, id.clone()).await.unwrap_err().code, ErrorCode::RepoUntrusted);
    // A background check (no command in front of it) records the failure as a state.
    let report = run_check(&tc, &id).await.unwrap();
    assert_eq!(report.state, CollisionCheckState::Failed);
    assert!(report.error.as_deref().is_some_and(|e| !e.is_empty()), "{report:?}");
    assert_eq!(tc.events.named(names::AGENT_COLLISIONS).last().unwrap()["state"], json!("failed"));
}

#[tokio::test]
async fn informing_needs_a_running_agent_and_a_sensible_text() {
    let (tc, repo, id) = setup().await;
    let (row, _folder) = agent_without_session(&tc, &repo, &id, "still").await;
    let inform = |text: String| agent_inform(&tc, row.id.clone(), text);
    let not_running = inform("Bitte warten".into()).await.unwrap_err();
    assert_eq!((not_running.code, not_running.message.as_str()), (ErrorCode::NotAllowed, "“still” is not running – there is no terminal to type into."));
    let empty = inform("   \n".into()).await.unwrap_err();
    assert_eq!((empty.code, empty.message.as_str()), (ErrorCode::NotAllowed, "Write the note for the agent."));
    let long = inform("x".repeat(MAX_INFORM_BYTES + 1)).await.unwrap_err();
    assert_eq!((long.code, long.message.as_str()), (ErrorCode::NotAllowed, "The note is too long (more than 4 KB)."));
    assert_eq!(agent_inform(&tc, "gibt-es-nicht".into(), "x".into()).await.unwrap_err().code, ErrorCode::NotFound);
}
