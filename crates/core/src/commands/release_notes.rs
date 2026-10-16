//! Release notes (v1.2, Teilpaket 7.2): the range since the last tag (no AI, no network), writing
//! the notes with the AI provider, and inserting them into CHANGELOG.md of the working directory
//! as a normal, uncommitted change. The host release is `host::release_create` (`commands/host.rs`).

use std::path::Path;

use crate::ai::release_notes;
use crate::ai::run::{self, AiRequest};
use crate::app::Core;
use crate::changelog;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::{AiFeature, ChangelogInsertResult, ReleaseNotes, ReleaseNotesRange, RepoChange};
use crate::util;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// "n commits since v1.1.0": works in every AI state. `included` is at most 300 here; the
/// request may send fewer when the model's context is small.
pub async fn release_notes_range(core: &Core, repo_id: String, from: Option<String>, to: Option<String>) -> CoreResult<ReleaseNotesRange> {
    core.repo_path(&repo_id)?;
    Ok(release_notes::resolve(core, &repo_id, from.as_deref(), to.as_deref()).await?.range)
}

/// Writes the release notes (job `job_id`). No commits in the range: empty notes, nothing sent.
pub async fn ai_release_notes(core: &Core, repo_id: String, job_id: String, from: Option<String>, to: Option<String>, locale: String) -> CoreResult<ReleaseNotes> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::ReleaseNotes)?;
    let budget = release_notes::budget(core, &settings);
    let secrets = release_notes::known_secrets(core, &settings).await;
    let context = release_notes::build(core, &repo_id, from.as_deref(), to.as_deref(), budget, &locale, &secrets).await?;
    if context.ids.is_empty() {
        return Ok(release_notes::empty_notes(context.range));
    }
    let file_headings = changelog_headings(core, &repo_id).await;
    let schema = release_notes::schema();
    let answer = run::complete_json(core, AiRequest { repo_id: Some(&repo_id), feature: AiFeature::ReleaseNotes, job_id: &job_id, prompt: &context.built.prompt, schema: &schema }).await?;
    Ok(release_notes::notes_from_answer(&answer.value, &context, file_headings))
}

/// The heading language of an existing, readable changelog (never through a link).
async fn changelog_headings(core: &Core, repo_id: &str) -> Option<changelog::HeadingLanguage> {
    let root = core.repo_path(repo_id).ok()?;
    tokio::task::spawn_blocking(move || {
        let path = changelog::find(&root).ok()??;
        if std::fs::symlink_metadata(&path).ok()?.file_type().is_symlink() {
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        let text = std::str::from_utf8(bytes.strip_prefix(UTF8_BOM).unwrap_or(&bytes)).ok()?;
        changelog::heading_language(text)
    })
    .await
    .ok()
    .flatten()
}

fn check_date(date: &str) -> CoreResult<()> {
    let bytes = date.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    let valid = bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' && digits(0..4) && digits(5..7) && digits(8..10) && {
        let month: u32 = date[5..7].parse().unwrap_or(0);
        let day: u32 = date[8..10].parse().unwrap_or(0);
        (1..=12).contains(&month) && (1..=31).contains(&day)
    };
    if valid {
        Ok(())
    } else {
        Err(CoreError::not_allowed(format!("“{date}” is not a date of the form YYYY-MM-DD.")))
    }
}

/// Inserts the section `## [<version>] - <date>` (style of the file) into CHANGELOG.md – created
/// if missing. Errors: `not_allowed` (version, date, a link, not UTF-8), `empty_message`,
/// `name_exists` (the version has a section), `io`.
pub async fn changelog_insert(core: &Core, repo_id: String, version: String, date: String, notes: String) -> CoreResult<ChangelogInsertResult> {
    let version = version.trim().to_string();
    util::check_ref_name(&version).map_err(CoreError::not_allowed)?;
    check_date(&date)?;
    if notes.trim().is_empty() {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The release notes are empty."));
    }
    let root = core.repo_path(&repo_id)?;
    core.with_write_lock(&repo_id, &[RepoChange::Worktree], async move {
        tokio::task::spawn_blocking(move || write_changelog(&root, &version, &date, &notes))
            .await
            .map_err(|e| CoreError::unknown(format!("Writing the changelog was aborted: {e}")))?
    })
    .await
}

fn write_changelog(root: &Path, version: &str, date: &str, notes: &str) -> CoreResult<ChangelogInsertResult> {
    let io = |e: std::io::Error| CoreError::io(format!("The changelog could not be written: {e}"));
    let (path, bytes, created, keep_a_changelog) = match changelog::find(root).map_err(io)? {
        Some(path) => {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if std::fs::symlink_metadata(&path).map_err(io)?.file_type().is_symlink() {
                return Err(CoreError::not_allowed(format!("{name} is a symbolic link; Forkyard does not write through it.")));
            }
            let existing = std::fs::read(&path).map_err(io)?;
            let (bom, body) = match existing.strip_prefix(UTF8_BOM) {
                Some(rest) => (UTF8_BOM, rest),
                None => (&b""[..], &existing[..]),
            };
            let text = std::str::from_utf8(body).map_err(|_| CoreError::not_allowed(format!("{name} is not UTF-8 text; Forkyard leaves it unchanged.")))?;
            let updated = changelog::insert(text, version, date, notes).map_err(CoreError::name_exists)?;
            let mut bytes = bom.to_vec();
            bytes.extend_from_slice(updated.as_bytes());
            (path, bytes, false, changelog::is_keep_a_changelog(text))
        }
        None => (root.join(changelog::FILE_NAME), changelog::new_file(version, date, notes).into_bytes(), true, true),
    };
    util::write_file_atomic(&path, &bytes).map_err(io)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(ChangelogInsertResult { path: name, created, keep_a_changelog })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::configure_base;
    use crate::commands::ai::{ai_preview, ai_preview_confirm};
    use crate::commands::settings::{repo_settings_set, settings_set};
    use crate::model::{AiAskTrigger, AiInput, AiProviderKind, ReleaseLanguage};
    use crate::testkit::{MockRequest, MockResponse, MockServer, TestCore, TestRepo};
    use serde_json::{json, Value};

    const KEY: &str = "sk-ant-api03-testkey-0123456789abcdef";

    fn ollama(content: Value) -> impl Fn(&MockRequest) -> MockResponse + Send + Sync + 'static {
        move |request| match request.route().as_str() {
            "POST /api/show" => MockResponse::json(200, json!({"model_info": {"qwen3.context_length": 40960}})),
            _ => MockResponse::json(200, json!({"model": "qwen3:8b", "message": {"role": "assistant", "content": content.to_string()}, "done": true, "done_reason": "stop", "prompt_eval_count": 120, "eval_count": 40})),
        }
    }

    async fn with_ollama(server: &MockServer) -> TestCore {
        let tc = TestCore::new().await;
        configure_base(&tc, AiProviderKind::Ollama, Some(server.url()));
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "ollama", "aiModel": "qwen3:8b"})).await.unwrap();
        tc
    }

    fn chats(server: &MockServer) -> Vec<MockRequest> {
        server.requests().into_iter().filter(|r| r.route() == "POST /api/chat").collect()
    }

    fn sent_text(request: &MockRequest) -> String {
        request.json()["messages"].as_array().map(|messages| messages.iter().filter_map(|m| m["content"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
    }

    struct Story {
        repo: TestRepo,
        export: String,
        fix: String,
        ci: String,
    }

    fn story() -> Story {
        let repo = TestRepo::with_commit();
        repo.git(&["tag", "-a", "v1.0.0", "-m", "Erste Version"]);
        let export = repo.commit_file("src/export.py", "def zeile(station, wert):\n    return f\"{station};{wert}\"\n", "CSV-Export für den Vergleich");
        let fix = repo.commit_file("src/bericht.py", "name = name or \"?\"\n", "Absturz bei leerem Stationsnamen behoben");
        let ci = repo.commit_file(".github/workflows/ci.yml", "on: push\n", "CI: Cache für pip");
        Story { repo, export, fix, ci }
    }

    fn german_answer(story: &Story) -> Value {
        json!({"language": "de", "added": [{"text": "Export des Vergleichs als CSV-Datei", "commits": [&story.export[..12]]}], "changed": [], "fixed": [{"text": "Kein Absturz mehr bei leerem Stationsnamen", "commits": [&story.fix[..12]]}], "other": []})
    }

    #[tokio::test]
    async fn release_notes_are_grouped_and_rendered_from_the_commits_since_the_tag() {
        let s = story();
        let server = MockServer::start(ollama(german_answer(&s)));
        let tc = with_ollama(&server).await;
        let id = tc.open(&s.repo).await.repo.id;
        let notes = ai_release_notes(&tc, id.clone(), "rn-1".into(), None, None, "de-DE".into()).await.unwrap();
        assert_eq!(notes.markdown, "### Neu\n\n- Export des Vergleichs als CSV-Datei\n\n### Behoben\n\n- Kein Absturz mehr bei leerem Stationsnamen");
        assert_eq!((notes.range.from.as_deref(), notes.language), (Some("v1.0.0"), ReleaseLanguage::De));
        assert_eq!(notes.range.commits.to_string(), s.repo.git(&["rev-list", "--no-merges", "--count", "v1.0.0..HEAD"]));
        assert_eq!(notes.unmentioned, 1, "the CI commit has no visible effect");
        let sent = chats(&server);
        assert_eq!(sent.len(), 1);
        let text = sent_text(&sent[0]);
        for (sha, subject) in [(&s.export, "CSV-Export für den Vergleich"), (&s.fix, "Absturz bei leerem Stationsnamen behoben"), (&s.ci, "CI: Cache für pip")] {
            assert!(text.contains(&format!("- {} {subject}", &sha[..12])), "{text}");
        }
        let tagged = s.repo.git(&["rev-parse", "v1.0.0^{commit}"]);
        assert!(!text.contains(&tagged[..12]), "the tagged commit belongs to the previous release");
        assert!(text.contains("- Erster Commit"), "the language sample has the older subjects too");
    }

    #[tokio::test]
    async fn an_english_changelog_keeps_english_headings_in_a_german_repository() {
        let s = story();
        s.repo.write_file("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-02\n\n### Added\n\n- First version.\n");
        let server = MockServer::start(ollama(german_answer(&s)));
        let tc = with_ollama(&server).await;
        let id = tc.open(&s.repo).await.repo.id;
        let notes = ai_release_notes(&tc, id, "rn-2".into(), None, None, "de".into()).await.unwrap();
        assert_eq!(notes.markdown, "### Added\n\n- Export des Vergleichs als CSV-Datei\n\n### Fixed\n\n- Kein Absturz mehr bei leerem Stationsnamen");
    }

    #[tokio::test]
    async fn nothing_is_sent_without_commits_in_the_range() {
        let s = story();
        let server = MockServer::start(ollama(german_answer(&s)));
        let tc = with_ollama(&server).await;
        let id = tc.open(&s.repo).await.repo.id;
        let notes = ai_release_notes(&tc, id.clone(), "rn-3".into(), Some("HEAD".into()), None, "en".into()).await.unwrap();
        assert_eq!((notes.markdown.as_str(), notes.range.commits, notes.groups.len()), ("", 0, 0));
        assert!(chats(&server).is_empty());
    }

    #[tokio::test]
    async fn api_providers_send_release_notes_only_after_the_preview_was_confirmed() {
        let s = story();
        let answer = json!({"language": "de", "added": [{"text": "Export als CSV", "commits": [&s.export[..12]]}], "changed": [], "fixed": [], "other": []});
        let server = MockServer::start(move |_| MockResponse::json(200, json!({"content": [{"type": "text", "text": answer.to_string()}], "stop_reason": "end_turn", "usage": {"input_tokens": 900, "output_tokens": 60}})));
        let tc = TestCore::new().await;
        configure_base(&tc, AiProviderKind::Anthropic, Some(format!("{}/v1", server.url())));
        crate::secrets::set(&tc, "llm:anthropic", KEY).await.unwrap();
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "anthropic", "aiModel": "claude-sonnet-5-5"})).await.unwrap();
        let id = tc.open(&s.repo).await.repo.id;

        let preview = ai_preview(&tc, id.clone(), AiFeature::ReleaseNotes, AiInput::ReleaseNotes { from: None, to: None }, "de".into()).await.unwrap();
        assert_eq!(preview.asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst]);
        assert!(preview.text.contains(&format!("- {} CSV-Export für den Vergleich", &s.export[..12])), "{}", preview.text);
        let refused = ai_release_notes(&tc, id.clone(), "rn-a".into(), None, None, "de".into()).await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::NotAllowed);
        assert!(server.requests().is_empty(), "nothing leaves before the confirmation");

        ai_preview_confirm(&tc, Some(id.clone()), AiFeature::ReleaseNotes, preview.fingerprint.clone(), preview.asks.clone(), false).await.unwrap();
        let notes = ai_release_notes(&tc, id.clone(), "rn-b".into(), None, None, "de".into()).await.unwrap();
        assert_eq!(notes.markdown, "### Neu\n\n- Export als CSV");
        assert_eq!(server.requests().len(), 1, "the confirmed text is exactly the one sent");
        assert!(!server.requests()[0].body_text().contains(KEY), "the key goes in a header, never into the content");
    }

    #[tokio::test]
    async fn ai_off_untrusted_and_dashes_send_nothing() {
        let s = story();
        let server = MockServer::start(ollama(german_answer(&s)));
        let tc = with_ollama(&server).await;
        let id = tc.open(&s.repo).await.repo.id;
        let code = |result: CoreResult<ReleaseNotes>| result.unwrap_err().code;
        repo_settings_set(&tc, id.clone(), json!({"aiOff": true})).await.unwrap();
        assert_eq!(code(ai_release_notes(&tc, id.clone(), "x1".into(), None, None, "en".into()).await), ErrorCode::AiDisabled);
        repo_settings_set(&tc, id.clone(), json!({"aiOff": false})).await.unwrap();
        settings_set(&tc, json!({"aiFeaturesOff": ["release_notes"]})).await.unwrap();
        assert_eq!(code(ai_release_notes(&tc, id.clone(), "x2".into(), None, None, "en".into()).await), ErrorCode::AiDisabled);
        settings_set(&tc, json!({"aiFeaturesOff": []})).await.unwrap();
        assert_eq!(code(ai_release_notes(&tc, id.clone(), "x3".into(), Some("--all".into()), None, "en".into()).await), ErrorCode::NotFound);
        assert_eq!(release_notes_range(&tc, id.clone(), None, Some("-n".into())).await.unwrap_err().code, ErrorCode::NotFound);
        crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
        assert_eq!(code(ai_release_notes(&tc, id, "x4".into(), None, None, "en".into()).await), ErrorCode::RepoUntrusted);
        assert!(chats(&server).is_empty());
    }

    #[tokio::test]
    async fn the_range_works_without_ai() {
        let s = story();
        let tc = TestCore::new().await;
        let id = tc.open(&s.repo).await.repo.id;
        let range = release_notes_range(&tc, id, None, None).await.unwrap();
        assert_eq!((range.from.as_deref(), range.commits, range.included, range.to_sha.as_str()), (Some("v1.0.0"), 3, 3, s.ci.as_str()));
    }

    #[tokio::test]
    async fn the_changelog_gets_a_normal_change_byte_exact_and_never_through_a_link() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let original = "\u{feff}# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [1.0.0] – 2026-01-02\r\n\r\n### Neu\r\n\r\n- Erste Version für „Süd“\r\n";
        repo.commit_file("CHANGELOG.md", original, "Changelog angelegt");
        let id = tc.open(&repo).await.repo.id;
        let result = changelog_insert(&tc, id.clone(), "v1.1.0".into(), "2026-10-20".into(), "### Behoben\n\n- Absturz bei leerem Namen\n".into()).await.unwrap();
        assert_eq!(result, ChangelogInsertResult { path: "CHANGELOG.md".into(), created: false, keep_a_changelog: true });
        assert_eq!(
            String::from_utf8(repo.read_file("CHANGELOG.md")).unwrap(),
            "\u{feff}# Changelog\r\n\r\n## [Unreleased]\r\n\r\n## [1.1.0] – 2026-10-20\r\n\r\n### Behoben\r\n\r\n- Absturz bei leerem Namen\r\n\r\n## [1.0.0] – 2026-01-02\r\n\r\n### Neu\r\n\r\n- Erste Version für „Süd“\r\n"
        );
        assert_eq!(repo.git(&["status", "--porcelain"]), " M CHANGELOG.md", "a normal change in the working directory");
        assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "", "nothing is staged");
        assert!(tc.events.all().iter().any(|(name, payload)| name == crate::events::names::REPO_CHANGED && payload.to_string().contains("worktree")));

        let before = repo.read_file("CHANGELOG.md");
        assert_eq!(changelog_insert(&tc, id.clone(), "1.1.0".into(), "2026-10-21".into(), "- noch einmal".into()).await.unwrap_err().code, ErrorCode::NameExists);
        for (version, date) in [("-v1", "2026-10-20"), ("v1.2.0", "20.10.2026"), ("v1.2.0", "2026-13-01"), ("v 1", "2026-10-20")] {
            assert_eq!(changelog_insert(&tc, id.clone(), version.into(), date.into(), "- x".into()).await.unwrap_err().code, ErrorCode::NotAllowed, "{version} {date}");
        }
        assert_eq!(changelog_insert(&tc, id.clone(), "v1.2.0".into(), "2026-10-20".into(), "  \n".into()).await.unwrap_err().code, ErrorCode::EmptyMessage);
        assert_eq!(repo.read_file("CHANGELOG.md"), before, "refused calls change nothing");

        std::fs::write(repo.path().join("CHANGELOG.md"), b"# \xc4nderungen\n").unwrap();
        assert_eq!(changelog_insert(&tc, id.clone(), "v1.2.0".into(), "2026-10-20".into(), "- x".into()).await.unwrap_err().code, ErrorCode::NotAllowed, "not UTF-8");
        assert_eq!(repo.read_file("CHANGELOG.md"), b"# \xc4nderungen\n".to_vec());

        #[cfg(unix)]
        {
            let outside = repo.temp_dir().join("draussen.md");
            std::fs::write(&outside, "# Draußen\n").unwrap();
            std::fs::remove_file(repo.path().join("CHANGELOG.md")).unwrap();
            std::os::unix::fs::symlink(&outside, repo.path().join("CHANGELOG.md")).unwrap();
            assert_eq!(changelog_insert(&tc, id, "v1.2.0".into(), "2026-10-20".into(), "- x".into()).await.unwrap_err().code, ErrorCode::NotAllowed, "a link");
            assert_eq!(std::fs::read_to_string(&outside).unwrap(), "# Draußen\n");
        }
    }

    #[tokio::test]
    async fn the_changelog_is_created_or_found_ignoring_case() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let created = changelog_insert(&tc, id.clone(), "v0.1.0".into(), "2026-10-20".into(), "### Neu\n\n- Erste Version".into()).await.unwrap();
        assert_eq!(created, ChangelogInsertResult { path: "CHANGELOG.md".into(), created: true, keep_a_changelog: true });
        assert_eq!(String::from_utf8(repo.read_file("CHANGELOG.md")).unwrap(), "# Changelog\n\n## [0.1.0] - 2026-10-20\n\n### Neu\n\n- Erste Version\n");
        assert_eq!(repo.git(&["status", "--porcelain"]), "?? CHANGELOG.md");

        let other = TestRepo::with_commit();
        other.commit_file("changelog.md", "# Änderungen\n\n## 0.3.0 - 2024-03-01\n\n- Größere Schrift\n", "Änderungen");
        let other_id = tc.open(&other).await.repo.id;
        let found = changelog_insert(&tc, other_id, "0.4.0".into(), "2026-10-20".into(), "- Export".into()).await.unwrap();
        assert_eq!((found.path.as_str(), found.created, found.keep_a_changelog), ("changelog.md", false, false));
        assert_eq!(String::from_utf8(other.read_file("changelog.md")).unwrap(), "# Änderungen\n\n## 0.4.0 - 2026-10-20\n\n- Export\n\n## 0.3.0 - 2024-03-01\n\n- Größere Schrift\n");
        assert_eq!(other.git(&["status", "--porcelain"]), " M changelog.md");
    }
}
