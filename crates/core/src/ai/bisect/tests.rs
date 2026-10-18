//! Tests of the bisect autopilot's AI request: answer parsing here; the prompt builder below.

use super::*;
use crate::error::ErrorCode;

#[test]
fn the_answer_schema_is_in_the_dialect() {
    crate::ai::schema::check_dialect(&schema()).unwrap();
    assert_eq!(schema()["required"], json!(["script", "summary"]));
}

#[test]
fn an_answer_becomes_a_script_for_the_shell_of_this_system() {
    let sh = parse_answer(
        &json!({"script": "```sh\r\nif grep -q '5 / 9' umrechnung.py; then exit 1; fi\r\nexit 0\r\n```", "summary": "  Prüft, ob die Formel vertauscht ist.  "}),
        BisectShell::Sh,
    )
    .unwrap();
    assert_eq!(
        sh,
        BisectScript {
            script: "if grep -q '5 / 9' umrechnung.py; then exit 1; fi\nexit 0\n".into(),
            summary: "Prüft, ob die Formel vertauscht ist.".into(),
            shell: BisectShell::Sh,
        }
    );
    let ps = parse_answer(&json!({"script": "if (Select-String -Path umrechnung.py -SimpleMatch -Quiet '5 / 9') { exit 1 }\nexit 0", "summary": "Checks the formula."}), BisectShell::Powershell).unwrap();
    assert_eq!(ps.script, "if (Select-String -Path umrechnung.py -SimpleMatch -Quiet '5 / 9') { exit 1 }\r\nexit 0\r\n");
    assert_eq!(ps.shell, BisectShell::Powershell);
}

#[test]
fn unusable_scripts_are_invalid_answers() {
    for script in ["", "   \n", "```sh\n```", "exit 0\u{0}"] {
        let error = parse_answer(&json!({"script": script, "summary": "x"}), BisectShell::Sh).unwrap_err();
        assert_eq!(error.code, ErrorCode::AiInvalidAnswer, "{script:?}");
    }
    let long = "#".repeat(MAX_SCRIPT_BYTES + 1);
    assert_eq!(parse_answer(&json!({"script": long, "summary": "x"}), BisectShell::Sh).unwrap_err().code, ErrorCode::AiInvalidAnswer);
    let summary = "ä".repeat(400);
    assert_eq!(parse_answer(&json!({"script": "exit 0", "summary": summary}), BisectShell::Sh).unwrap().summary.chars().count(), 300);
}

#[test]
fn scripts_typed_by_the_user_get_the_same_line_endings() {
    assert_eq!(normalize_script("exit 0", BisectShell::Sh), "exit 0\n");
    assert_eq!(normalize_script("a\r\nb\rc\n", BisectShell::Sh), "a\nb\nc\n");
    assert_eq!(normalize_script("a\nb", BisectShell::Powershell), "a\r\nb\r\n");
    // A fence is only removed when it wraps the whole script.
    assert_eq!(normalize_script("echo '```'\nexit 0\n", BisectShell::Sh), "echo '```'\nexit 0\n");
    assert_eq!(script_problem("exit 0\n"), None);
    assert_eq!(script_problem(" \n"), Some("the script is empty"));
}

#[test]
fn this_system_uses_its_own_shell() {
    assert_eq!(BisectShell::current(), if cfg!(windows) { BisectShell::Powershell } else { BisectShell::Sh });
    assert_eq!((BisectShell::Sh.file_name(), BisectShell::Powershell.file_name()), ("test.sh", "test.ps1"));
}
