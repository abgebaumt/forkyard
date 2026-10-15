//! Crash reports for the UI: list, read (with the last Git calls), save to a chosen file,
//! discard. The reports themselves are written by `crate::crash`; nothing is ever uploaded.

use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::crash::{self, ReportFile};
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::CrashReportSummary;
use crate::util;

/// Git calls appended to a report when it is read.
const ACTIVITY_ROWS: u32 = 20;
/// Calls that started this long after the end of a run still count as its own.
const ACTIVITY_SLACK_MS: i64 = 2_000;
/// Longest message in the list.
const SHORT_MESSAGE_CHARS: usize = 200;
/// Output of one Git call in the report.
const ACTIVITY_OUTPUT_BYTES: usize = 600;

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn short(message: &str) -> String {
    let first = message.lines().next().unwrap_or_default().trim();
    if first.chars().count() <= SHORT_MESSAGE_CHARS {
        first.to_string()
    } else {
        format!("{}…", first.chars().take(SHORT_MESSAGE_CHARS).collect::<String>())
    }
}

fn checked_id(id: &str) -> CoreResult<&str> {
    if crash::valid_report_id(id) {
        Ok(id)
    } else {
        Err(CoreError::not_allowed("Invalid crash report ID."))
    }
}

fn load(core: &Core, id: &str) -> CoreResult<ReportFile> {
    crash::read_report(core.data_dir(), checked_id(id)?).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::not_found("This crash report no longer exists."),
        _ => CoreError::io(format!("The crash report couldn’t be read: {e}")),
    })
}

/// Pending reports, newest first.
pub async fn crash_reports_list(core: &Core) -> CoreResult<Vec<CrashReportSummary>> {
    Ok(crash::list_reports(core.data_dir())
        .into_iter()
        .map(|r| CrashReportSummary { time: iso(r.time_ms), message: short(&r.message), kind: r.kind, app_version: r.app_version, id: r.id })
        .collect())
}

/// The full text of a report plus the last Git calls up to the time of the crash.
pub async fn crash_report_get(core: &Core, id: String) -> CoreResult<String> {
    let report = load(core, &id)?;
    Ok(full_text(core, &report))
}

fn full_text(core: &Core, report: &ReportFile) -> String {
    let mut text = crash::render_report(report);
    let (from, until) = activity_window(report);
    let scrub = |s: &str| crash::global().scrub(s);
    match core.db.with(|c| db::activity::latest_between(c, &from, &until, ACTIVITY_ROWS)) {
        Ok(rows) => {
            text.push_str(&format!("\nLast Git calls ({}, newest first):\n", rows.len()));
            for row in rows {
                let exit = row.exit_code.map_or_else(|| "-".to_string(), |c| c.to_string());
                text.push_str(&format!("{}  exit {exit}  {} ms  {}\n", row.started_at, row.duration_ms, scrub(&row.command)));
                let output = row.output.trim();
                if !output.is_empty() {
                    for line in util::truncate_str(&scrub(output), ACTIVITY_OUTPUT_BYTES).lines() {
                        text.push_str(&format!("    {line}\n"));
                    }
                }
            }
        }
        Err(e) => text.push_str(&format!("\nLast Git calls: not available ({})\n", scrub(&e.message))),
    }
    text
}

/// The Git calls that belong to the run of the report: from its start (if known) to the end of
/// the run. A little slack after the end: a call can start just after the last log line – but
/// never past the start of the next run, whose calls are not part of the report.
fn activity_window(report: &ReportFile) -> (String, String) {
    let from = report.run_started_ms.map(iso).unwrap_or_default();
    let mut until = report.time_ms + ACTIVITY_SLACK_MS;
    if let Some(next) = report.next_run_ms {
        until = until.min(next - 1).max(report.time_ms);
    }
    (from, iso(until))
}

/// Writes the full text to `path` (absolute, chosen by the user in the save dialog).
pub async fn crash_report_save(core: &Core, id: String, path: String) -> CoreResult<()> {
    let report = load(core, &id)?;
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err(CoreError::not_allowed("The crash report can only be saved to a full path."));
    }
    if target.is_dir() {
        return Err(CoreError::not_allowed(format!("“{}” is a folder.", util::display_path(&target))));
    }
    if !target.parent().is_some_and(Path::is_dir) {
        return Err(CoreError::not_found(format!("The folder for “{}” doesn’t exist.", util::display_path(&target))));
    }
    let text = full_text(core, &report);
    util::write_file_atomic(&target, text.as_bytes()).map_err(|e| CoreError::io(format!("The crash report couldn’t be saved: {e}")))
}

/// Deletes a report; no error if it is already gone.
pub async fn crash_report_discard(core: &Core, id: String) -> CoreResult<()> {
    crash::discard_report(core.data_dir(), checked_id(&id)?).map_err(|e| CoreError::io(format!("The crash report couldn’t be deleted: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crash::{self, ReportFile, ReportKind};
    use crate::error::ErrorCode;
    use crate::testkit::{TestCore, TestRepo};

    fn store(tc: &TestCore, kind: ReportKind, time_ms: i64, message: &str) -> String {
        let mut report = ReportFile::new(kind, time_ms, "1.0.0", "run-1", message.to_string());
        report.log = vec!["2026-10-14T10:00:00.000Z WARN gitcore: something".into()];
        report.backtrace = Some("   0: forkyard::main".into());
        crash::write_report(tc.data_dir(), &report).unwrap();
        report.id
    }

    #[tokio::test]
    async fn lists_newest_first_with_a_short_message() {
        let tc = TestCore::new().await;
        assert!(crash_reports_list(&tc).await.unwrap().is_empty());
        let old = store(&tc, ReportKind::UnexpectedExit, 1_700_000_000_000, "ended");
        let long = format!("first line {}\nsecond line", "x".repeat(400));
        let new = store(&tc, ReportKind::Panic, 1_700_000_100_000, &long);
        let list = crash_reports_list(&tc).await.unwrap();
        assert_eq!(list.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), [new.as_str(), old.as_str()]);
        assert_eq!(list[0].kind, ReportKind::Panic);
        assert_eq!(list[0].app_version, "1.0.0");
        assert!(list[0].time.starts_with("2023-11-14T22:"), "{}", list[0].time);
        assert!(list[0].message.starts_with("first line") && !list[0].message.contains("second"), "{}", list[0].message);
        assert!(list[0].message.chars().count() <= 201, "{}", list[0].message.len());
    }

    #[tokio::test]
    async fn the_full_text_carries_the_last_git_calls_redacted() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        tc.open(&repo).await;
        // An activity row with a credential in it (as an older version might have stored it).
        tc.db
            .with(|c| {
                crate::db::activity::insert(
                    c,
                    &crate::db::activity::NewActivity {
                        repo_id: None,
                        description: "git fetch".into(),
                        command: "git fetch https://anna:hunter2pass@git.example.com/r.git".into(),
                        exit_code: Some(128),
                        duration_ms: 12,
                        output: "fatal: token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 rejected".into(),
                        started_at: "2020-01-01T00:00:00.000Z".into(),
                        code: None,
                    },
                )
            })
            .unwrap();
        let id = store(&tc, ReportKind::Panic, chrono::Utc::now().timestamp_millis() + 5_000, "boom");
        let text = crash_report_get(&tc, id).await.unwrap();
        assert!(text.contains("boom") && text.contains("forkyard::main") && text.contains("WARN gitcore: something"), "{text}");
        assert!(text.contains("git fetch https://***@git.example.com/r.git"), "{text}");
        assert!(text.contains("git rev-parse"), "the calls of repo_open are there:\n{text}");
        assert!(!text.contains("hunter2pass") && !text.contains("ghp_AbCdEf"), "{text}");
        let calls = text.split("Last Git calls").nth(1).unwrap();
        assert!(calls.lines().filter(|l| l.starts_with("20")).count() <= 20, "{calls}");
    }

    /// The Git calls of a report are those of the run that ended: from its start to its last
    /// log line – not the calls of an earlier run, nor those of the run that found the report.
    #[tokio::test]
    async fn the_git_calls_are_those_of_the_run_that_ended() {
        let tc = TestCore::new().await;
        let (started, ended) = (1_700_000_000_000_i64, 1_700_000_060_000_i64);
        for (command, at) in [("git earlier-run", started - 10_000), ("git crashed-run", started + 1_000), ("git current-run", ended + 600)] {
            tc.db
                .with(|c| {
                    crate::db::activity::insert(
                        c,
                        &crate::db::activity::NewActivity {
                            repo_id: None,
                            description: command.into(),
                            command: command.into(),
                            exit_code: Some(0),
                            duration_ms: 1,
                            output: String::new(),
                            started_at: iso(at),
                            code: None,
                        },
                    )
                })
                .unwrap();
        }
        let mut report = ReportFile::new(ReportKind::UnexpectedExit, ended, "1.0.0", "run-1", "ended".into());
        report.run_started_ms = Some(started);
        report.next_run_ms = Some(ended + 500);
        crash::write_report(tc.data_dir(), &report).unwrap();
        let text = crash_report_get(&tc, report.id).await.unwrap();
        let calls = text.split("Last Git calls").nth(1).unwrap();
        assert!(calls.contains("git crashed-run"), "{calls}");
        assert!(!calls.contains("git earlier-run") && !calls.contains("git current-run"), "{calls}");
    }

    #[tokio::test]
    async fn saves_to_a_chosen_file_and_discards() {
        let tc = TestCore::new().await;
        let id = store(&tc, ReportKind::Panic, 1_700_000_000_000, "boom");
        let folder = tempfile::tempdir().unwrap();
        let target = folder.path().join("forkyard-crash.txt");
        crash_report_save(&tc, id.clone(), target.to_string_lossy().into_owned()).await.unwrap();
        let saved = std::fs::read_to_string(&target).unwrap();
        assert!(saved.contains("Forkyard crash report") && saved.contains("boom"), "{saved}");

        // Relative paths, folders and missing parents are refused.
        for bad in [String::from("relative.txt"), folder.path().to_string_lossy().into_owned(), folder.path().join("missing").join("x.txt").to_string_lossy().into_owned()] {
            let err = crash_report_save(&tc, id.clone(), bad.clone()).await.unwrap_err();
            assert!(matches!(err.code, ErrorCode::NotAllowed | ErrorCode::NotFound), "{bad}: {err:?}");
        }

        crash_report_discard(&tc, id.clone()).await.unwrap();
        assert!(crash_reports_list(&tc).await.unwrap().is_empty());
        assert_eq!(crash_report_get(&tc, id.clone()).await.unwrap_err().code, ErrorCode::NotFound);
        // Twice is fine; a bad ID is not.
        crash_report_discard(&tc, id).await.unwrap();
        assert_eq!(crash_report_discard(&tc, "../tabs".into()).await.unwrap_err().code, ErrorCode::NotAllowed);
    }

    /// A secret the core stores is removed from the app's log from then on.
    #[tokio::test]
    async fn stored_secrets_are_scrubbed_from_the_log() {
        let tc = TestCore::new().await;
        crate::secrets::set(&tc, "test-account", "Zq9-unique-secret-value").await.unwrap();
        let line = crash::global().scrub("proxy said Zq9-unique-secret-value");
        assert_eq!(line, "proxy said ***");
    }
}
