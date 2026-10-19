//! File watching tests with real files. File system events arrive sluggishly
//! (especially on Windows), so we wait generously: up to 30 s for an expected event,
//! a multiple of the debounce time for “nothing arrives”.

use std::collections::BTreeSet;
use std::process::Stdio;

use super::*;
use crate::events::names;
use crate::testkit::{git_isolation_env, TestCore, TestRepo};

const PATIENCE: Duration = Duration::from_secs(30);
/// Clearly longer than the debounce time plus the time the system needs for delivery.
const QUIET: Duration = Duration::from_millis(1500);

async fn watched(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    set_enabled(&tc, true);
    let id = tc.open(repo).await.repo.id;
    assert!(wait_until_watching(&tc, &id, PATIENCE).await, "watching did not start");
    tc.events.clear();
    (tc, id)
}

/// All kinds reported for the repository so far, merged across all events.
fn kinds(tc: &TestCore, id: &str) -> BTreeSet<String> {
    tc.events
        .named(names::REPO_CHANGED)
        .iter()
        .filter(|e| e["repoId"] == id)
        .flat_map(|e| e["what"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

fn event_count(tc: &TestCore) -> usize {
    tc.events.count(names::REPO_CHANGED)
}

/// Waits until all of `wanted` have been reported.
async fn wait_for(tc: &TestCore, id: &str, wanted: &[&str]) -> BTreeSet<String> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let seen = kinds(tc, id);
        if wanted.iter().all(|w| seen.contains(*w)) {
            return seen;
        }
        assert!(Instant::now() < deadline, "expected {wanted:?}, only reported {seen:?}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Waits until no event has arrived for a while, returns everything reported and clears the collector.
async fn settle(tc: &TestCore, id: &str) -> BTreeSet<String> {
    let mut count = event_count(tc);
    let mut since = Instant::now();
    while since.elapsed() < QUIET {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if event_count(tc) != count {
            count = event_count(tc);
            since = Instant::now();
        }
    }
    let seen = kinds(tc, id);
    tc.events.clear();
    seen
}

/// Stops watching and waits until the system's watcher is really gone.
async fn shutdown(tc: &TestCore, id: &str) {
    let phase = tc.state::<Watchers>().running.lock().get(id).map(|r| r.phase.clone());
    stop_watching(tc, id).unwrap();
    if let Some(mut phase) = phase {
        let _ = tokio::time::timeout(PATIENCE, async {
            while *phase.borrow_and_update() != Phase::Stopped {
                if phase.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn git_in(dir: &Path, config: &Path, args: &[&str]) -> String {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(dir).stdin(Stdio::null());
    for (key, value) in git_isolation_env(config) {
        cmd.env(key, value);
    }
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

// --- Classification (pure functions) ---------------------------------------------

#[test]
fn git_paths_are_classified() {
    let whole = |rel: &str| classify_git_path(rel, GitScope::Whole).map(|h| h.change);
    assert_eq!(whole("index"), Some(RepoChange::Index));
    assert_eq!(whole("HEAD"), Some(RepoChange::Head));
    assert_eq!(whole("refs/heads/main"), Some(RepoChange::Refs));
    assert_eq!(whole("refs/heads/feature/x"), Some(RepoChange::Refs));
    assert_eq!(whole("refs/remotes/origin/main"), Some(RepoChange::Refs));
    assert_eq!(whole("refs/tags/v1"), Some(RepoChange::Refs));
    assert_eq!(whole("refs/heads"), Some(RepoChange::Refs));
    assert_eq!(whole("packed-refs"), Some(RepoChange::Refs));
    assert_eq!(whole("refs/stash"), Some(RepoChange::Stash));
    assert_eq!(whole("logs/refs/stash"), Some(RepoChange::Stash));
    assert_eq!(whole("config"), Some(RepoChange::Config));
    assert_eq!(whole("info/exclude"), Some(RepoChange::Worktree));
    for op in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-merge/done", "rebase-apply/next", "sequencer/todo", "BISECT_START", "BISECT_LOG", "BISECT_TERMS"] {
        assert_eq!(whole(op), Some(RepoChange::Operation), "{op}");
    }
    assert_eq!(whole("modules/sub/HEAD"), Some(RepoChange::Worktree));

    // Lock files, objects, logs, our own backup refs and everything else: nothing.
    for quiet in [
        "",
        "index.lock",
        "HEAD.lock",
        "config.lock",
        "packed-refs.lock",
        "refs/heads/main.lock",
        "objects/ab/cdef",
        "objects/pack/pack-1.pack",
        "logs/HEAD",
        "logs/refs/heads/main",
        "ORIG_HEAD",
        "FETCH_HEAD",
        "COMMIT_EDITMSG",
        "hooks/pre-commit",
        "refs/forkyard/undo/1/before",
        "refs/forkyard",
        "worktrees/andere/HEAD",
        "worktrees/andere/index",
        "modules/sub/objects/ab/cd",
        "rebase-mergeX",
        "indexfoo",
        "description",
    ] {
        assert_eq!(whole(quiet), None, "{quiet}");
    }
    assert!(classify_git_path("index", GitScope::Whole).unwrap().affects_ignore);
    assert!(classify_git_path("config", GitScope::Whole).unwrap().affects_ignore);
    assert!(!classify_git_path("HEAD", GitScope::Whole).unwrap().affects_ignore);

    // Worktree: HEAD, index and state files live in its own part, refs and config in the shared one.
    let private = |rel: &str| classify_git_path(rel, GitScope::Private).map(|h| h.change);
    let shared = |rel: &str| classify_git_path(rel, GitScope::Shared).map(|h| h.change);
    assert_eq!(private("HEAD"), Some(RepoChange::Head));
    assert_eq!(private("index"), Some(RepoChange::Index));
    assert_eq!(private("MERGE_HEAD"), Some(RepoChange::Operation));
    assert_eq!(private("rebase-merge/done"), Some(RepoChange::Operation));
    // Bisect state and refs/bisect are per worktree.
    assert_eq!(private("BISECT_START"), Some(RepoChange::Operation));
    assert_eq!(private("refs/bisect/bad"), Some(RepoChange::Refs));
    assert_eq!((private("refs/heads/x"), private("config"), private("packed-refs")), (None, None, None));
    assert_eq!(shared("refs/heads/x"), Some(RepoChange::Refs));
    assert_eq!(shared("refs/stash"), Some(RepoChange::Stash));
    assert_eq!(shared("config"), Some(RepoChange::Config));
    // HEAD and index of the main working directory are no concern of a worktree.
    assert_eq!((shared("HEAD"), shared("index"), shared("MERGE_HEAD"), shared("rebase-merge/done")), (None, None, None, None));
}

#[test]
fn path_helpers() {
    let base = Path::new("/r/Mein Repo");
    assert_eq!(rel_bytes(base, &base.join("src").join("Größe.rs")).unwrap(), "src/Größe.rs".as_bytes());
    assert_eq!(rel_bytes(base, base).unwrap(), b"");
    assert_eq!(rel_bytes(base, Path::new("/r/anderes/x")), None);
    assert_eq!(ancestors(b"a/b/c.txt").collect::<Vec<_>>(), [b"a".as_slice(), b"a/b"]);
    assert_eq!(ancestors(b"datei").count(), 0);
    assert_eq!(find_git_component(b"sub/.git/HEAD"), Some(4));
    assert_eq!(find_git_component(b"a/b/.git/refs/heads/x"), Some(4));
    assert_eq!(find_git_component(b".git/HEAD"), None);
    assert_eq!(find_git_component(b"sub/.git"), None);
    assert_eq!(find_git_component(b"sub/.github/x"), None);
}

#[test]
fn intake_sorts_raw_paths() {
    let root = PathBuf::from("/r/repo");
    let mut intake = Intake::new(root.clone(), true, Vec::new());
    intake.ignored_dirs.insert(b"node_modules".to_vec());
    intake.ignored_dirs.insert(b"pakete/app/target".to_vec());
    let at = |rel: &str| rel.split('/').fold(root.clone(), |p, part| p.join(part));
    let mut relevant = Vec::new();
    for rel in [
        "node_modules",
        "node_modules/a/b/index.js",
        "pakete/app/target/debug/x.o",
        "pakete/app/src/main.rs",
        "sub/.git/objects/ab/cd",
        "sub/.git/HEAD",
        "sub/.git",
        "Über uns.txt",
        ".git/objects/ab/cd",
        ".git/index.lock",
        ".git/index",
        ".git/refs/heads/main",
        ".git",
    ] {
        if intake.absorb_path(&at(rel), false) {
            relevant.push(rel);
        }
    }
    assert!(!intake.absorb_path(Path::new("/ganz/woanders"), true));
    assert!(!intake.absorb_path(&root, true));
    // Only what could be reported extends the quiet period.
    assert_eq!(relevant, ["pakete/app/src/main.rs", "sub/.git/HEAD", "Über uns.txt", ".git/index", ".git/refs/heads/main"]);
    assert_eq!(intake.pending.kinds, [RepoChange::Index, RepoChange::Refs].into_iter().collect());
    let paths: Vec<String> = intake.pending.paths.iter().map(|p| util::decode_lossy(p)).collect();
    assert_eq!(paths, ["pakete/app/src/main.rs", "sub", "Über uns.txt"]);
    assert!(intake.pending.new_dirs.is_empty());
    // The index change has cleared the memory of ignored folders …
    assert!(intake.ignored_dirs.is_empty());
    // … and once “worktree” is settled for the burst, nothing more is collected.
    intake.pending.paths.clear();
    intake.pending.kinds.insert(RepoChange::Worktree);
    assert!(intake.absorb_path(&at("noch/eine.txt"), false));
    assert_eq!(intake.pending.unchecked(), 0);

    // Accesses (Linux reports open and close) don't count.
    let mut intake = Intake::new(root.clone(), true, Vec::new());
    let access = notify::Event::new(EventKind::Access(notify::event::AccessKind::Any)).add_path(at("a.txt"));
    assert!(!intake.absorb(&access));
    assert!(intake.pending.is_empty());
    let rescan = notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
    assert!(intake.absorb(&rescan));
    assert!(intake.pending.rescan);

    // Worktree: `.git` is a file, the Git directory lives elsewhere.
    let private = PathBuf::from("/r/haupt/.git/worktrees/wt");
    let shared = PathBuf::from("/r/haupt/.git");
    let roots = vec![GitRoot { path: private.clone(), scope: GitScope::Private }, GitRoot { path: shared.clone(), scope: GitScope::Shared }];
    let mut intake = Intake::new(root.clone(), false, roots);
    intake.absorb_path(&at(".git"), false);
    intake.absorb_path(&shared.join("index"), false);
    intake.absorb_path(&shared.join("HEAD"), false);
    intake.absorb_path(&shared.join("worktrees").join("andere").join("HEAD"), false);
    assert!(intake.pending.is_empty());
    intake.absorb_path(&private.join("HEAD"), false);
    intake.absorb_path(&shared.join("refs").join("heads").join("x"), false);
    assert_eq!(intake.pending.kinds, [RepoChange::Refs, RepoChange::Head].into_iter().collect());
}

#[tokio::test]
async fn ignore_check_learns_ignored_folders_and_judges_new_folders_by_content() {
    let repo = TestRepo::new();
    repo.commit_file(".gitignore", "node_modules/\n/target\n*.log\nvendor/\n", "Ignorieren");
    repo.write_file("node_modules/a/b/index.js", "x");
    repo.write_file("target/debug/app.o", "x");
    repo.write_file("vendor/lib/tracked.c", "x");
    repo.write_file("vendor/lib/untracked.c", "x");
    repo.git(&["add", "-f", "vendor/lib/tracked.c"]);
    repo.commit("Verfolgte Datei im ignorierten Ordner");
    repo.write_file("src/main.rs", "x");
    repo.write_file("src/debug.log", "x");
    repo.write_file("neu/nur ignoriert/x.log", "x");
    repo.write_file("frisch/tief/sichtbar.txt", "x");
    repo.subdir("leer");
    let tc = TestCore::new().await;
    tc.events.clear();
    let mut intake = Intake::new(repo.path().to_path_buf(), true, Vec::new());
    let paths = |items: &[&str]| items.iter().map(|p| p.as_bytes().to_vec()).collect::<BTreeSet<_>>();
    let none = BTreeSet::new();

    // Only ignored paths: nothing to report, and the folders are remembered.
    let ignored = paths(&["node_modules/a/b/index.js", "target/debug/app.o", "src/debug.log", "node_modules"]);
    assert!(!has_visible_change(&tc, &mut intake, &ignored, &none).await);
    assert!(intake.ignored_dirs.contains(b"node_modules".as_slice()) && intake.ignored_dirs.contains(b"target".as_slice()));
    assert_eq!(intake.ignored_dirs.len(), 2, "{:?}", intake.ignored_dirs);
    // Afterwards, paths below them are dropped right on arrival.
    assert!(!intake.absorb_path(&repo.path().join("node_modules").join("c").join("d.js"), true));
    assert!(!intake.absorb_path(&repo.path().join("target"), true));
    assert!(intake.pending.is_empty());

    // Something visible among them: report. Also a path that no longer exists (deleted).
    assert!(has_visible_change(&tc, &mut intake, &paths(&["src/debug.log", "src/main.rs"]), &none).await);
    assert!(has_visible_change(&tc, &mut intake, &paths(&["gelöscht/gibt es nicht.txt"]), &none).await);
    // A leading `:` is not pathspec magic.
    assert!(!has_visible_change(&tc, &mut intake, &paths(&[":seltsam.log", "src/debug.log"]), &none).await);

    // Ignored folder with a tracked file: the tracked file stays visible, the folder is not remembered.
    assert!(!has_visible_change(&tc, &mut intake, &paths(&["vendor/lib/untracked.c"]), &none).await);
    assert!(has_visible_change(&tc, &mut intake, &paths(&["vendor/lib/tracked.c"]), &none).await);
    assert_eq!(intake.ignored_dirs.len(), 2, "{:?}", intake.ignored_dirs);

    // New folders only count with visible content: empty or only ignored content is invisible to Git.
    assert!(!has_visible_change(&tc, &mut intake, &none, &paths(&["leer", "neu", "neu/nur ignoriert"])).await);
    assert!(has_visible_change(&tc, &mut intake, &none, &paths(&["leer", "frisch"])).await);
    assert!(has_visible_change(&tc, &mut intake, &none, &paths(&["vendor/lib"])).await);
    intake.forget_ignore_cache();
    assert!(!has_visible_change(&tc, &mut intake, &none, &paths(&["node_modules"])).await);
    assert!(intake.ignored_dirs.contains(b"node_modules".as_slice()));

    // A folder in which something merely changed doesn't count itself; a newly appeared one is checked.
    assert!(!intake.absorb_path(&repo.path().join("src"), false));
    assert!(intake.pending.is_empty());
    assert!(intake.absorb_path(&repo.path().join("frisch"), true));
    assert_eq!(intake.pending.new_dirs, paths(&["frisch"]));
    assert!(intake.absorb_path(&repo.path().join("src").join("main.rs"), false));
    assert_eq!(intake.pending.paths, paths(&["src/main.rs"]));
    // Reading logs nothing.
    assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
}

// --- With a real watcher ---------------------------------------------------------

#[tokio::test]
async fn off_by_default_in_tests_and_idempotent_when_on() {
    let repo = TestRepo::with_commit();
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    assert!(!is_watching(&tc, &id));
    assert!(!wait_until_watching(&tc, &id, Duration::from_millis(10)).await);
    stop_watching(&tc, &id).unwrap();
    stop_watching(&tc, "unbekannt").unwrap();

    set_enabled(&tc, true);
    assert_eq!(start_watching(&tc, "unbekannt").unwrap_err().code, crate::error::ErrorCode::NotFound);
    start_watching(&tc, &id).unwrap();
    start_watching(&tc, &id).unwrap();
    assert!(wait_until_watching(&tc, &id, PATIENCE).await);
    assert_eq!(tc.state::<Watchers>().running.lock().len(), 1);
    tc.events.clear();

    // Started twice doesn't mean reported twice.
    repo.write_file("neu.txt", "x");
    wait_for(&tc, &id, &["worktree"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["worktree"]));

    shutdown(&tc, &id).await;
    assert!(!is_watching(&tc, &id));
    repo.write_file("nach dem Stopp.txt", "x");
    tokio::time::sleep(QUIET).await;
    assert_eq!(event_count(&tc), 0);

    // Restarting after the stop works.
    start_watching(&tc, &id).unwrap();
    assert!(wait_until_watching(&tc, &id, PATIENCE).await);
    repo.write_file("wieder da.txt", "x");
    wait_for(&tc, &id, &["worktree"]).await;
    shutdown(&tc, &id).await;
}

#[tokio::test]
async fn worktree_bursts_become_one_event() {
    let repo = TestRepo::with_commit();
    let (tc, id) = watched(&repo).await;

    for i in 0..200 {
        repo.write_file(&format!("Ordner mit Leerzeichen/Größe {i}.txt"), "inhalt\n");
    }
    repo.write_file("README.md", "geändert\n");
    wait_for(&tc, &id, &["worktree"]).await;
    let count_before_settle = event_count(&tc);
    assert_eq!(settle(&tc, &id).await, set(&["worktree"]));
    // 201 files, but no event storm: one event, a few at most.
    assert!(count_before_settle <= 3, "{count_before_settle} events for one burst");

    repo.remove_file("README.md");
    wait_for(&tc, &id, &["worktree"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["worktree"]));
    shutdown(&tc, &id).await;
}

#[tokio::test]
async fn ignored_paths_stay_silent_even_in_a_storm() {
    let repo = TestRepo::new();
    repo.commit_file(".gitignore", "node_modules/\ntarget/\n*.log\n", "Ignorieren");
    let (tc, id) = watched(&repo).await;

    for i in 0..800 {
        repo.write_file(&format!("node_modules/paket-{}/lib/datei-{i}.js", i % 40), "x");
    }
    for i in 0..300 {
        repo.write_file(&format!("target/debug/deps/objekt-{i}.o"), "x");
    }
    repo.write_file("ausgabe.log", "x");
    repo.write_file("tief/im/baum/noch.log", "x");
    tokio::time::sleep(QUIET * 2).await;
    assert_eq!(event_count(&tc), 0, "{:?}", tc.events.named(names::REPO_CHANGED));

    // A visible file in the middle of the storm is still reported – and only as worktree.
    for i in 0..300 {
        repo.write_file(&format!("node_modules/spät/datei-{i}.js"), "x");
    }
    repo.write_file("src/sichtbar.rs", "x");
    wait_for(&tc, &id, &["worktree"]).await;
    let count = event_count(&tc);
    assert_eq!(settle(&tc, &id).await, set(&["worktree"]));
    assert!(count <= 3, "{count} events");

    // A foreign lock file in the Git directory is not an event.
    std::fs::write(repo.path().join(".git").join("index.lock"), "").unwrap();
    tokio::time::sleep(QUIET).await;
    assert_eq!(event_count(&tc), 0);
    std::fs::remove_file(repo.path().join(".git").join("index.lock")).unwrap();

    // If the rule is removed, the folder counts again (the memory is cleared).
    repo.write_file(".gitignore", "*.log\n");
    wait_for(&tc, &id, &["worktree"]).await;
    settle(&tc, &id).await;
    repo.write_file("target/debug/deps/jetzt sichtbar.o", "x");
    wait_for(&tc, &id, &["worktree"]).await;
    shutdown(&tc, &id).await;
}

#[tokio::test]
async fn git_directory_changes_are_reported_by_kind() {
    let repo = TestRepo::with_commit();
    repo.write_file("a.txt", "eins\n");
    let (tc, id) = watched(&repo).await;

    // Staging only touches the index.
    repo.git(&["add", "a.txt"]);
    wait_for(&tc, &id, &["index"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["index"]));

    // Commit: the branch moves.
    repo.git(&["commit", "-q", "-m", "a"]);
    let seen = wait_for(&tc, &id, &["refs"]).await;
    assert!(!seen.contains("worktree"), "{seen:?}");
    settle(&tc, &id).await;

    // Only writing objects: nothing.
    repo.write_file("objekt.bin", "nur ein Objekt");
    wait_for(&tc, &id, &["worktree"]).await;
    settle(&tc, &id).await;
    repo.git(&["hash-object", "-w", "objekt.bin"]);
    tokio::time::sleep(QUIET).await;
    assert_eq!(event_count(&tc), 0, "{:?}", tc.events.named(names::REPO_CHANGED));

    // New branch with switch: HEAD and refs.
    repo.git(&["checkout", "-q", "-b", "feature"]);
    wait_for(&tc, &id, &["head", "refs"]).await;
    settle(&tc, &id).await;

    repo.git(&["tag", "v1"]);
    wait_for(&tc, &id, &["refs"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["refs"]));
    repo.git(&["pack-refs", "--all"]);
    wait_for(&tc, &id, &["refs"]).await;
    settle(&tc, &id).await;

    repo.git(&["config", "abschnitt.wert", "1"]);
    wait_for(&tc, &id, &["config"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["config"]));

    // Stash: stash list, index and working directory.
    repo.write_file("a.txt", "eins\nzwei\n");
    wait_for(&tc, &id, &["worktree"]).await;
    settle(&tc, &id).await;
    repo.git(&["stash"]);
    wait_for(&tc, &id, &["stash", "worktree"]).await;
    let seen = settle(&tc, &id).await;
    assert!(!seen.contains("refs") && !seen.contains("head"), "{seen:?}");

    // Merge with conflict: operation in progress; aborting reports it again.
    repo.commit_file("a.txt", "feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("a.txt", "main\n", "Main");
    settle(&tc, &id).await;
    assert!(!repo.merge("feature"));
    wait_for(&tc, &id, &["operation", "index", "worktree"]).await;
    settle(&tc, &id).await;
    repo.git(&["merge", "--abort"]);
    wait_for(&tc, &id, &["operation"]).await;
    settle(&tc, &id).await;

    // Rebase with conflict: rebase-merge/ is created.
    assert!(!repo.git_output(&["rebase", "feature"]).status.success());
    wait_for(&tc, &id, &["operation", "head"]).await;
    settle(&tc, &id).await;
    repo.git(&["rebase", "--abort"]);
    wait_for(&tc, &id, &["operation", "head"]).await;
    shutdown(&tc, &id).await;
}

#[tokio::test]
async fn empty_repository_and_detached_head() {
    let repo = TestRepo::new();
    let (tc, id) = watched(&repo).await;
    repo.write_file("erste.txt", "x\n");
    wait_for(&tc, &id, &["worktree"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["worktree"]));
    // The first commit creates the branch.
    let first = repo.commit("Erster");
    wait_for(&tc, &id, &["refs", "index"]).await;
    settle(&tc, &id).await;
    repo.commit_file("erste.txt", "y\n", "Zweiter");
    // Only once this commit has been reported does what the checkout triggers afterwards count
    // (under load the report arrives later than the quiet period of `settle`).
    wait_for(&tc, &id, &["refs"]).await;
    settle(&tc, &id).await;

    repo.git(&["checkout", "-q", "--detach", &first]);
    let seen = wait_for(&tc, &id, &["head"]).await;
    assert!(!seen.contains("refs"), "{seen:?}");
    settle(&tc, &id).await;
    // Commit without a branch: only HEAD moves.
    repo.empty_commit("Ohne Branch");
    wait_for(&tc, &id, &["head"]).await;
    shutdown(&tc, &id).await;
}

#[tokio::test]
async fn linked_worktree_watches_its_own_and_the_shared_git_directory() {
    let repo = TestRepo::with_commit();
    let config = repo.temp_dir().join("gitconfig");
    let wt = repo.temp_dir().join("Zweites Arbeitsverzeichnis");
    repo.git(&["worktree", "add", "-q", "-b", "nebenbei", &wt.to_string_lossy()]);
    assert!(wt.join(".git").is_file());

    let tc = TestCore::new().await;
    set_enabled(&tc, true);
    let id = crate::commands::repos::repo_open(&tc, wt.to_string_lossy().into_owned()).await.unwrap().repo.id;
    assert!(wait_until_watching(&tc, &id, PATIENCE).await);
    tc.events.clear();

    std::fs::write(wt.join("im worktree.txt"), "x\n").unwrap();
    wait_for(&tc, &id, &["worktree"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["worktree"]));

    // The worktree's index and HEAD live under <main>/.git/worktrees/<name>.
    git_in(&wt, &config, &["add", "-A"]);
    wait_for(&tc, &id, &["index"]).await;
    assert_eq!(settle(&tc, &id).await, set(&["index"]));
    git_in(&wt, &config, &["commit", "-q", "-m", "Im Worktree"]);
    wait_for(&tc, &id, &["refs"]).await;
    settle(&tc, &id).await;
    git_in(&wt, &config, &["checkout", "-q", "--detach"]);
    wait_for(&tc, &id, &["head"]).await;
    settle(&tc, &id).await;

    // In the main working directory: its index and HEAD are no concern of the worktree, shared refs are.
    repo.write_file("im haupt.txt", "x\n");
    repo.git(&["add", "-A"]);
    tokio::time::sleep(QUIET).await;
    assert_eq!(event_count(&tc), 0, "{:?}", tc.events.named(names::REPO_CHANGED));
    repo.git(&["checkout", "-q", "-b", "anderer"]);
    repo.git(&["commit", "-q", "-m", "Im Haupt"]);
    let seen = wait_for(&tc, &id, &["refs"]).await;
    let seen: BTreeSet<String> = seen.union(&settle(&tc, &id).await).cloned().collect();
    assert_eq!(seen, set(&["refs"]));
    repo.git(&["config", "abschnitt.wert", "1"]);
    wait_for(&tc, &id, &["config"]).await;
    shutdown(&tc, &id).await;
}

#[tokio::test]
async fn stops_when_the_folder_disappears_or_the_repository_is_forgotten() {
    let repo = TestRepo::with_commit();
    let tc = TestCore::new().await;
    set_enabled(&tc, true);
    set_timing(&tc, WatchTiming { liveness: Duration::from_millis(200), ..WatchTiming::default() });
    let id = tc.open(&repo).await.repo.id;
    assert!(wait_until_watching(&tc, &id, PATIENCE).await);
    tc.events.clear();

    // The folder is renamed (like “moved” or “deleted”): watching ends on its own.
    let moved = repo.temp_dir().join("verschoben");
    std::fs::rename(repo.path(), &moved).unwrap();
    let deadline = Instant::now() + PATIENCE;
    while is_watching(&tc, &id) {
        assert!(Instant::now() < deadline, "watching keeps running although the folder is gone");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The UI learns about it through one last event.
    assert!(kinds(&tc, &id).contains("worktree"));
    assert_eq!(start_watching(&tc, &id).unwrap_err().code, crate::error::ErrorCode::PathNotFound);
    assert!(!is_watching(&tc, &id));

    // Folder is back: restarting works; “forget” stops watching.
    std::fs::rename(&moved, repo.path()).unwrap();
    start_watching(&tc, &id).unwrap();
    assert!(wait_until_watching(&tc, &id, PATIENCE).await);
    let phase = tc.state::<Watchers>().running.lock().get(&id).map(|r| r.phase.clone()).unwrap();
    crate::commands::repos::repo_forget(&tc, id.clone()).await.unwrap();
    assert!(!is_watching(&tc, &id));
    let mut phase = phase;
    tokio::time::timeout(PATIENCE, async {
        while *phase.borrow_and_update() != Phase::Stopped {
            phase.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn closing_the_last_tab_stops_watching() {
    let repo = TestRepo::with_commit();
    let (tc, id) = watched(&repo).await;
    let tabs = crate::commands::repos::tabs_list(&tc).await.unwrap();
    let tab = tabs.iter().find(|t| t.repo_id.as_deref() == Some(id.as_str())).unwrap();
    crate::commands::repos::tab_close(&tc, tab.id.clone()).await.unwrap();
    assert!(!is_watching(&tc, &id));
}

#[tokio::test]
async fn a_bisect_started_outside_is_reported() {
    let repo = TestRepo::with_commit();
    repo.commit_file("b.txt", "b\n", "B");
    let (tc, id) = watched(&repo).await;

    // `bisect start` only writes BISECT_* files: an operation begins.
    repo.git(&["bisect", "start"]);
    wait_for(&tc, &id, &["operation"]).await;
    settle(&tc, &id).await;

    // The first `bisect bad` creates the folder refs/bisect together with its first ref.
    repo.git(&["bisect", "bad", "HEAD"]);
    wait_for(&tc, &id, &["refs"]).await;
    settle(&tc, &id).await;

    // A ref rewritten inside the new folder is seen too.
    repo.git(&["bisect", "bad", "HEAD~1"]);
    wait_for(&tc, &id, &["refs"]).await;
    settle(&tc, &id).await;
    repo.git(&["bisect", "reset"]);
    wait_for(&tc, &id, &["operation"]).await;
    shutdown(&tc, &id).await;
}

#[test]
fn new_folders_in_the_git_directory_count_by_their_path() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::fs::create_dir_all(root.join(".git/refs/bisect")).unwrap();
    std::fs::create_dir_all(root.join(".git/objects/ab")).unwrap();
    let mut intake = Intake::new(root.clone(), true, Vec::new());
    // A changed folder says nothing; a folder that appears may hold refs whose own events were lost.
    assert!(!intake.absorb_path(&root.join(".git/refs/bisect"), false));
    assert!(!intake.absorb_path(&root.join(".git/objects/ab"), true));
    assert!(intake.pending.kinds.is_empty());
    assert!(intake.absorb_path(&root.join(".git/refs/bisect"), true));
    assert_eq!(intake.pending.kinds, [RepoChange::Refs].into_iter().collect());
}

/// The recursive watch walks the whole working directory (node_modules and other ignored
/// folders included) – seconds for a large tree. That walk must not run on a thread of the async
/// runtime: at startup every open tab starts watching, and a blocked worker holds up the UI's
/// calls. On a single-threaded runtime: once the watcher's task has had its turn, the test task
/// runs again while the watch is still being set up (before: the walk ran right inside the task,
/// so the test only got its turn back once watching already ran).
#[tokio::test(flavor = "current_thread")]
async fn setting_up_the_watch_does_not_hold_up_the_runtime() {
    let repo = TestRepo::with_commit();
    for index in 0..200 {
        repo.subdir(&format!("node_modules/paket-{index}/lib"));
    }
    let tc = TestCore::new().await;
    // Opened while watching is still off, so that nothing else is awaited from here on.
    let id = tc.open(&repo).await.repo.id;
    set_enabled(&tc, true);
    start_watching(&tc, &id).unwrap();
    tokio::task::yield_now().await;
    let phase = *tc.state::<Watchers>().running.lock().get(&id).expect("watcher registered").phase.borrow();
    assert_eq!(phase, Phase::Starting, "the walk must not have run on the runtime's thread");
    assert!(wait_until_watching(&tc, &id, PATIENCE).await, "watching still starts");
    repo.write_file("neu.txt", "x");
    wait_for(&tc, &id, &["worktree"]).await;
}
