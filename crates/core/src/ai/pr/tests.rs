//! Tests of Paket 4 (pull request description): literal fixtures, Git itself as the oracle, real
//! temp repositories and a local mock provider – never a real service.

use serde_json::json;

use super::*;
use crate::commands::links::host_rules;
use crate::model::{HostKind, LinkRule, LinkRuleSource};

fn jira() -> LinkRule {
    // As the Jira preset with key ABC produces it (commands/links.rs, `preset_rule`).
    LinkRule { id: "preset:jira:0".into(), source: LinkRuleSource::Preset, pattern: r"\b(?:ABC)-\d+\b".into(), url: "https://firma.atlassian.net/browse/$0".into() }
}

fn redmine() -> LinkRule {
    LinkRule { id: "preset:redmine:0".into(), source: LinkRuleSource::Preset, pattern: r"#(\d+)\b".into(), url: "https://redmine.example/issues/$1".into() }
}

#[test]
fn the_answer_schema_is_in_the_dialect() {
    assert_eq!(crate::ai::schema::check_dialect(&schema()), Ok(()));
}

#[test]
fn template_headings_are_the_atx_headings_outside_code_and_comments() {
    let template = concat!(
        "## Was ändert sich?\n\n",
        "<!-- ## Kein Abschnitt\n   auch nicht -->\n",
        "### Wie   getestet? ###\r\n",
        "   # Hinweise\n",
        "#Kein Abschnitt\n",
        "```md\n## Beispiel im Code\n```\n",
        "~~~~\n# auch nicht\n~~~~\n",
        "    ## eingerückt ist Code\n",
        "- [ ] Tests grün\n",
        "####### sieben\n",
        "<!-- einzeilig --> ## danach kein Abschnitt\n",
    );
    assert_eq!(template_headings(template), ["## Was ändert sich?", "### Wie getestet?", "# Hinweise"]);
    assert!(template_headings("Nur Text\n- [ ] Punkt\n").is_empty());
}

#[test]
fn answers_must_keep_every_template_heading_and_a_one_line_title() {
    let headings = template_headings("## Was ändert sich?\n\n## Wie getestet?\n- [ ] Tests\n");
    let ok = json!({"title": "Auswertung je Station", "body": "## Was ändert sich?\nNeu.\n\n## Wie getestet?\n- [ ] Tests\n"});
    assert_eq!(check_answer(&ok, &headings), Ok(()));
    let missing = check_answer(&json!({"title": "Auswertung", "body": "## Was ändert sich?\nNeu.\n"}), &headings).unwrap_err();
    assert!(missing.contains("missing: ## Wie getestet?"), "{missing}");
    let renamed = check_answer(&json!({"title": "A", "body": "## Was ändert sich\n\n## Wie getestet?\n"}), &headings).unwrap_err();
    assert!(renamed.contains("## Was ändert sich?"), "{renamed}");
    assert!(check_answer(&json!({"title": "A", "body": "### Was ändert sich?\n## Wie getestet?\n"}), &headings).is_err(), "the level belongs to the heading");
    assert!(check_answer(&json!({"title": "A", "body": "```\n## Was ändert sich?\n## Wie getestet?\n```\n"}), &headings).is_err(), "headings inside code do not count");
    assert_eq!(check_answer(&json!({"title": "A", "body": "## Wie getestet?\n\n## Was ändert sich?\n"}), &headings), Ok(()), "the order is not checked");
    assert!(check_answer(&json!({"title": "  ", "body": ""}), &[]).unwrap_err().contains("title is empty"));
    assert!(check_answer(&json!({"title": "Zeile 1\nZeile 2", "body": ""}), &[]).unwrap_err().contains("single line"));
    assert!(check_answer(&json!({"title": "ä".repeat(301), "body": ""}), &[]).unwrap_err().contains("300"));
    assert_eq!(check_answer(&json!({"title": "ä".repeat(300), "body": ""}), &[]), Ok(()), "300 characters, not bytes");
    assert_eq!(check_answer(&json!({"title": "Ohne Vorlage", "body": "Freier Text"}), &[]), Ok(()));
}

#[test]
fn ticket_references_follow_the_rules_in_order_of_appearance() {
    let mut rules = vec![jira()];
    rules.extend(host_rules(HostKind::Gitlab, "https://gitlab.com/gruppe/projekt"));
    let messages = vec!["Fix Sortierung (#12)\n\nSiehe ABC-42 und !7".to_string(), "Nachtrag zu #12, #3 und #12a\n".to_string()];
    assert_eq!(
        tickets(&messages, &rules),
        vec![
            Ticket { text: "#12".into(), url: "https://gitlab.com/gruppe/projekt/-/issues/12".into() },
            Ticket { text: "ABC-42".into(), url: "https://firma.atlassian.net/browse/ABC-42".into() },
            Ticket { text: "!7".into(), url: "https://gitlab.com/gruppe/projekt/-/merge_requests/7".into() },
            Ticket { text: "#3".into(), url: "https://gitlab.com/gruppe/projekt/-/issues/3".into() },
        ]
    );
    assert_eq!(issue_numbers(&messages, &rules), vec![12, 3], "first appearance, once; `!7` is a merge request, `#12a` no number");
}

#[test]
fn a_tracker_rule_for_hash_numbers_wins_over_the_host() {
    let mut rules = vec![redmine()];
    rules.extend(host_rules(HostKind::Github, "https://github.com/octo/demo"));
    let messages = vec!["Behebt #12".to_string()];
    assert_eq!(tickets(&messages, &rules), vec![Ticket { text: "#12".into(), url: "https://redmine.example/issues/12".into() }]);
    assert!(issue_numbers(&messages, &rules).is_empty(), "#12 is a Redmine ticket here, not a host issue");
    assert!(issue_numbers(&messages, &[]).is_empty(), "host links switched off");
}

#[test]
fn closing_keywords_come_only_from_the_commits() {
    let body = "## Was\nBehebt den Fehler. Fixes #77, closes: #12 und RESOLVED #5.\n";
    let done = finish(&json!({"title": " Sortierung repariert ", "body": body}), &[12, 3]);
    assert_eq!(done.title, "Sortierung repariert");
    assert_eq!(done.body, "## Was\nBehebt den Fehler. #77, closes: #12 und #5.\n\nCloses #3");
    assert_eq!(done.closes, vec![12, 3]);
    assert_eq!(finish(&json!({"title": "T", "body": ""}), &[4]).body, "Closes #4");
    assert_eq!(finish(&json!({"title": "T", "body": "Text\r\n"}), &[]).body, "Text");
    assert_eq!(with_closes("Fix #9 and close #9", &[9]), "Fix #9 and close #9", "already closed in the text");
    assert_eq!(strip_foreign_closes("Closes #1; see #2", &[]), "#1; see #2");
}
