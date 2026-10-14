use super::*;

use std::path::Path;

fn log_in(home: Option<&Path>) -> CrashLog {
    CrashLog::with_options(home.map(Path::to_path_buf), 1024 * 1024)
}

fn log_text(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(LOG_DIR).join(LOG_FILE)).unwrap_or_default()
}

fn reports(dir: &Path) -> Vec<ReportFile> {
    list_reports(dir)
}

// --- Scrubbing -------------------------------------------------------------------------------

#[test]
fn lines_are_scrubbed_before_they_are_stored() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home").join("anna");
    let log = log_in(Some(&home));
    log.remember_secret("Sup3rGeheim-Proxy");
    log.attach(dir.path(), "1.2.3");
    let secrets = [
        "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        "glpat-xYz12_3-AbCdEfGhIjK",
        "hunter2pass",
        "Sup3rGeheim-Proxy",
    ];
    log.push_line(&format!("push with {} failed", secrets[0]));
    log.push_line(&format!("GitLab rejected {}", secrets[1]));
    log.push_line(&format!("fetch https://anna:{}@git.example.com/r.git", secrets[2]));
    log.push_line(&format!("proxy password {} in use", secrets[3]));
    log.push_line(&format!("opened {}", home.join("projects").join("repo").display()));

    let file = log_text(dir.path());
    let ring = log.recent_lines().join("\n");
    for text in [&file, &ring] {
        for secret in secrets {
            assert!(!text.contains(secret), "{secret} leaked into:\n{text}");
        }
        assert!(!text.contains(&home.display().to_string()), "home not shortened:\n{text}");
        assert!(text.contains(&format!("~{}projects", std::path::MAIN_SEPARATOR)), "{text}");
        assert!(text.contains("git.example.com"), "the rest of the line stays readable:\n{text}");
    }
}

#[test]
fn lines_before_the_data_dir_is_known_are_flushed_on_attach() {
    let dir = tempfile::tempdir().unwrap();
    let log = log_in(None);
    log.push_line("early line one");
    log.push_line("early line two");
    assert!(!dir.path().join(LOG_DIR).exists());
    log.attach(dir.path(), "1.2.3");
    log.push_line("late line");
    let text = log_text(dir.path());
    let (one, two, late) = (text.find("early line one").unwrap(), text.find("early line two").unwrap(), text.find("late line").unwrap());
    assert!(one < two && two < late, "{text}");
}

/// Lines logged before the data directory is known are written after the header, so the
/// header must not carry a later time than they do.
#[test]
fn the_start_header_is_not_stamped_later_than_the_lines_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let log = log_in(None);
    log.push_line("early line");
    std::thread::sleep(std::time::Duration::from_millis(20));
    log.attach(dir.path(), "1.2.3");
    log.push_line("late line");
    let text = log_text(dir.path());
    let stamps: Vec<&str> = text.lines().map(|line| line.split(' ').next().unwrap()).collect();
    assert!(text.lines().next().unwrap().contains("=== Forkyard 1.2.3 started"), "{text}");
    let mut sorted = stamps.clone();
    sorted.sort();
    assert_eq!(stamps, sorted, "lines out of time order:\n{text}");
}

#[test]
fn the_ring_keeps_only_the_newest_lines() {
    let log = log_in(None);
    for i in 0..(RING_LINES + 25) {
        log.push_line(&format!("line {i}"));
    }
    let lines = log.recent_lines();
    assert_eq!(lines.len(), RING_LINES);
    assert!(lines[0].ends_with("line 25"), "{}", lines[0]);
    assert!(lines.last().unwrap().ends_with(&format!("line {}", RING_LINES + 24)));
}

// --- Rotation --------------------------------------------------------------------------------

#[test]
fn the_log_rotates_and_keeps_three_files() {
    let dir = tempfile::tempdir().unwrap();
    let log = CrashLog::with_options(None, 2_000);
    log.attach(dir.path(), "1.2.3");
    for i in 0..400 {
        log.push_line(&format!("line {i:04} {}", "x".repeat(40)));
    }
    let logs = dir.path().join(LOG_DIR);
    let mut names: Vec<String> = std::fs::read_dir(&logs).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["forkyard.1.log", "forkyard.2.log", "forkyard.log"]);
    for name in &names {
        let size = std::fs::metadata(logs.join(name)).unwrap().len();
        assert!(size <= 2_000, "{name}: {size} bytes");
    }
    assert!(log_text(dir.path()).contains("line 0399"));
    let older = std::fs::read_to_string(logs.join("forkyard.1.log")).unwrap();
    assert!(!older.contains("line 0399") && older.contains("line 03"), "{older}");
}

// --- Retention -------------------------------------------------------------------------------

#[test]
fn at_most_ten_reports_are_kept_and_the_oldest_go() {
    let dir = tempfile::tempdir().unwrap();
    let crash = dir.path().join(CRASH_DIR);
    std::fs::create_dir_all(&crash).unwrap();
    for i in 0..14 {
        let report = ReportFile::new(ReportKind::Panic, 1_700_000_000_000 + i * 1000, "1.2.3", "run", format!("panic {i}"));
        write_report(dir.path(), &report).unwrap();
    }
    prune_reports(dir.path(), MAX_REPORTS);
    let kept = reports(dir.path());
    assert_eq!(kept.len(), MAX_REPORTS);
    // Newest first; panics 0-3 are gone.
    assert_eq!(kept[0].message, "panic 13");
    assert_eq!(kept.last().unwrap().message, "panic 4");
}

// --- Marker for hard crashes -----------------------------------------------------------------

#[test]
fn a_run_without_clean_exit_leaves_an_unexpected_exit_report() {
    let dir = tempfile::tempdir().unwrap();
    {
        let first = log_in(None);
        assert!(first.attach(dir.path(), "1.2.3").owns_marker);
        assert!(dir.path().join(MARKER_FILE).exists());
        first.push_line("checking out big");
        // Process dies here: no clean_exit.
    }
    let second = log_in(None);
    let outcome = second.attach(dir.path(), "1.2.3");
    assert!(outcome.owns_marker);
    let found = reports(dir.path());
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].kind, ReportKind::UnexpectedExit);
    assert_eq!(outcome.unexpected_report.as_deref(), Some(found[0].id.as_str()));
    assert!(found[0].log.iter().any(|line| line.contains("checking out big")), "{:?}", found[0].log);
    // The new run's own lines are not part of the old run's report.
    assert!(!found[0].log.iter().any(|line| line.contains(&second.run_id)));
}

/// A child process spawned by another thread (fork before exec) briefly shares the marker's
/// open file description. The end of a run must release the lock even then, or the next run
/// (here: the next test) is wrongly turned away as a second instance.
#[test]
fn the_end_of_a_run_releases_the_marker_even_while_a_copy_of_its_descriptor_lives() {
    let dir = tempfile::tempdir().unwrap();
    let first = log_in(None);
    assert!(first.attach(dir.path(), "1.2.3").owns_marker);
    let inherited = lock(&first.marker).as_ref().unwrap().0.try_clone().unwrap();
    drop(first);
    let second = log_in(None);
    assert!(second.attach(dir.path(), "1.2.3").owns_marker, "the dropped run still holds the marker");
    second.clean_exit();
    drop(inherited);
}

#[test]
fn a_clean_exit_leaves_no_report() {
    let dir = tempfile::tempdir().unwrap();
    let first = log_in(None);
    first.attach(dir.path(), "1.2.3");
    first.push_line("all good");
    first.clean_exit();
    assert!(!dir.path().join(MARKER_FILE).exists());
    drop(first);
    let second = log_in(None);
    assert_eq!(second.attach(dir.path(), "1.2.3").unexpected_report, None);
    assert!(reports(dir.path()).is_empty());
}

#[test]
fn a_run_that_left_a_panic_report_gets_no_second_report() {
    let dir = tempfile::tempdir().unwrap();
    {
        let first = log_in(None);
        first.attach(dir.path(), "1.2.3");
        let report = ReportFile::new(ReportKind::Panic, 1_700_000_000_000, "1.2.3", &first.run_id, "boom".into());
        write_report(dir.path(), &report).unwrap();
    }
    let second = log_in(None);
    assert_eq!(second.attach(dir.path(), "1.2.3").unexpected_report, None);
    assert_eq!(reports(dir.path()).len(), 1);
}

#[test]
fn a_second_instance_neither_reports_nor_takes_the_marker() {
    let dir = tempfile::tempdir().unwrap();
    let first = log_in(None);
    assert!(first.attach(dir.path(), "1.2.3").owns_marker);
    let second = log_in(None);
    let outcome = second.attach(dir.path(), "1.2.3");
    assert!(!outcome.owns_marker);
    assert_eq!(outcome.unexpected_report, None);
    assert!(reports(dir.path()).is_empty(), "the running first instance is not a crash");
    // The second instance ending does not remove the first one's marker.
    second.clean_exit();
    assert!(dir.path().join(MARKER_FILE).exists());
    first.clean_exit();
    assert!(!dir.path().join(MARKER_FILE).exists());
}

// --- Panic hook ------------------------------------------------------------------------------

#[test]
fn the_panic_hook_writes_a_scrubbed_report() {
    let dir = tempfile::tempdir().unwrap();
    let log: &'static CrashLog = Box::leak(Box::new(log_in(None)));
    log.attach(dir.path(), "9.8.7");
    log.push_line("before the panic");
    let me = std::thread::current().id();
    let previous = std::panic::take_hook();
    // Only this test's thread goes to the report; other tests panicking at the same time keep the default hook.
    std::panic::set_hook(Box::new(move |info| {
        if std::thread::current().id() == me {
            log.on_panic(info.payload(), info.location());
        }
    }));
    let result = std::panic::catch_unwind(|| panic!("boom with ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 inside"));
    std::panic::set_hook(previous);
    assert!(result.is_err());

    let found = reports(dir.path());
    assert_eq!(found.len(), 1, "{found:?}");
    let report = &found[0];
    assert_eq!(report.kind, ReportKind::Panic);
    assert_eq!(report.app_version, "9.8.7");
    assert_eq!(report.run_id, log.run_id);
    assert!(report.message.starts_with("boom with ***"), "{}", report.message);
    assert!(report.location.as_deref().is_some_and(|l| l.contains("tests.rs")), "{:?}", report.location);
    assert!(report.backtrace.as_deref().is_some_and(|b| !b.is_empty()));
    assert!(report.log.iter().any(|line| line.contains("before the panic")));
    let raw = std::fs::read_to_string(dir.path().join(CRASH_DIR).join(format!("{}.json", report.id))).unwrap();
    assert!(!raw.contains("ghp_AbCdEf"), "{raw}");
    // The panic is noted in the log file as well.
    assert!(log_text(dir.path()).contains("panic"));
}

#[test]
fn report_ids_are_checked() {
    let dir = tempfile::tempdir().unwrap();
    for bad in ["", "../x", "a/b", "a\\b", "..", "x.json"] {
        assert!(read_report(dir.path(), bad).is_err(), "{bad}");
    }
}
