//! Events from the core (names in `crate::events::names`)

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "snake_case")]
pub enum RepoChange {
    Worktree,
    Index,
    Refs,
    Head,
    Stash,
    Config,
    Operation,
    /// LFS file locks (`lfs_locks`): after locking/unlocking and after a fetch.
    Locks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AppChange {
    Tabs,
    Repos,
    Settings,
    Profiles,
    /// Remembered credentials (`credentials_list`).
    Credentials,
    /// SSH keys (`ssh_key_list`).
    SshKeys,
    /// Accounts at hosts (`host_accounts`).
    HostAccounts,
    /// Custom commands: the user's own or the approval of a repository file (`custom_commands_list`).
    CustomCommands,
    /// AI status (`ai_status`): master switch, provider, model, key, given confirmations.
    Ai,
}

/// `repo:changed`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct RepoChangedEvent {
    pub repo_id: Id,
    pub what: Vec<RepoChange>,
}

/// `job:progress`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    pub job_id: String,
    pub repo_id: Option<Id>,
    pub phase: String,
    pub percent: Option<u32>,
    pub line: String,
}

/// `job:done`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct JobDoneEvent {
    pub job_id: String,
    pub repo_id: Option<Id>,
    pub ok: bool,
    pub cancelled: bool,
    pub message: Option<String>,
}

/// `hook:output`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HookOutputEvent {
    pub repo_id: Id,
    pub hook: String,
    pub output: String,
    pub exit_code: i32,
}

/// `terminal:data`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub terminal_id: Id,
    pub data: String,
}

/// `terminal:exit`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub terminal_id: Id,
    /// Exit code of the shell; `None` if it could not be determined.
    pub code: Option<i32>,
}

/// `app:changed`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AppChangedEvent {
    pub what: Vec<AppChange>,
}

/// `submodules:updated` – the follow-up job after checkout, pull, merge … (see
/// `commands::submodule::auto`). A failure is a warning; the main operation went through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct SubmodulesUpdatedEvent {
    pub repo_id: Id,
    pub ok: bool,
    /// Submodules whose recorded commit changed.
    pub paths: Vec<String>,
    /// Why it failed (redacted); `None` on success.
    pub message: Option<String>,
}

/// `blame:chunk` – progress of `file_blame_job`. The first chunk carries every line of the file
/// (`text`, no spans, `done: 0`); later ones carry the spans found since (`text: null`).
/// `done` counts the lines assigned so far, out of `total`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "events.ts"))]
#[serde(rename_all = "camelCase")]
pub struct BlameChunkEvent {
    pub job_id: String,
    pub repo_id: Id,
    pub total: u32,
    pub done: u32,
    pub text: Option<Vec<String>>,
    pub spans: Vec<BlameSpan>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn head_accessors() {
        let sha = "0123456789abcdef0123456789abcdef01234567".to_string();
        let on = Head::Branch { branch: "main".into(), sha: sha.clone() };
        let detached = Head::Detached { sha: sha.clone() };
        let unborn = Head::Unborn { branch: "main".into() };
        assert_eq!(
            (on.sha(), on.branch(), on.token(), on.label()),
            (Some(sha.as_str()), Some("main"), "refs/heads/main".into(), "main".into())
        );
        assert_eq!(
            (detached.sha(), detached.branch(), detached.token(), detached.label()),
            (Some(sha.as_str()), None, sha.clone(), "0123456".into())
        );
        assert_eq!(
            (unborn.sha(), unborn.branch(), unborn.token(), unborn.label()),
            (None, Some("main"), "refs/heads/main".into(), "main".into())
        );
    }

    fn person() -> Person {
        Person { name: "Ada".into(), email: "ada@example.com".into() }
    }

    fn change(status: FileStatus, area: FileArea) -> FileChange {
        FileChange {
            path: "a.txt".into(),
            old_path: None,
            status,
            area,
            is_binary: false,
            is_lfs: false,
            added: Some(1),
            removed: None,
            conflict: None,
        }
    }

    #[test]
    fn head_json() {
        let h = Head::Branch { branch: "main".into(), sha: "abc".into() };
        assert_eq!(serde_json::to_value(&h).unwrap(), json!({"kind":"branch","branch":"main","sha":"abc"}));
        let d = Head::Detached { sha: "abc".into() };
        assert_eq!(serde_json::to_value(&d).unwrap(), json!({"kind":"detached","sha":"abc"}));
        let u = Head::Unborn { branch: "main".into() };
        assert_eq!(serde_json::to_value(&u).unwrap(), json!({"kind":"unborn","branch":"main"}));
    }

    #[test]
    fn status_json() {
        let s = Status {
            head: Head::Branch { branch: "main".into(), sha: "abc".into() },
            upstream: Some(UpstreamState { name: "origin/main".into(), ahead: 1, behind: 0, gone: false, pushes_to_upstream: true }),
            unstaged: vec![change(FileStatus::Untracked, FileArea::Unstaged)],
            staged: vec![],
            conflicted: vec![FileChange {
                conflict: Some(ConflictKind::BothModified),
                ..change(FileStatus::Conflicted, FileArea::Unstaged)
            }],
            operation: Some(Operation {
                kind: OperationKind::CherryPick,
                source: Some("abc1234".into()),
                target: Some("main".into()),
                step: Some(1),
                total_steps: Some(3),
                message: None,
            }),
            resolved_conflicts: vec!["b.txt".into()],
            foreign_operation: None,
            left_behind: None,
            unpublished: None,

            identity_set: true,
            token: "t".into(),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v,
            json!({
                "head": {"kind":"branch","branch":"main","sha":"abc"},
                "upstream": {"name":"origin/main","ahead":1,"behind":0,"gone":false,"pushesToUpstream":true},
                "unstaged": [{"path":"a.txt","oldPath":null,"status":"untracked","area":"unstaged","isBinary":false,"isLfs":false,"added":1,"removed":null,"conflict":null}],
                "staged": [],
                "conflicted": [{"path":"a.txt","oldPath":null,"status":"conflicted","area":"unstaged","isBinary":false,"isLfs":false,"added":1,"removed":null,"conflict":"both_modified"}],
                "operation": {"kind":"cherry_pick","source":"abc1234","target":"main","step":1,"totalSteps":3,"message":null},
                "resolvedConflicts": ["b.txt"],
                "foreignOperation": null,
                "leftBehind": null,
                "unpublished": null,
                "identitySet": true,
                "token": "t"
            })
        );
        let back: Status = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn file_diff_json() {
        let text = FileDiff::Text(TextDiff {
            path: "a.txt".into(),
            old_path: None,
            status: FileStatus::Modified,
            hunks: vec![Hunk {
                index: 0,
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                section: "fn main()".into(),
                lines: vec![DiffLine { kind: DiffLineKind::Add, old_no: None, new_no: Some(1), text: "x".into(), no_newline: true }],
            }],
            old_text: None,
            new_text: Some("x".into()),
            encoding: "utf-8".into(),
            token: Some("tok".into()),
            range_token: None,
        });
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            json!({
                "kind":"text","path":"a.txt","oldPath":null,"status":"modified",
                "hunks":[{"index":0,"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"section":"fn main()",
                  "lines":[{"kind":"add","oldNo":null,"newNo":1,"text":"x","noNewline":true}]}],
                "oldText":null,"newText":"x","encoding":"utf-8","token":"tok"
            })
        );
        let big = FileDiff::TooLarge { path: "b".into(), old_path: Some("a".into()), status: FileStatus::Renamed, bytes: 5, lines: None };
        assert_eq!(
            serde_json::to_value(&big).unwrap(),
            json!({"kind":"too_large","path":"b","oldPath":"a","status":"renamed","bytes":5,"lines":null})
        );
        let img = FileDiff::Image {
            path: "p.png".into(),
            old_path: None,
            status: FileStatus::Added,
            old_data_url: None,
            new_data_url: Some("data:image/png;base64,AA==".into()),
            old_size: None,
            new_size: Some(2),
        };
        assert_eq!(
            serde_json::to_value(&img).unwrap(),
            json!({"kind":"image","path":"p.png","oldPath":null,"status":"added","oldDataUrl":null,"newDataUrl":"data:image/png;base64,AA==","oldSize":null,"newSize":2})
        );
        let back: FileDiff = serde_json::from_value(serde_json::to_value(&text).unwrap()).unwrap();
        assert_eq!(back, text);
    }

    #[test]
    fn op_result_json() {
        assert_eq!(serde_json::to_value(OpResult::UpToDate).unwrap(), json!({"status":"up_to_date"}));
        assert_eq!(
            serde_json::to_value(OpResult::Done { sha: Some("abc".into()), fast_forward: true, summary: "ok".into() }).unwrap(),
            json!({"status":"done","sha":"abc","fastForward":true,"summary":"ok"})
        );
        assert_eq!(
            serde_json::to_value(OpResult::Conflict { files: vec!["a".into()], operation: None, note: None }).unwrap(),
            json!({"status":"conflict","files":["a"],"operation":null,"note":null})
        );
    }

    #[test]
    fn push_result_json() {
        assert_eq!(
            serde_json::to_value(PushResult::Done {
                remote: "origin".into(),
                branch: "main".into(),
                created_upstream: true,
                forced: false
            })
            .unwrap(),
            json!({"status":"done","remote":"origin","branch":"main","createdUpstream":true,"forced":false})
        );
        assert_eq!(serde_json::to_value(PushResult::UpToDate).unwrap(), json!({"status":"up_to_date"}));
        assert_eq!(serde_json::to_value(PushResult::Rejected { reason: "x".into() }).unwrap(), json!({"status":"rejected","reason":"x"}));
    }

    #[test]
    fn lfs_lock_json() {
        let list = LfsLockList {
            locks: vec![LfsLock {
                id: "1".into(),
                path: "bilder/karte.psd".into(),
                owner: "Lena Berg".into(),
                locked_at: Some("2026-01-02T03:04:05Z".into()),
                ours: false,
            }],
            fetched_at: "2026-01-02T03:05:00.000Z".into(),
        };
        let outcome =
            LfsLockOutcome { locks: list, failed: vec![LfsLockFailure { path: "plan.psd".into(), reason: "already created lock".into() }] };
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            json!({
                "locks": {
                    "locks": [{"id":"1","path":"bilder/karte.psd","owner":"Lena Berg","lockedAt":"2026-01-02T03:04:05Z","ours":false}],
                    "fetchedAt": "2026-01-02T03:05:00.000Z"
                },
                "failed": [{"path":"plan.psd","reason":"already created lock"}]
            })
        );
        assert_eq!(serde_json::to_value(RepoChange::Locks).unwrap(), "locks");
    }

    #[test]
    fn push_many_json() {
        let extra: PushExtra = serde_json::from_value(json!({"local":"refs/tags/v1","remoteName":null,"force":false})).unwrap();
        assert_eq!(extra, PushExtra { local: "refs/tags/v1".into(), remote_name: None, force: false, expected: None });
        let multi = PushResult::Multi {
            remote: "origin".into(),
            atomic: true,
            refs: vec![PushRefResult {
                local: "refs/heads/main".into(),
                remote_ref: "refs/heads/main".into(),
                status: PushRefStatus::Rejected,
                forced: false,
                reason: Some("atomic push failed".into()),
            }],
        };
        assert_eq!(
            serde_json::to_value(&multi).unwrap(),
            json!({"status":"multi","remote":"origin","atomic":true,"refs":[{"local":"refs/heads/main","remoteRef":"refs/heads/main","status":"rejected","forced":false,"reason":"atomic push failed"}]})
        );
    }

    #[test]
    fn submodules_updated_json() {
        let event = SubmodulesUpdatedEvent { repo_id: "r".into(), ok: false, paths: vec!["libs/a".into()], message: Some("x".into()) };
        assert_eq!(serde_json::to_value(&event).unwrap(), json!({"repoId":"r","ok":false,"paths":["libs/a"],"message":"x"}));
        assert_eq!(serde_json::to_value(RepoSettings::default()).unwrap()["submodulesAutoUpdate"], true);
        assert!(crate::events::names::ALL.contains(&crate::events::names::SUBMODULES_UPDATED));
    }

    #[test]
    fn rebase_plan_json() {
        let ok = RebasePlan::Ok {
            branch: "feature".into(),
            base: "b".into(),
            rows: vec![RebasePlanRow {
                sha: "s".into(),
                summary: "sum".into(),
                description: "".into(),
                author: person(),
                authored_at: "2026-01-01T00:00:00.000Z".into(),
                action: RebaseAction::Reword,
                message: Some("neu".into()),
            }],
            rewrites_pushed: false,
            dependent_branches: vec!["teil".into()],
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({"status":"ok","branch":"feature","base":"b","rows":[{"sha":"s","summary":"sum","description":"","author":{"name":"Ada","email":"ada@example.com"},"authoredAt":"2026-01-01T00:00:00.000Z","action":"reword","message":"neu"}],"rewritesPushed":false,"dependentBranches":["teil"]})
        );
        let refused = RebasePlan::Refused {
            reason: RebaseRefusal::NoCommonAncestor,
            detail: Some(RebaseRefusalDetail::NotAncestor),
            message: "m".into(),
        };
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            json!({"status":"refused","reason":"no_common_ancestor","detail":"not_ancestor","message":"m"})
        );
        let running = RebasePlan::Refused { reason: RebaseRefusal::OperationInProgress, detail: None, message: "m".into() };
        assert_eq!(
            serde_json::to_value(&running).unwrap(),
            json!({"status":"refused","reason":"operation_in_progress","detail":null,"message":"m"})
        );
        let back: RebasePlan = serde_json::from_value(serde_json::to_value(&ok).unwrap()).unwrap();
        assert_eq!(back, ok);
    }

    #[test]
    fn conflict_preview_json() {
        let op: PreviewOp = serde_json::from_value(json!({"kind":"rebase","onto":"main"})).unwrap();
        assert_eq!(op, PreviewOp::Rebase { onto: "main".into(), upstream: None, branch: None, commits: None });
        let op: PreviewOp = serde_json::from_value(json!({"kind":"cherry_pick","commits":["a","b"]})).unwrap();
        assert_eq!(op, PreviewOp::CherryPick { commits: vec!["a".into(), "b".into()] });
        let op: PreviewOp = serde_json::from_value(json!({"kind":"patch","text":"diff"})).unwrap();
        assert_eq!(op, PreviewOp::Patch { text: "diff".into() });
        assert_eq!(serde_json::to_value(ConflictPreview::Clean).unwrap(), json!({"status":"clean"}));
        assert_eq!(
            serde_json::to_value(ConflictPreview::Conflicts { files: vec!["a.txt".into()], at_commit: Some("c".into()) }).unwrap(),
            json!({"status":"conflicts","files":["a.txt"],"atCommit":"c"})
        );
        assert_eq!(
            serde_json::to_value(ConflictPreview::Unknown { reason: "x".into() }).unwrap(),
            json!({"status":"unknown","reason":"x"})
        );
    }

    #[test]
    fn stash_selection_json() {
        let selection: StashSelection = serde_json::from_value(json!({
            "expectHead": "abc",
            "staged": [],
            "unstaged": [{"path": "a.txt", "hunks": [{"index": 0, "lines": [1, 2]}], "expect": "t"}]
        }))
        .unwrap();
        assert_eq!(selection.expect_head, "abc");
        assert!(selection.staged.is_empty());
        assert_eq!(selection.unstaged[0].hunks[0].lines, Some(vec![1, 2]));
    }

    #[test]
    fn diff_source_json() {
        let cases = [
            (DiffSource::Unstaged, json!({"kind":"unstaged"})),
            (DiffSource::Staged, json!({"kind":"staged"})),
            (DiffSource::Commit { sha: "a".into() }, json!({"kind":"commit","sha":"a"})),
            (DiffSource::Range { from: "a".into(), to: None }, json!({"kind":"range","from":"a","to":null})),
            (DiffSource::Stash { index: 2 }, json!({"kind":"stash","index":2})),
        ];
        for (src, expected) in cases {
            assert_eq!(serde_json::to_value(&src).unwrap(), expected);
            let back: DiffSource = serde_json::from_value(expected).unwrap();
            assert_eq!(back, src);
        }
    }

    #[test]
    fn graph_row_json() {
        let row = GraphRow {
            id: "wip".into(),
            kind: GraphRowKind::Wip,
            sha: None,
            lane: 0,
            color: 0,
            edges: vec![GraphEdge { top: None, bottom: Some(0), color: 0, dashed: true }],
            parents: vec!["p".into()],
            summary: "".into(),
            author_name: "".into(),
            author_email: "".into(),
            authored_at: None,
            refs: vec![RefLabelInfo { kind: RefKind::Local, name: "main".into(), full_name: "refs/heads/main".into(), is_head: true }],
            is_head: false,
            stash_index: None,
            wip_count: Some(3),
            collapsed_count: None,
            collapse_too_large: false,
            collapsible: false,
            sync: SyncMark::None,
        };
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            json!({"id":"wip","kind":"wip","sha":null,"lane":0,"color":0,
              "edges":[{"top":null,"bottom":0,"color":0,"dashed":true}],
              "parents":["p"],"summary":"","authorName":"","authorEmail":"","authoredAt":null,
              "refs":[{"kind":"local","name":"main","fullName":"refs/heads/main","isHead":true}],
              "isHead":false,"stashIndex":null,"wipCount":3,"collapsedCount":null,"collapseTooLarge":false,"collapsible":false,"sync":"none"})
        );
    }

    #[test]
    fn blame_chunk_json() {
        let span = BlameSpan {
            sha: "s".into(),
            start_line: 1,
            count: 1,
            author: Person { name: "A".into(), email: "a@x".into() },
            authored_at: "2026-01-01T00:00:00Z".into(),
            summary: "S".into(),
            uncommitted: false,
        };
        let event = BlameChunkEvent { job_id: "j".into(), repo_id: "r".into(), total: 2, done: 1, text: None, spans: vec![span] };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"jobId":"j","repoId":"r","total":2,"done":1,"text":null,"spans":[{"sha":"s","startLine":1,"count":1,
              "author":{"name":"A","email":"a@x"},"authoredAt":"2026-01-01T00:00:00Z","summary":"S","uncommitted":false}]})
        );
        assert!(crate::events::names::ALL.contains(&crate::events::names::BLAME_CHUNK));
    }

    #[test]
    fn settings_defaults_json() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["zoom"], 1.0);
        assert_eq!(v["dateFormat"], "relative");
        assert_eq!(v["autoFetchMinutes"], 1);
        assert_eq!(v["initialCommits"], 2000);
        assert_eq!(v["defaultBranchName"], "main");
        assert_eq!(v["defaultPullMode"], "ff");
        assert_eq!(v["lazyLoad"], true);
        assert_eq!(v["rememberTabs"], true);
        assert!(v["externalEditor"].is_null());
        assert_eq!(serde_json::to_value(TabKind::Management).unwrap(), "management");
        assert_eq!(serde_json::to_value(ExternalTarget::FileManager).unwrap(), "file_manager");
        assert_eq!(serde_json::to_value(ExternalTarget::DiffTool).unwrap(), "diff_tool");
        assert_eq!(serde_json::to_value(ExternalTarget::MergeTool).unwrap(), "merge_tool");
        assert_eq!(serde_json::to_value(CredentialKind::HostKey).unwrap(), "host_key");
    }
}
