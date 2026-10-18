//! The bisect autopilot with fixed scripts in real temporary repositories. The first bad commit is
//! known from the fixture (the commit that swaps the factors), never computed the autopilot's way.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::*;
use crate::commands::bisect::{bisect_autopilot_close, bisect_autopilot_run, bisect_autopilot_status, bisect_start, bisect_status};
use crate::model::{BisectAutopilotPhase, BisectStatus, BisectVerdict};
use crate::testkit::{temp_folder, TestCore, TestRepo};

const GOOD: &str = "def fahrenheit(c):\n    return c * 9 / 5 + 32\n";
const BAD: &str = "def fahrenheit(c):\n    return c * 5 / 9 + 32\n";

struct Fixture {
    repo: TestRepo,
    good: String,
    culprit: String,
    bad: String,
}

/// main: the formula (2009, +09:30) → README → the bug (written 2011 at -07:00, rebased 2023) → a
/// file with a leading dash → merge of a side branch with umlaut and space paths → README. The side
/// branch never had the bug.
fn fixture() -> Fixture {
    let repo = TestRepo::new();
    repo.write_file("umrechnung.py", GOOD);
    repo.write_file("README.md", "# Messnetz\n");
    let good = repo.commit_as_dates("Umrechnung in Fahrenheit", "Jörg Ähnlich", "joerg@example.com", "@1234567890 +0930", "@1234567890 +0930");
    repo.checkout_new("messung");
    repo.commit_file("Mess daten/köln süd.csv", "datum;celsius\n2026-04-01;10.5\n", "Messwert für Köln-Süd");
    repo.commit_file("Mess daten/köln süd.csv", "datum;celsius\n2026-04-01;10.5\n2026-04-02;11.0\n", "Zweiter Messwert");
    repo.checkout("main");
    repo.commit_file("README.md", "# Messnetz\n\nUmrechnung von Celsius.\n", "README ergänzt");
    repo.write_file("umrechnung.py", BAD);
    let culprit = repo.commit_as_dates("Umrechnung vereinfacht", "Ana Núñez", "ana@example.com", "@1300000000 -0700", "@1700000000 +0100");
    repo.commit_file("-führend.txt", "Dateiname mit Strich\n", "Datei mit führendem Strich");
    assert!(repo.merge("messung"), "the side branch merges cleanly");
    let bad = repo.commit_file("README.md", "# Messnetz\n\nUmrechnung von Celsius in Fahrenheit.\n", "README überarbeitet");
    Fixture { repo, good, culprit, bad }
}

/// Bad when `umrechnung.py` has the swapped factors.
fn formula_script() -> String {
    if cfg!(windows) {
        "if (Select-String -LiteralPath 'umrechnung.py' -SimpleMatch -Quiet -Pattern '5 / 9') { exit 1 }\r\nexit 0\r\n".to_string()
    } else {
        "if grep -q '5 / 9' umrechnung.py; then exit 1; fi\nexit 0\n".to_string()
    }
}

async fn run(tc: &TestCore, id: &str, f: &Fixture, script: &str) -> CoreResult<BisectAutopilot> {
    bisect_autopilot_run(tc, id.to_string(), "auto".into(), f.bad.clone(), vec![f.good.clone()], script.to_string(), 60).await
}

fn worktrees(repo: &TestRepo) -> String {
    repo.git(&["worktree", "list", "--porcelain"])
}

/// Entscheidung 2 written out: `<parent>/<repo>.agents/bisect-<n>` – not from `names::agents_dir`.
fn expected_worktree(repo: &TestRepo, n: u32) -> PathBuf {
    std::fs::canonicalize(repo.temp_dir()).unwrap().join("repo.agents").join(format!("bisect-{n}"))
}

fn same(a: &Path, b: &Path) -> bool {
    util::path_key(a) == util::path_key(b)
}

fn bisect_files(repo: &TestRepo) -> (String, String, String) {
    let log = std::fs::read_to_string(repo.path().join(".git").join("BISECT_LOG")).unwrap_or_default();
    (repo.git(&["for-each-ref", "--format=%(refname) %(objectname)", "refs/bisect"]), log, repo.head())
}

#[test]
fn exit_codes_mean_what_git_bisect_run_says() {
    let table = [(Some(0), Some(BisectVerdict::Good)), (Some(1), Some(BisectVerdict::Bad)), (Some(124), Some(BisectVerdict::Bad)), (Some(125), Some(BisectVerdict::Skip)), (Some(126), Some(BisectVerdict::Bad)), (Some(127), Some(BisectVerdict::Bad)), (Some(128), None), (Some(255), None), (Some(-1), None), (None, None)];
    for (code, verdict) in table {
        assert_eq!(verdict_for(code), verdict, "{code:?}");
    }
}

#[tokio::test]
async fn the_autopilot_finds_the_first_bad_commit_and_leaves_the_own_working_directory_alone() {
    let tc = TestCore::new().await;
    let f = fixture();
    let id = tc.open(&f.repo).await.repo.id;
    // The own working directory is not clean: a changed, a staged and an untracked file.
    f.repo.write_file("umrechnung.py", "# lokal in Arbeit\n");
    f.repo.write_file("README.md", "# Entwurf\r\n");
    f.repo.git(&["add", "README.md"]);
    f.repo.write_file("notizen ä.txt", "nicht committen\n");
    let status_before = f.repo.git(&["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    let head_before = f.repo.head();

    let done = run(&tc, &id, &f, &formula_script()).await.unwrap();

    assert_eq!(done.phase, BisectAutopilotPhase::Found, "{done:?}");
    assert_eq!(done.result.as_deref(), Some(f.culprit.as_str()));
    assert!(same(Path::new(&done.worktree_path), &expected_worktree(&f.repo, 1)), "{}", done.worktree_path);
    assert!(!done.steps.is_empty());
    // Every verdict agrees with the file Git has at that commit.
    for step in &done.steps {
        let has_bug = f.repo.git(&["show", &format!("{}:umrechnung.py", step.sha)]).contains("5 / 9");
        assert_eq!((step.verdict, step.exit_code, step.timed_out), (if has_bug { BisectVerdict::Bad } else { BisectVerdict::Good }, Some(i32::from(has_bug)), false), "{step:?}");
    }
    // The own working directory, index and HEAD are as before, and it has no bisect.
    assert_eq!(f.repo.git(&["status", "--porcelain=v2", "-z", "--untracked-files=all"]), status_before);
    assert_eq!(f.repo.read_file("umrechnung.py"), b"# lokal in Arbeit\n");
    assert_eq!(f.repo.read_file("README.md"), b"# Entwurf\r\n");
    assert_eq!((f.repo.head(), f.repo.current_branch()), (head_before, "main".to_string()));
    assert!(!f.repo.path().join(".git").join("BISECT_START").exists());
    assert_eq!(bisect_status(&tc, id.clone()).await.unwrap(), BisectStatus::default());
    assert_eq!(f.repo.git(&["for-each-ref", "refs/bisect"]), "");
    // The temporary worktree stays for the result: on the first bad commit, no bisect, locked.
    assert_eq!(f.repo.git(&["-C", &done.worktree_path, "rev-parse", "HEAD"]), f.culprit);
    assert!(!f.repo.path().join(".git").join("worktrees").join("bisect-1").join("BISECT_START").exists());
    let listed = worktrees(&f.repo);
    assert!(listed.contains("bisect-1") && listed.contains(&format!("locked {LOCK_REASON}")), "{listed}");
    assert_eq!(bisect_autopilot_status(&tc, id.clone()).await.unwrap(), Some(done.clone()));
    // Removing ends it all: worktree, the empty .agents folder, the script in the data folder.
    assert_eq!(bisect_autopilot_close(&tc, id.clone(), false).await.unwrap(), None);
    assert!(!Path::new(&done.worktree_path).exists());
    assert!(!worktrees(&f.repo).contains("bisect-1"));
    assert!(!f.repo.temp_dir().join("repo.agents").exists());
    assert_eq!(std::fs::read_dir(tc.data_dir().join("bisect")).map(|dir| dir.count()).unwrap_or(0), 0);
    assert_eq!(bisect_autopilot_status(&tc, id).await.unwrap(), None);
}

/// The bar reloads the run on every `job:progress` of the autopilot: the first step must not be
/// swallowed by the progress throttle right after "Preparing" (same phase, both at 0 %).
#[tokio::test]
async fn every_tested_step_is_reported_as_progress() {
    let tc = TestCore::new().await;
    let f = fixture();
    let id = tc.open(&f.repo).await.repo.id;
    tc.events.clear();

    let done = run(&tc, &id, &f, &formula_script()).await.unwrap();

    let lines: Vec<String> = tc
        .events
        .named(crate::events::names::JOB_PROGRESS)
        .iter()
        .filter(|p| p["jobId"] == "auto" && p["phase"] == PROGRESS_PHASE)
        .map(|p| p["line"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(lines.first().map(String::as_str), Some("Preparing the bisect worktree"), "{lines:?}");
    let steps: Vec<&String> = lines.iter().filter(|line| line.starts_with("Step ")).collect();
    assert_eq!(steps.len(), done.steps.len(), "{lines:?}");
    for (index, line) in steps.iter().enumerate() {
        assert!(line.starts_with(&format!("Step {} of ~", index + 1)), "{lines:?}");
    }
    bisect_autopilot_close(&tc, id, false).await.unwrap();
}

#[tokio::test]
async fn a_bisect_running_in_the_own_working_directory_is_not_touched() {
    let tc = TestCore::new().await;
    let f = fixture();
    let id = tc.open(&f.repo).await.repo.id;
    let manual = bisect_start(&tc, id.clone(), f.bad.clone(), vec![f.good.clone()]).await.unwrap();
    f.repo.git(&["bisect", "skip"]);
    let files_before = bisect_files(&f.repo);
    let status_before = bisect_status(&tc, id.clone()).await.unwrap();
    assert!(manual.active && status_before.skipped.len() == 1);

    let done = run(&tc, &id, &f, &formula_script()).await.unwrap();
    assert_eq!(done.result.as_deref(), Some(f.culprit.as_str()));
    assert_eq!(bisect_files(&f.repo), files_before, "refs/bisect, BISECT_LOG and HEAD of the own worktree");
    assert_eq!(bisect_status(&tc, id.clone()).await.unwrap(), status_before);
    bisect_autopilot_close(&tc, id, false).await.unwrap();
}

#[tokio::test]
async fn the_temporary_worktree_lies_next_to_a_repository_with_spaces_and_umlauts() {
    let tc = TestCore::new().await;
    let f = fixture();
    let parent = std::fs::canonicalize(f.repo.temp_dir()).unwrap().join("Mein Projekt Ä");
    std::fs::create_dir_all(&parent).unwrap();
    let main = parent.join("web app");
    f.repo.git(&["clone", "-q", f.repo.path().to_str().unwrap(), main.to_str().unwrap()]);
    let opened = crate::commands::repos::repo_open(&tc, main.to_string_lossy().into_owned()).await.unwrap();
    if !opened.repo.trusted {
        crate::commands::trust::repo_trust_set(&tc, opened.repo.id.clone(), true).await.unwrap();
    }
    let id = opened.repo.id;
    let markers = temp_folder();
    let marker = markers.path().join("pwd.txt");
    let script = if cfg!(windows) {
        format!("(Get-Location).Path | Set-Content -Encoding UTF8 -LiteralPath '{}'\r\n{}", marker.display(), formula_script())
    } else {
        format!("pwd > '{}'\n{}", marker.display(), formula_script())
    };
    let done = bisect_autopilot_run(&tc, id.clone(), "umlaut".into(), f.bad.clone(), vec![f.good.clone()], script, 60).await.unwrap();
    assert_eq!(done.result.as_deref(), Some(f.culprit.as_str()));
    let expected = parent.join("web app.agents").join("bisect-1");
    assert!(same(Path::new(&done.worktree_path), &expected), "{}", done.worktree_path);
    let recorded = std::fs::read_to_string(&marker).unwrap();
    let recorded = recorded.trim_start_matches('\u{feff}').trim();
    assert!(Path::new(recorded).ends_with(Path::new("web app.agents").join("bisect-1")), "the script ran in the temporary worktree: {recorded}");
    bisect_autopilot_close(&tc, id, false).await.unwrap();
    assert!(!expected.exists());
}

#[tokio::test]
async fn keeping_the_worktree_leaves_it_on_the_first_bad_commit_for_the_user() {
    let tc = TestCore::new().await;
    let f = fixture();
    let id = tc.open(&f.repo).await.repo.id;
    let done = run(&tc, &id, &f, &formula_script()).await.unwrap();
    assert_eq!(run(&tc, &id, &f, &formula_script()).await.unwrap_err().code, ErrorCode::NotAllowed, "the open result must be closed first");

    let kept = bisect_autopilot_close(&tc, id.clone(), true).await.unwrap();
    assert_eq!(kept.as_deref(), Some(done.worktree_path.as_str()));
    let listed = worktrees(&f.repo);
    assert!(listed.contains("bisect-1") && !listed.contains("locked"), "a kept worktree is the user's: unlocked\n{listed}");
    assert_eq!(f.repo.git(&["-C", &done.worktree_path, "rev-parse", "HEAD"]), f.culprit);
    assert_eq!(bisect_autopilot_status(&tc, id.clone()).await.unwrap(), None);

    let second = run(&tc, &id, &f, &formula_script()).await.unwrap();
    assert!(same(Path::new(&second.worktree_path), &expected_worktree(&f.repo, 2)), "{}", second.worktree_path);
    bisect_autopilot_close(&tc, id, false).await.unwrap();
    assert!(Path::new(&done.worktree_path).exists(), "removing the second leaves the kept one");
}

#[tokio::test]
async fn stopping_ends_the_script_and_removes_the_worktree() {
    let tc = TestCore::new().await;
    let f = fixture();
    let id = tc.open(&f.repo).await.repo.id;
    let markers = temp_folder();
    let started = markers.path().join("gestartet");
    // A grandchild keeps the output pipe open: only ending the whole process tree lets the run end.
    let script = if cfg!(windows) {
        format!("New-Item -ItemType File -Path '{}' | Out-Null\r\nStart-Process -NoNewWindow -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120'\r\nStart-Sleep -Seconds 120\r\nexit 0\r\n", started.display())
    } else {
        format!("touch '{}'\nsleep 120 &\nwait\nexit 0\n", started.display())
    };
    let stop = async {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !started.exists() {
            assert!(Instant::now() < deadline, "the script did not start");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let running = bisect_autopilot_status(&tc, id.clone()).await.unwrap().unwrap();
        assert_eq!(running.phase, BisectAutopilotPhase::Testing);
        assert!(worktrees(&f.repo).contains("bisect-1"));
        let again = bisect_autopilot_run(&tc, id.clone(), "zweiter".into(), f.bad.clone(), vec![f.good.clone()], formula_script(), 60).await;
        assert_eq!(again.unwrap_err().code, ErrorCode::BisectActive);
        assert_eq!(bisect_autopilot_close(&tc, id.clone(), false).await.unwrap_err().code, ErrorCode::NotAllowed);
        assert!(tc.jobs.cancel("stop"));
        Instant::now()
    };
    let (result, stopped_at) = tokio::join!(bisect_autopilot_run(&tc, id.clone(), "stop".into(), f.bad.clone(), vec![f.good.clone()], script, 600), stop);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert!(stopped_at.elapsed() < Duration::from_secs(20), "the sleeping grandchild ended with the script");
    assert!(!expected_worktree(&f.repo, 1).exists());
    assert!(!worktrees(&f.repo).contains("bisect-1"));
    assert_eq!(bisect_autopilot_status(&tc, id.clone()).await.unwrap(), None);
    assert!(!f.repo.path().join(".git").join("BISECT_START").exists());
    assert_eq!(f.repo.current_branch(), "main");
}

#[tokio::test]
async fn the_run_checks_trust_script_time_limit_and_range_first() {
    let tc = TestCore::new().await;
    let f = fixture();
    let id = tc.open(&f.repo).await.repo.id;
    let attempt = |bad: &str, good: Vec<String>, script: &str, secs: u64| bisect_autopilot_run(&tc, id.clone(), "v".into(), bad.to_string(), good, script.to_string(), secs);
    let goods = vec![f.good.clone()];
    assert_eq!(attempt(&f.bad, goods.clone(), "  \n", 60).await.unwrap_err().code, ErrorCode::NotAllowed, "empty script");
    assert_eq!(attempt(&f.bad, goods.clone(), &"#".repeat(64 * 1024 + 1), 60).await.unwrap_err().code, ErrorCode::NotAllowed, "script too long");
    assert_eq!(attempt(&f.bad, goods.clone(), "exit 0", 0).await.unwrap_err().code, ErrorCode::NotAllowed, "no time limit");
    assert_eq!(attempt(&f.bad, goods.clone(), "exit 0", MAX_STEP_TIMEOUT_SECS + 1).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(attempt(&f.bad, Vec::new(), "exit 0", 60).await.unwrap_err().code, ErrorCode::NotAllowed, "no good commit");
    assert_eq!(attempt(&f.good, vec![f.bad.clone()], "exit 0", 60).await.unwrap_err().code, ErrorCode::NotAllowed, "good after bad");
    assert_eq!(attempt("-x", goods.clone(), "exit 0", 60).await.unwrap_err().code, ErrorCode::NotFound);
    assert!(!f.repo.temp_dir().join("repo.agents").exists(), "nothing was created");
    crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
    assert_eq!(attempt(&f.bad, goods, "exit 0", 60).await.unwrap_err().code, ErrorCode::RepoUntrusted);
}

/// A linear history: `shas[0]` good, the commit at `bug_at` swaps the factors, the last one is HEAD.
fn linear(total: usize, bug_at: usize) -> (TestRepo, Vec<String>) {
    let repo = TestRepo::new();
    let mut shas = vec![repo.commit_file("umrechnung.py", GOOD, "Umrechnung in Fahrenheit")];
    for index in 1..total {
        if index == bug_at {
            shas.push(repo.commit_file("umrechnung.py", BAD, "Umrechnung vereinfacht"));
        } else {
            shas.push(repo.commit_file("messwerte.csv", format!("2026-04-{index:02};{}\n", 10 + index), &format!("Messwert {index}")));
        }
    }
    (repo, shas)
}

#[tokio::test]
async fn a_step_over_its_time_limit_counts_as_skipped() {
    let tc = TestCore::new().await;
    let (repo, shas) = linear(16, 12);
    let (good, culprit, bad) = (shas[0].clone(), shas[12].clone(), shas[15].clone());
    let id = tc.open(&repo).await.repo.id;
    // Git's own first pick: the commit `git bisect start` checks out.
    let first = repo.git(&["rev-list", "--bisect", &bad, &format!("^{good}")]);
    assert!(first != culprit && first != shas[11], "fixture: the slow commit is not next to the bug");
    let script = if cfg!(windows) {
        format!("if ($env:FORKYARD_BISECT_COMMIT -eq '{first}') {{ Start-Sleep -Seconds 120 }}\r\n{}", formula_script())
    } else {
        format!("if [ \"$FORKYARD_BISECT_COMMIT\" = '{first}' ]; then sleep 120; fi\n{}", formula_script())
    };
    let done = bisect_autopilot_run(&tc, id.clone(), "langsam".into(), bad, vec![good], script, 3).await.unwrap();
    let step = &done.steps[0];
    assert_eq!((step.sha.as_str(), step.verdict, step.timed_out, step.exit_code), (first.as_str(), BisectVerdict::Skip, true, None));
    assert_eq!(done.steps.iter().filter(|step| step.timed_out).count(), 1);
    assert_eq!((done.phase, done.result.as_deref()), (BisectAutopilotPhase::Found, Some(culprit.as_str())));
    bisect_autopilot_close(&tc, id, false).await.unwrap();
}

#[tokio::test]
async fn an_exit_code_above_127_stops_the_run_and_keeps_the_worktree_for_a_look() {
    let tc = TestCore::new().await;
    let (repo, shas) = linear(6, 3);
    let id = tc.open(&repo).await.repo.id;
    let first = repo.git(&["rev-list", "--bisect", &shas[5], &format!("^{}", shas[0])]);
    let script = if cfg!(windows) { "exit 130\r\n" } else { "exit 130\n" };
    let done = bisect_autopilot_run(&tc, id.clone(), "kaputt".into(), shas[5].clone(), vec![shas[0].clone()], script.into(), 60).await.unwrap();
    assert_eq!(done.phase, BisectAutopilotPhase::Failed, "{done:?}");
    assert!(done.message.as_deref().is_some_and(|message| message.contains("130")), "{:?}", done.message);
    assert!(done.steps.is_empty() && done.result.is_none());
    assert_eq!(repo.git(&["-C", &done.worktree_path, "rev-parse", "HEAD"]), first, "the worktree stays on the commit the script failed on");
    assert!(!repo.git_output(&["-C", &done.worktree_path, "bisect", "log"]).status.success(), "no bisect left in the worktree");
    bisect_autopilot_close(&tc, id, false).await.unwrap();
    assert!(!Path::new(&done.worktree_path).exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_script_ended_by_a_signal_stops_the_run() {
    let tc = TestCore::new().await;
    let (repo, shas) = linear(4, 2);
    let id = tc.open(&repo).await.repo.id;
    let done = bisect_autopilot_run(&tc, id.clone(), "signal".into(), shas[3].clone(), vec![shas[0].clone()], "kill -9 $$\n".into(), 60).await.unwrap();
    assert_eq!(done.phase, BisectAutopilotPhase::Failed);
    assert!(done.message.as_deref().is_some_and(|message| message.contains("signal")), "{:?}", done.message);
    bisect_autopilot_close(&tc, id, false).await.unwrap();
}

#[tokio::test]
async fn only_skipped_commits_left_name_the_candidates() {
    let tc = TestCore::new().await;
    let (repo, shas) = linear(4, 2);
    let id = tc.open(&repo).await.repo.id;
    let script = if cfg!(windows) { "exit 125\r\n" } else { "exit 125\n" };
    let done = bisect_autopilot_run(&tc, id.clone(), "alle".into(), shas[3].clone(), vec![shas[0].clone()], script.into(), 60).await.unwrap();
    assert_eq!(done.phase, BisectAutopilotPhase::OnlySkipped, "{done:?}");
    let mut candidates = done.candidates.clone();
    candidates.sort();
    let mut expected = vec![shas[1].clone(), shas[2].clone(), shas[3].clone()];
    expected.sort();
    assert_eq!(candidates, expected, "everything after the good commit, the bad one included");
    assert!(done.steps.iter().all(|step| step.verdict == BisectVerdict::Skip && step.exit_code == Some(125)));
    bisect_autopilot_close(&tc, id, false).await.unwrap();
}

#[tokio::test]
async fn leftovers_of_an_ended_app_are_removed_and_the_users_worktrees_stay() {
    let tc = TestCore::new().await;
    let f = fixture();
    let id = tc.open(&f.repo).await.repo.id;
    let dir = f.repo.temp_dir().join("repo.agents");
    std::fs::create_dir_all(&dir).unwrap();
    let leftover = dir.join("bisect-1");
    let users = dir.join("bisect-2");
    f.repo.git(&["worktree", "add", "-q", "--detach", "--lock", "--reason", LOCK_REASON, leftover.to_str().unwrap(), &f.bad]);
    f.repo.git(&["worktree", "add", "-q", "--detach", users.to_str().unwrap(), &f.good]);
    std::fs::write(users.join("meine notiz.txt"), "bleibt\n").unwrap();

    let done = run(&tc, &id, &f, &formula_script()).await.unwrap();
    assert!(same(Path::new(&done.worktree_path), &expected_worktree(&f.repo, 1)), "the leftover's name is free again: {}", done.worktree_path);
    assert!(users.join("meine notiz.txt").exists(), "a worktree without the autopilot's lock is the user's");
    bisect_autopilot_close(&tc, id, false).await.unwrap();
    let listed = worktrees(&f.repo);
    assert!(!listed.contains("bisect-1") && listed.contains("bisect-2"), "{listed}");
    assert!(dir.exists(), "the .agents folder stays while it is not empty");
}
