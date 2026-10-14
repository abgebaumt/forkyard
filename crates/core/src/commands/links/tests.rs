//! Tests for the ticket link rules, partly against real temp repositories.

use serde_json::json;

use super::*;
use crate::commands::settings::{repo_settings_get, repo_settings_set};
use crate::error::ErrorCode;
use crate::model::{CustomLinkRule, HostKind, LinkFileOrigin, LinkPreset, LinkPresetKind, LinkRuleSource, LinkRulesConfig};
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

const OPS_FILE: &str = r#"{"version":1,"rules":[{"id":"ops","pattern":"OPS-(\\d+)","url":"https://ops.example/t/$1"}]}"#;

async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

fn ids(rules: &LinkRules) -> Vec<&str> {
    rules.rules.iter().map(|rule| rule.id.as_str()).collect()
}

#[test]
fn presets_expand_to_patterns_the_checker_accepts() {
    let cases = [
        (LinkPresetKind::Jira, vec![], r"\b[A-Z][A-Z0-9]+-\d+\b", "https://j.example/browse/$0"),
        (LinkPresetKind::Jira, vec!["ABC".to_string(), "OPS".to_string()], r"\b(?:ABC|OPS)-\d+\b", "https://j.example/browse/$0"),
        (LinkPresetKind::Linear, vec![], r"\b[A-Z][A-Z0-9]+-\d+\b", "https://j.example/issue/$0"),
        (LinkPresetKind::Youtrack, vec!["ABC".to_string()], r"\b(?:ABC)-\d+\b", "https://j.example/issue/$0"),
        (LinkPresetKind::Redmine, vec!["ABC".to_string()], r"#(\d+)\b", "https://j.example/issues/$1"),
    ];
    for (kind, keys, pattern, url) in cases {
        let (got_pattern, got_url) = preset_rule(kind, "https://j.example", &keys);
        assert_eq!((got_pattern.as_str(), got_url.as_str()), (pattern, url), "{kind:?}");
        let groups = check_pattern(&got_pattern).unwrap();
        check_url_template(&got_url, groups).unwrap();
    }
    // The longest possible key list still fits the pattern limit.
    let keys: Vec<String> = (0..10).map(|n| format!("ABCDEFGHI{n}")).collect();
    assert!(check_pattern(&preset_rule(LinkPresetKind::Jira, "https://j.example", &keys).0).is_ok());
}

#[test]
fn host_rules_follow_the_host_kind() {
    let hub = host_rules(HostKind::Github, "https://github.com/octo/demo");
    assert_eq!(hub.iter().map(|r| r.url.as_str()).collect::<Vec<_>>(), ["https://github.com/octo/demo/issues/$1"]);
    let lab = host_rules(HostKind::Gitlab, "https://gitlab.com/gruppe/projekt");
    assert_eq!(
        lab.iter().map(|r| r.url.as_str()).collect::<Vec<_>>(),
        ["https://gitlab.com/gruppe/projekt/-/issues/$1", "https://gitlab.com/gruppe/projekt/-/merge_requests/$1"]
    );
    for rule in hub.iter().chain(&lab) {
        assert_eq!(rule.source, LinkRuleSource::Host);
        let groups = check_pattern(&rule.pattern).unwrap();
        check_url_template(&rule.url, groups).unwrap();
    }
}

#[test]
fn repo_file_rules_are_checked_one_by_one() {
    let file = br#"{"version":1,"rules":[
        {"id":"jira","pattern":"PROJ-\\d+","url":"https://jira.example/browse/$0"},
        {"pattern":"(?=x)y","url":"https://x.example/$0"},
        {"pattern":"BUG-(\\d+)","url":"javascript:alert(1)"},
        {"pattern":"T(\\d+)","url":"https://t.example/$1","extra":true},
        {"pattern":"OPS-(\\d+)","url":"https://ops.example/$1"}
    ]}"#;
    let (rules, problems) = parse_file(file);
    assert_eq!(rules.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["file:jira", "file:5"]);
    assert!(rules.iter().all(|r| r.source == LinkRuleSource::RepoFile));
    assert_eq!(problems.iter().map(|p| p.index).collect::<Vec<_>>(), [Some(1), Some(2), Some(3)]);
}

#[test]
fn a_broken_repo_file_is_reported_as_a_whole() {
    let cases = [
        (b"{ kaputt".to_vec(), "cannot be read"),
        (br#"{"version":2,"rules":[]}"#.to_vec(), "version 2"),
        (b"[1,2]".to_vec(), "cannot be read"),
        (vec![b' '; MAX_FILE_BYTES + 1], "64 KiB"),
    ];
    for (bytes, needle) in cases {
        let (rules, problems) = parse_file(&bytes);
        assert!(rules.is_empty(), "{needle}");
        assert_eq!(problems.len(), 1, "{needle}");
        assert_eq!(problems[0].index, None);
        assert!(problems[0].message.contains(needle), "{}", problems[0].message);
    }
}

#[tokio::test]
async fn rules_come_in_order_custom_preset_file_host() {
    let repo = TestRepo::with_commit();
    repo.git(&["remote", "add", "origin", "git@github.com:octo/demo.git"]);
    repo.commit_file(LINKS_FILE, OPS_FILE, "Link rules");
    let (tc, id) = open(&repo).await;
    repo_settings_set(
        &tc,
        id.clone(),
        json!({"linkRules": {
            "hostRules": true,
            "presets": [{"kind": "jira", "baseUrl": "https://firma.atlassian.net", "keys": ["PROJ"]}],
            "custom": [{"id": "cve", "pattern": "CVE-(\\d{4}-\\d+)", "url": "https://nvd.example/vuln/CVE-$1"}]
        }}),
    )
    .await
    .unwrap();
    let found = link_rules_get(&tc, id).await.unwrap();
    assert_eq!(ids(&found), ["custom:cve", "preset:jira:0", "file:ops", "host:issue"]);
    assert_eq!(
        found.rules.iter().map(|r| r.source).collect::<Vec<_>>(),
        [LinkRuleSource::Custom, LinkRuleSource::Preset, LinkRuleSource::RepoFile, LinkRuleSource::Host]
    );
    assert_eq!(found.rules[1].pattern, r"\b(?:PROJ)-\d+\b");
    assert_eq!(found.rules[1].url, "https://firma.atlassian.net/browse/$0");
    assert_eq!(found.rules[3].url, "https://github.com/octo/demo/issues/$1");
    assert_eq!(found.file, Some(LinkFileOrigin::Worktree));
    assert!(found.problems.is_empty());
}

#[tokio::test]
async fn without_a_file_in_the_working_directory_the_one_in_head_counts() {
    let repo = TestRepo::with_commit();
    repo.commit_file(LINKS_FILE, OPS_FILE, "Link rules");
    repo.remove_file(LINKS_FILE);
    let (tc, id) = open(&repo).await;
    let found = link_rules_get(&tc, id).await.unwrap();
    assert_eq!(found.file, Some(LinkFileOrigin::Head));
    assert_eq!(ids(&found), ["file:ops"]);

    // No commit, no file, no remote: nothing at all.
    let empty = TestRepo::new();
    let (tc, id) = open(&empty).await;
    let found = link_rules_get(&tc, id).await.unwrap();
    assert!(found.rules.is_empty());
    assert_eq!(found.file, None);
    assert!(found.problems.is_empty());
}

#[tokio::test]
async fn a_broken_links_file_keeps_the_other_rules() {
    let repo = TestRepo::with_commit();
    repo.git(&["remote", "add", "origin", "https://gitlab.com/gruppe/projekt.git"]);
    repo.write_file(LINKS_FILE, "{ kaputt");
    let (tc, id) = open(&repo).await;
    let found = link_rules_get(&tc, id.clone()).await.unwrap();
    assert_eq!(found.file, Some(LinkFileOrigin::Worktree));
    assert_eq!(found.problems.len(), 1);
    assert_eq!(found.problems[0].index, None);
    assert_eq!(ids(&found), ["host:issue", "host:merge_request"]);

    repo_settings_set(&tc, id.clone(), json!({"linkRules": {"hostRules": false, "presets": [], "custom": []}})).await.unwrap();
    assert!(link_rules_get(&tc, id).await.unwrap().rules.is_empty(), "host links switched off");
}

#[cfg(unix)]
#[tokio::test]
async fn a_links_file_pointing_outside_the_repository_is_ignored() {
    let repo = TestRepo::with_commit();
    let outside = repo.temp_dir().join("draussen.json");
    std::fs::write(&outside, OPS_FILE).unwrap();
    std::fs::create_dir_all(repo.path().join(".forkyard")).unwrap();
    std::os::unix::fs::symlink(&outside, repo.path().join(LINKS_FILE)).unwrap();
    let (tc, id) = open(&repo).await;
    let found = link_rules_get(&tc, id).await.unwrap();
    assert_eq!(found.file, Some(LinkFileOrigin::Worktree));
    assert!(found.rules.is_empty());
    assert!(found.problems[0].message.contains("outside"), "{:?}", found.problems);
}

#[tokio::test]
async fn a_links_file_does_not_lock_the_repository() {
    let repo = TestRepo::with_commit();
    repo.commit_file(LINKS_FILE, OPS_FILE, "Link rules");
    let tc = TestCore::new().await;
    // Directly through repo_open: TestCore::open would agree to the trust question itself.
    let opened = crate::commands::repos::repo_open(&tc, repo.path().to_string_lossy().into_owned()).await.unwrap();
    assert!(opened.repo.trusted, "a links file alone is no reason to lock the repository");
    assert_eq!(ids(&link_rules_get(&tc, opened.repo.id).await.unwrap()), ["file:ops"]);
}
