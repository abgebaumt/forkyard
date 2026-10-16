//! Tags (F14).
//!
//! By the undo convention, creating and deleting a tag cannot be undone and write no
//! undo entry. The network calls (pushing a tag, deleting a tag on the remote) do not
//! change the local repository and therefore run without the write lock: a hanging
//! server blocks no local action.

use crate::app::Core;
use crate::commands::commit::{hook_failure, Hooks};
use crate::commands::refs;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors;
use crate::jobs::Job;
use crate::model::{PushResult, RefsSnapshot, RepoChange};
use crate::secret_scan;
use crate::undo;
use crate::util;

fn check_name(name: &str) -> CoreResult<()> {
    util::check_ref_name(name).map_err(|reason| CoreError::invalid_name(format!("“{name}” isn’t a valid tag name: {reason}")))
}

fn tag_ref(name: &str) -> String {
    format!("refs/tags/{name}")
}

async fn ensure_remote(core: &Core, repo_id: &str, remote: &str) -> CoreResult<()> {
    let out = core.git_for(repo_id)?.arg("remote").read_only().no_log().run().await?;
    if out.stdout_lines().into_iter().any(|line| line == remote.as_bytes()) {
        Ok(())
    } else {
        Err(CoreError::new(ErrorCode::NoRemote, format!("The remote “{remote}” doesn’t exist in this repository.")))
    }
}

/// Annotated with `message`, lightweight otherwise. `sha: None` = HEAD.
pub async fn tag_create(core: &Core, repo_id: String, name: String, sha: Option<String>, message: Option<String>) -> CoreResult<RefsSnapshot> {
    core.repo_path(&repo_id)?;
    check_name(&name)?;
    let message = match message {
        Some(text) if text.trim().is_empty() => {
            return Err(CoreError::new(ErrorCode::EmptyMessage, "An annotated tag needs a description."));
        }
        Some(text) => Some(format!("{}\n", text.trim_end())),
        None => None,
    };
    core.with_write_lock(&repo_id, &[RepoChange::Refs], async {
        if undo::rev_parse(core, &repo_id, &tag_ref(&name)).await?.is_some() {
            return Err(CoreError::name_exists(format!("A tag named “{name}” already exists.")));
        }
        let target = match &sha {
            Some(sha) => undo::rev_parse(core, &repo_id, &format!("{sha}^{{commit}}"))
                .await?
                .ok_or_else(|| CoreError::not_found(format!("The commit “{sha}” wasn’t found.")))?,
            None => undo::rev_parse(core, &repo_id, "HEAD^{commit}")
                .await?
                .ok_or_else(|| CoreError::not_allowed("You can’t create a tag without a commit. Commit first."))?,
        };
        let mut cmd = core.git_for(&repo_id)?.arg("tag");
        if let Some(message) = message {
            // Message via stdin; "#" lines are text here, not comments.
            cmd = cmd.args(["-a", "--cleanup=whitespace", "-F", "-"]).stdin(message);
        }
        cmd.arg(&name).arg(&target).run().await?;
        refs::read_refs(core, &repo_id).await
    })
    .await
}

/// Deletes a tag; with `remote` there as well (there first: if the network fails, nothing changes locally).
pub async fn tag_delete(core: &Core, repo_id: String, name: String, remote: Option<String>) -> CoreResult<RefsSnapshot> {
    core.repo_path(&repo_id)?;
    check_name(&name)?;
    let remote = util::non_empty(remote);
    let exists_locally = undo::rev_parse(core, &repo_id, &tag_ref(&name)).await?.is_some();
    match &remote {
        Some(remote) => {
            ensure_remote(core, &repo_id, remote).await?;
            let out = core
                .git_for(&repo_id)?
                .args(["push", "--porcelain", "--", remote])
                .arg(format!(":{}", tag_ref(&name)))
                .network()
                .run_raw()
                .await?;
            // If the tag is already missing on the remote, the goal is reached.
            if !out.success() && !out.stderr_text().to_lowercase().contains("remote ref does not exist") {
                return Err(errors::classify("push", out.code, &out.stdout, &out.stderr));
            }
        }
        None if !exists_locally => {
            return Err(CoreError::not_found(format!("The tag “{name}” doesn’t exist (anymore).")));
        }
        None => {}
    }
    core.with_write_lock(&repo_id, &[RepoChange::Refs], async {
        if undo::rev_parse(core, &repo_id, &tag_ref(&name)).await?.is_some() {
            core.git_for(&repo_id)?.args(["tag", "-d", &name]).run().await?;
        }
        refs::read_refs(core, &repo_id).await
    })
    .await
}

/// Parses `git push --porcelain` for one ref: `<flag>\t<from>:<to>\t<summary>`.
fn parse_push_porcelain(stdout: &[u8], target_ref: &str) -> Option<(u8, String)> {
    for line in util::split_records(stdout, b'\n') {
        let line = util::decode_lossy(line);
        let mut parts = line.trim_end_matches('\r').splitn(3, '\t');
        let (Some(flag), Some(refspec), Some(summary)) = (parts.next(), parts.next(), parts.next()) else { continue };
        if refspec.rsplit(':').next() == Some(target_ref) {
            return Some((flag.bytes().next().unwrap_or(b' '), summary.to_string()));
        }
    }
    None
}

pub(crate) async fn push_tag(core: &Core, repo_id: &str, job: &Job, name: &str, remote: &str, accepted: Option<&[String]>) -> CoreResult<PushResult> {
    check_name(name)?;
    let full = tag_ref(name);
    if undo::rev_parse(core, repo_id, &full).await?.is_none() {
        return Err(CoreError::not_found(format!("The tag “{name}” doesn’t exist (anymore).")));
    }
    ensure_remote(core, repo_id, remote).await?;
    if let Some(stop) = secret_scan::check_push(core, repo_id, std::slice::from_ref(&full), remote, accepted, Some(job), job.token()).await? {
        return Ok(stop);
    }
    let hooks = Hooks::start(core, repo_id).await;
    let out = hooks
        .wrap(core.git_for(repo_id)?)
        .args(["push", "--porcelain", "--progress", "--", remote])
        .arg(format!("{full}:{full}"))
        .network()
        .check(false)
        .run_stream(job.token(), &mut |line| job.progress_line(line))
        .await;
    let ran = hooks.finish(core, repo_id);
    let out = out?;
    if !out.success() {
        if let Some(error) = hook_failure(&ran, &["pre-push"], &out, "the push") {
            return Err(error);
        }
    }
    match parse_push_porcelain(&out.stdout, &full) {
        Some((b'=', _)) => Ok(PushResult::UpToDate),
        Some((b'!', summary)) => {
            let reason = if summary.to_lowercase().contains("already exists") {
                format!("“{remote}” already has a different tag named “{name}”. Tags are never overwritten silently.")
            } else {
                format!("“{remote}” rejected the tag: {summary}")
            };
            Ok(PushResult::Rejected { reason })
        }
        Some((flag, _)) if out.success() => {
            Ok(PushResult::Done { remote: remote.to_string(), branch: name.to_string(), created_upstream: false, forced: flag == b'+' })
        }
        None if out.success() => Ok(PushResult::UpToDate),
        _ => Err(errors::classify("push", out.code, &out.stdout, &out.stderr)),
    }
}

/// Pushes a tag to a remote (cancellable job with progress and `job:done`).
/// In `PushResult::Done` the tag name is in the `branch` field. Runs the secret scan.
pub async fn tag_push(core: &Core, repo_id: String, job_id: String, name: String, remote: String) -> CoreResult<PushResult> {
    tag_push_checked(core, repo_id, job_id, name, remote, None).await
}

/// `tag_push` with the IDs of secret-scan findings the user saw and pushes anyway.
pub async fn tag_push_checked(core: &Core, repo_id: String, job_id: String, name: String, remote: String, accepted_secrets: Option<Vec<String>>) -> CoreResult<PushResult> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = push_tag(core, &repo_id, &job, &name, &remote, accepted_secrets.as_deref()).await;
    job.finish(&result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::undo::undo_peek;
    use crate::events::names;
    use crate::model::Head;
    use crate::testkit::{TestCore, TestRepo};

    async fn setup() -> (TestCore, TestRepo, String) {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        (tc, repo, id)
    }

    fn tag<'a>(refs: &'a RefsSnapshot, name: &str) -> &'a crate::model::Ref {
        refs.tags.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("tag {name} missing"))
    }

    #[tokio::test]
    async fn lightweight_and_annotated_tags() {
        let (tc, repo, id) = setup().await;
        let first = repo.head();
        let second = repo.commit_file("a.txt", "a\n", "Zweiter");
        tc.events.clear();

        let refs = tag_create(&tc, id.clone(), "v1.0.0".into(), None, None).await.unwrap();
        assert_eq!(tag(&refs, "v1.0.0").sha, second);
        assert_eq!(tag(&refs, "v1.0.0").annotation, None);
        assert_eq!(repo.git(&["cat-file", "-t", "refs/tags/v1.0.0"]), "commit");
        let events = tc.events.named(names::REPO_CHANGED);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["what"], serde_json::json!(["refs"]));

        // On a specific commit (also with a short SHA), annotated and with a "#" line.
        let refs = tag_create(&tc, id.clone(), "release/alt".into(), Some(first[..8].to_string()), Some("Erste Fassung\n\n# kein Kommentar\n".into()))
            .await
            .unwrap();
        assert_eq!(tag(&refs, "release/alt").sha, first);
        assert_eq!(repo.git(&["cat-file", "-t", "refs/tags/release/alt"]), "tag");
        assert_eq!(repo.git(&["for-each-ref", "--format=%(contents)", "refs/tags/release/alt"]), "Erste Fassung\n\n# kein Kommentar");
        assert!(tag(&refs, "release/alt").annotation.as_deref().unwrap_or_default().contains("Erste Fassung"));

        // Umlauts in the name and in the description.
        let refs = tag_create(&tc, id.clone(), "größe/v2".into(), None, Some("Für später".into())).await.unwrap();
        assert_eq!(tag(&refs, "größe/v2").sha, second);
        assert_eq!(tag(&refs, "größe/v2").annotation.as_deref().map(str::trim), Some("Für später"));
        let refs = tag_delete(&tc, id.clone(), "größe/v2".into(), None).await.unwrap();
        assert_eq!(refs.tags.len(), 2);

        // By convention tags cannot be undone: no undo entry.
        assert!(undo_peek(&tc, id).await.unwrap().undo.is_none());
    }

    #[tokio::test]
    async fn create_rejects_bad_input() {
        let (tc, repo, id) = setup().await;
        tag_create(&tc, id.clone(), "v1".into(), None, None).await.unwrap();

        let err = tag_create(&tc, id.clone(), "v1".into(), None, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        assert!(err.message.contains("v1"));
        for bad in ["", "mit leerzeichen", "-x", "a..b", "ende.", "a~1", "x.lock"] {
            let err = tag_create(&tc, id.clone(), bad.into(), None, None).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidName, "{bad}");
        }
        // A tag "v1/x" collides with the existing "v1".
        assert_eq!(tag_create(&tc, id.clone(), "v1/x".into(), None, None).await.unwrap_err().code, ErrorCode::NameExists);

        let err = tag_create(&tc, id.clone(), "v2".into(), Some("0123456789abcdef0123456789abcdef01234567".into()), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = tag_create(&tc, id.clone(), "v2".into(), Some("--help".into()), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = tag_create(&tc, id.clone(), "v2".into(), None, Some("  \n".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::EmptyMessage);
        assert_eq!(repo.git(&["tag", "--list"]), "v1");

        assert_eq!(tag_create(&tc, "unbekannt".into(), "v9".into(), None, None).await.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn create_in_empty_repo_on_detached_head_and_without_identity() {
        let tc = TestCore::new().await;
        let unborn = TestRepo::new();
        let unborn_id = tc.open(&unborn).await.repo.id;
        let err = tag_create(&tc, unborn_id, "v1".into(), None, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);

        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.commit_file("a.txt", "a\n", "Zweiter");
        repo.git(&["checkout", "-q", "--detach", &first]);
        let id = tc.open(&repo).await.repo.id;
        let refs = tag_create(&tc, id, "am-detached".into(), None, None).await.unwrap();
        assert_eq!(tag(&refs, "am-detached").sha, first);
        assert!(matches!(refs.head, Head::Detached { .. }));

        // Annotated tags need an identity, lightweight ones do not.
        let anonymous = TestRepo::without_identity();
        anonymous.write_file("a.txt", "a\n");
        anonymous.git(&["add", "-A"]);
        anonymous.git(&["-c", "user.name=X", "-c", "user.email=x@example.com", "commit", "-q", "-m", "Start"]);
        let anon_id = tc.open(&anonymous).await.repo.id;
        let err = tag_create(&tc, anon_id.clone(), "annotiert".into(), None, Some("Text".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::IdentityMissing);
        let refs = tag_create(&tc, anon_id, "leicht".into(), None, None).await.unwrap();
        assert_eq!(refs.tags.len(), 1);
    }

    #[tokio::test]
    async fn delete_locally_and_on_the_remote() {
        let (tc, repo, id) = setup().await;
        let remote = repo.add_remote();
        tag_create(&tc, id.clone(), "v1".into(), None, None).await.unwrap();
        tag_create(&tc, id.clone(), "v2".into(), None, Some("Zwei".into())).await.unwrap();
        tag_create(&tc, id.clone(), "nur-lokal".into(), None, None).await.unwrap();
        repo.git(&["push", "-q", "origin", "v1", "v2"]);
        assert_eq!(remote.git(&["tag", "--list"]), "v1\nv2");
        tc.events.clear();

        // Local only: the remote keeps the tag.
        let refs = tag_delete(&tc, id.clone(), "v1".into(), None).await.unwrap();
        assert!(refs.tags.iter().all(|t| t.name != "v1"));
        assert_eq!(remote.git(&["tag", "--list"]), "v1\nv2");
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["refs"]));

        // Locally and on the remote.
        let refs = tag_delete(&tc, id.clone(), "v2".into(), Some("origin".into())).await.unwrap();
        assert!(refs.tags.iter().all(|t| t.name != "v2"));
        assert_eq!(remote.git(&["tag", "--list"]), "v1");

        // Already gone locally, still on the remote: gets deleted there.
        let refs = tag_delete(&tc, id.clone(), "v1".into(), Some("origin".into())).await.unwrap();
        assert_eq!(refs.tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["nur-lokal"]);
        assert_eq!(remote.git(&["tag", "--list"]), "");

        // Never existed on the remote: delete locally anyway, no error.
        let refs = tag_delete(&tc, id.clone(), "nur-lokal".into(), Some("origin".into())).await.unwrap();
        assert!(refs.tags.is_empty());

        assert_eq!(tag_delete(&tc, id.clone(), "gibt-es-nicht".into(), None).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(tag_delete(&tc, id.clone(), "-d".into(), None).await.unwrap_err().code, ErrorCode::InvalidName);
        tag_create(&tc, id.clone(), "v3".into(), None, None).await.unwrap();
        let err = tag_delete(&tc, id.clone(), "v3".into(), Some("upstream".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoRemote);
        assert_eq!(repo.git(&["tag", "--list"]), "v3", "without a remote nothing is deleted locally either");

        // Remote unreachable: error, the tag stays locally.
        let missing = repo.temp_dir().join("weg.git").to_string_lossy().replace('\\', "/");
        repo.git(&["remote", "add", "kaputt", &missing]);
        let err = tag_delete(&tc, id.clone(), "v3".into(), Some("kaputt".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoRemote);
        assert_eq!(repo.git(&["tag", "--list"]), "v3");
        assert!(undo_peek(&tc, id).await.unwrap().undo.is_none());
    }

    #[tokio::test]
    async fn push_reports_done_up_to_date_and_rejected() {
        let (tc, repo, id) = setup().await;
        let first = repo.head();
        let remote = repo.add_remote();
        let second = repo.commit_file("a.txt", "a\n", "Zweiter");
        repo.git(&["push", "-q", "origin", "main"]);
        tag_create(&tc, id.clone(), "v1".into(), None, Some("Version 1".into())).await.unwrap();
        tc.events.clear();

        let result = tag_push(&tc, id.clone(), "job-1".into(), "v1".into(), "origin".into()).await.unwrap();
        assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "v1".into(), created_upstream: false, forced: false });
        assert_eq!(remote.git(&["rev-parse", "refs/tags/v1^{commit}"]), second);
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["jobId"], "job-1");
        assert_eq!(done[0]["ok"], true);
        assert_eq!(tc.events.count(names::REPO_CHANGED), 0, "a tag push changes nothing locally");

        // The same jobId may be reused once the job has ended.
        let result = tag_push(&tc, id.clone(), "job-1".into(), "v1".into(), "origin".into()).await.unwrap();
        assert_eq!(result, PushResult::UpToDate);

        // The remote has a different tag under the same name.
        remote.git(&["tag", "v2", &first]);
        tag_create(&tc, id.clone(), "v2".into(), None, None).await.unwrap();
        let result = tag_push(&tc, id.clone(), "job-2".into(), "v2".into(), "origin".into()).await.unwrap();
        match result {
            PushResult::Rejected { reason } => assert!(reason.contains("v2") && reason.contains("origin"), "{reason}"),
            other => panic!("unexpected: {other:?}"),
        }
        assert_eq!(remote.git(&["rev-parse", "refs/tags/v2"]), first, "the tag on the remote stays as it was");
    }

    #[tokio::test]
    async fn push_errors_finish_the_job() {
        let (tc, repo, id) = setup().await;
        repo.add_remote();
        tag_create(&tc, id.clone(), "v1".into(), None, None).await.unwrap();
        tc.events.clear();

        let err = tag_push(&tc, id.clone(), "j1".into(), "fehlt".into(), "origin".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = tag_push(&tc, id.clone(), "j2".into(), "v1".into(), "upstream".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoRemote);
        let missing = repo.temp_dir().join("weg.git").to_string_lossy().replace('\\', "/");
        repo.git(&["remote", "add", "kaputt", &missing]);
        let err = tag_push(&tc, id.clone(), "j3".into(), "v1".into(), "kaputt".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoRemote);
        assert!(err.git_output.is_some());

        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 3);
        assert!(done.iter().all(|d| d["ok"] == false && d["cancelled"] == false));

        // A jobId that is still running is rejected.
        let running = tc.start_job("belegt", None).unwrap();
        let err = tag_push(&tc, id.clone(), "belegt".into(), "v1".into(), "origin".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Duplicate);
        // A job cancelled in advance ends as cancelled.
        tc.events.clear();
        running.finish::<()>(&Ok(()));
        let job = tc.start_job("abbruch", None).unwrap();
        job.token().cancel();
        let err = push_tag(&tc, &id, &job, "v1", "origin", None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Cancelled);
    }

    #[test]
    fn porcelain_lines() {
        let out = b"To /tmp/remote.git\n*\trefs/tags/v1:refs/tags/v1\t[new tag]\nDone\n";
        assert_eq!(parse_push_porcelain(out, "refs/tags/v1"), Some((b'*', "[new tag]".to_string())));
        let out = b"To x\r\n!\trefs/tags/v2:refs/tags/v2\t[rejected] (already exists)\r\nDone\r\n";
        assert_eq!(parse_push_porcelain(out, "refs/tags/v2"), Some((b'!', "[rejected] (already exists)".to_string())));
        assert_eq!(parse_push_porcelain(b"To x\n=\trefs/tags/v1:refs/tags/v1\t[up to date]\n", "refs/tags/v1").map(|r| r.0), Some(b'='));
        assert_eq!(parse_push_porcelain(b"To x\nDone\n", "refs/tags/v1"), None);
    }
}
