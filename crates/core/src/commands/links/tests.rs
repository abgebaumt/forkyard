//! Tests for the ticket link rules, partly against real temp repositories.

use serde_json::json;

use super::*;
use crate::commands::settings::{repo_settings_get, repo_settings_set};
use crate::error::ErrorCode;
use crate::model::{CustomLinkRule, LinkPreset, LinkPresetKind, LinkRulesConfig};
use crate::testkit::{TestCore, TestRepo};

fn rule(id: &str, pattern: &str, url: &str) -> CustomLinkRule {
    CustomLinkRule { id: id.into(), pattern: pattern.into(), url: url.into() }
}

fn preset(kind: LinkPresetKind, base_url: &str, keys: &[&str]) -> LinkPreset {
    LinkPreset { kind, base_url: base_url.into(), keys: keys.iter().map(|key| key.to_string()).collect() }
}

#[test]
fn url_templates_need_a_fixed_host_and_known_groups() {
    assert_eq!(check_url_template("https://jira.example/browse/$0", 0).unwrap(), "https://jira.example/browse/$0");
    assert_eq!(check_url_template(" http://tracker.local/issues/$1 ", 1).unwrap(), "http://tracker.local/issues/$1");
    assert_eq!(check_url_template("https://ops.example/t?id=$1&x=$0", 1).unwrap(), "https://ops.example/t?id=$1&x=$0");
    for (url, groups) in [
        ("ftp://x.example/$0", 0),
        ("javascript:alert(1)//$0", 0),
        ("https://$0", 0),
        ("https://jira.example$0/x", 0),
        ("https://user@jira.example/$0", 0),
        ("https:///$0", 0),
        ("https://jira.example/$2", 1),
        ("https://jira.example/$x", 0),
        ("https://jira.example/a b/$0", 0),
    ] {
        assert!(check_url_template(url, groups).is_err(), "{url}");
    }
    assert!(check_url_template("https://jira.example/$2", 1).unwrap_err().contains("$2"));
}

#[test]
fn base_urls_are_trimmed_and_checked() {
    assert_eq!(check_base_url(" https://firma.atlassian.net/ ").unwrap(), "https://firma.atlassian.net");
    assert_eq!(check_base_url("https://linear.app/team/").unwrap(), "https://linear.app/team");
    for bad in ["ftp://x.example", "https://", "https://u@x.example", "https://x.example/?a", "https://x.example/#a", "https://x.example/$0", "https://x y.example"] {
        assert!(check_base_url(bad).is_err(), "{bad}");
    }
}

#[test]
fn config_is_checked_and_normalised() {
    let config = LinkRulesConfig {
        host_rules: false,
        presets: vec![
            preset(LinkPresetKind::Jira, " https://firma.atlassian.net/ ", &["abc", "ABC", " def "]),
            preset(LinkPresetKind::Redmine, "https://redmine.example/", &["ABC"]),
        ],
        custom: vec![rule(" cve ", r"CVE-(\d{4}-\d+)", " https://nvd.example/vuln/CVE-$1 ")],
    };
    let normalised = normalize_config(&config).unwrap();
    assert!(!normalised.host_rules);
    assert_eq!(normalised.presets[0].base_url, "https://firma.atlassian.net");
    assert_eq!(normalised.presets[0].keys, ["ABC", "DEF"]);
    assert_eq!(normalised.presets[1].base_url, "https://redmine.example");
    assert!(normalised.presets[1].keys.is_empty(), "Redmine has no project keys");
    assert_eq!(normalised.custom, [rule("cve", r"CVE-(\d{4}-\d+)", "https://nvd.example/vuln/CVE-$1")]);

    let bad = |custom: Vec<CustomLinkRule>, presets: Vec<LinkPreset>| normalize_config(&LinkRulesConfig { host_rules: true, presets, custom }).unwrap_err();
    let error = bad(vec![rule("a", "(?=x)", "https://x.example/$0")], vec![]);
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.starts_with("Rule 1:"), "{}", error.message);
    assert!(bad(vec![rule("a", r"A-\d+", "https://x.example/$0"), rule("a", r"B-\d+", "https://x.example/$0")], vec![]).message.contains("twice"));
    assert!(bad(vec![rule("a b", r"A-\d+", "https://x.example/$0")], vec![]).message.contains("ID"));
    assert!(bad(vec![rule("a", r"A-(\d+)", "https://x.example/$2")], vec![]).message.contains("$2"));
    assert!(bad(vec![], vec![preset(LinkPresetKind::Jira, "ftp://jira.example", &[])]).message.starts_with("Jira:"));
    assert!(bad(vec![], vec![preset(LinkPresetKind::Linear, "https://linear.app/x", &["1AB"])]).message.contains("1AB"));
    let many: Vec<CustomLinkRule> = (0..=MAX_RULES).map(|n| rule(&format!("r{n}"), r"A-\d+", "https://x.example/$0")).collect();
    assert!(bad(many, vec![]).message.contains("50"));
    let presets: Vec<LinkPreset> = (0..=MAX_PRESETS).map(|_| preset(LinkPresetKind::Jira, "https://j.example", &[])).collect();
    assert!(bad(vec![], presets).message.contains("10"));
}

#[tokio::test]
async fn link_rules_are_checked_and_stored_with_the_repository() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert_eq!(repo_settings_get(&tc, id.clone()).await.unwrap().link_rules, LinkRulesConfig::default());
    assert!(LinkRulesConfig::default().host_rules, "host links are on by default");

    let s = repo_settings_set(
        &tc,
        id.clone(),
        json!({"linkRules": {"hostRules": false, "presets": [{"kind": "jira", "baseUrl": "https://firma.atlassian.net/", "keys": ["proj"]}], "custom": []}}),
    )
    .await
    .unwrap();
    assert_eq!(s.link_rules.presets[0].base_url, "https://firma.atlassian.net");
    assert_eq!(s.link_rules.presets[0].keys, ["PROJ"]);

    let error = repo_settings_set(
        &tc,
        id.clone(),
        json!({"linkRules": {"hostRules": true, "presets": [], "custom": [{"id": "x", "pattern": "(a+)+", "url": "https://x.example/$0"}]}}),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("Rule 1"), "{}", error.message);

    let tc = tc.restart().await;
    let s = repo_settings_get(&tc, id).await.unwrap();
    assert!(!s.link_rules.host_rules, "the rejected patch changed nothing");
    assert_eq!(s.link_rules.presets.len(), 1);
}
