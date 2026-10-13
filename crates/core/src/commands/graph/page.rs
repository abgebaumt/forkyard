//! `graph_page`: commits page by page by date (newest first), with a finished lane layout.
//!
//! User requirement: the graph is ALWAYS sorted by date – hence `--date-order`
//! and not `--topo-order`. Children still come before their parents (the lane layout
//! needs that), otherwise the commit date decides; branches interleave.
//!
//! Every page is a `git log --date-order --skip=<n> -n <limit>` over the same
//! starting points; Git always returns the same order for that. The cursor carries the number
//! of commits already delivered, the open lanes and a fingerprint of refs,
//! HEAD, stashes and view. If any of these changed, the next page no longer
//! fits the loaded ones: `stale_state`, the UI reloads.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::layout::{LayoutState, Placed};
use super::{display_text, is_full_sha, parse_i64, read_cmd, read_ref_tips, read_stashes, split_shas, Records, RefTip, StashEntry, LOG_SAFE};
use crate::app::Core;
use crate::commands::status;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::{GraphPage, GraphRow, GraphRowKind, RefLabelInfo, RepoViewState};
use crate::util;

/// Largest page; a call never returns more (the rest comes via the cursor).
pub const MAX_PAGE_SIZE: u32 = 10_000;
/// Name under which the stashes appear in `hiddenRefs` and `soloRefs`.
pub const STASH_REF: &str = "refs/stash";
/// `id` of the WIP row.
pub const WIP_ID: &str = "wip";

const LOG_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s";
const LOG_FIELDS: usize = 6;
const CURSOR_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct Cursor {
    v: u32,
    /// Commits already delivered (without WIP and stash rows).
    o: u64,
    /// Fingerprint of the plan the first page was built with.
    h: String,
    s: LayoutState,
}

impl Cursor {
    fn encode(&self) -> CoreResult<String> {
        Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?))
    }

    /// For the UI an unreadable cursor is the same as a stale one: reload.
    fn decode(text: &str) -> CoreResult<Cursor> {
        let bytes = URL_SAFE_NO_PAD.decode(text.trim()).map_err(|_| CoreError::stale_state())?;
        let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| CoreError::stale_state())?;
        if cursor.v != CURSOR_VERSION {
            return Err(CoreError::stale_state());
        }
        Ok(cursor)
    }
}

/// What the graph shows: starting points, labels and stashes – after applying
/// `hiddenRefs` and `soloRefs`.
#[derive(Debug, Default)]
pub(crate) struct Plan {
    /// Commits `git log` starts from (without duplicates, fixed order).
    pub tips: Vec<String>,
    pub labels: HashMap<String, Vec<RefLabelInfo>>,
    /// Stashes per base commit, `stash@{0}` first.
    pub stashes: HashMap<String, Vec<StashEntry>>,
    pub head_sha: Option<String>,
    /// Solo mode: only the solo refs are starting points, HEAD need not be in the graph.
    pub solo: bool,
    pub fingerprint: String,
}

/// `head_sha`: the commit HEAD is on; `None` in a repository without a commit.
pub(crate) fn build_plan(refs: Vec<RefTip>, head_sha: Option<String>, stashes: Vec<StashEntry>, view: &RepoViewState) -> Plan {
    let hidden: HashSet<&str> = view.hidden_refs.iter().map(String::as_str).collect();
    let solo_names: HashSet<&str> = view.solo_refs.iter().map(String::as_str).collect();
    let stashes_visible = !hidden.contains(STASH_REF);
    let stashes: Vec<StashEntry> = if stashes_visible { stashes } else { Vec::new() };

    // Solo only applies if at least one of the refs still exists – otherwise the graph would stay
    // empty without the UI being able to offer the deleted ref for switching off.
    let solo = refs.iter().any(|r| solo_names.contains(r.label.full_name.as_str()))
        || (solo_names.contains(STASH_REF) && !stashes.is_empty());

    let mut tips: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |sha: &str| {
        if seen.insert(sha.to_string()) {
            tips.push(sha.to_string());
        }
    };
    if solo {
        for r in refs.iter().filter(|r| solo_names.contains(r.label.full_name.as_str())) {
            add(&r.sha);
        }
        if solo_names.contains(STASH_REF) {
            stashes.iter().filter_map(StashEntry::base).for_each(&mut add);
        }
    } else {
        if let Some(sha) = &head_sha {
            add(sha);
        }
        for r in refs.iter().filter(|r| !hidden.contains(r.label.full_name.as_str())) {
            add(&r.sha);
        }
        stashes.iter().filter_map(StashEntry::base).for_each(&mut add);
    }

    let mut hash = Fnv::new();
    hash.field(if solo { "solo" } else { "alle" });
    hash.field(head_sha.as_deref().unwrap_or("-"));
    for tip in &tips {
        hash.field(tip);
    }
    hash.field("|");

    let mut labels: HashMap<String, Vec<RefLabelInfo>> = HashMap::new();
    for r in refs {
        if hidden.contains(r.label.full_name.as_str()) {
            continue;
        }
        hash.field(&r.label.full_name);
        hash.field(&r.sha);
        hash.field(if r.label.is_head { "*" } else { "" });
        let list = labels.entry(r.sha).or_default();
        // The checked-out branch comes first.
        if r.label.is_head {
            list.insert(0, r.label);
        } else {
            list.push(r.label);
        }
    }
    hash.field("|");

    let mut by_base: HashMap<String, Vec<StashEntry>> = HashMap::new();
    for stash in stashes {
        let Some(base) = stash.base().map(str::to_string) else { continue };
        hash.field(&stash.sha);
        hash.field(&base);
        hash.field(&stash.message);
        by_base.entry(base).or_default().push(stash);
    }

    Plan { tips, labels, stashes: by_base, head_sha, solo, fingerprint: hash.finish() }
}

/// FNV-1a (64 bit) over fields with a separator; stable across restarts and versions.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn field(&mut self, text: &str) {
        for &b in text.as_bytes().iter().chain(&[0u8]) {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn finish(&self) -> String {
        format!("{:016x}", self.0)
    }
}

/// Builds the rows of a page from the `git log` stream.
struct PageBuilder<'a> {
    plan: &'a Plan,
    state: LayoutState,
    rows: Vec<GraphRow>,
    max_lane: u32,
    commits: usize,
}

impl PageBuilder<'_> {
    fn push(&mut self, placed: Placed, mut row: GraphRow) {
        let widest = placed.edges.iter().flat_map(|e| [e.top, e.bottom]).flatten().max().unwrap_or(0);
        self.max_lane = self.max_lane.max(widest).max(placed.lane);
        row.lane = placed.lane;
        row.color = placed.color;
        row.edges = placed.edges;
        self.rows.push(row);
    }

    /// WIP row; `head`: the HEAD commit if it occurs in the graph.
    fn wip(&mut self, count: u32, head: Option<&str>) {
        let parents: Vec<String> = head.map(str::to_string).into_iter().collect();
        let placed = self.state.place(WIP_ID, &parents, true);
        let mut row = empty_row(WIP_ID, GraphRowKind::Wip);
        row.parents = parents;
        row.wip_count = Some(count);
        self.push(placed, row);
    }

    /// One record from `git log` (fields as in `LOG_FORMAT`); before it the stashes hanging off it.
    fn commit(&mut self, fields: &[Vec<u8>]) {
        let sha = util::decode_lossy(&fields[0]);
        if let Some(stashes) = self.plan.stashes.get(&sha) {
            for stash in stashes {
                let placed = self.state.place_side(&stash.sha, &sha);
                let mut row = empty_row(&stash.sha, GraphRowKind::Stash);
                row.sha = Some(stash.sha.clone());
                row.parents = vec![sha.clone()];
                row.summary = stash.message.clone();
                row.author_name = stash.author_name.clone();
                row.author_email = stash.author_email.clone();
                row.authored_at = Some(util::unix_to_iso(stash.authored_at));
                row.stash_index = Some(stash.index);
                self.push(placed, row);
            }
        }
        let parents = split_shas(&fields[1]);
        let placed = self.state.place(&sha, &parents, false);
        let mut row = empty_row(&sha, if parents.len() > 1 { GraphRowKind::Merge } else { GraphRowKind::Commit });
        row.sha = Some(sha.clone());
        row.parents = parents;
        row.author_name = display_text(&fields[2]);
        row.author_email = display_text(&fields[3]);
        row.authored_at = Some(util::unix_to_iso(parse_i64(&fields[4])));
        row.summary = display_text(&fields[5]);
        row.refs = self.plan.labels.get(&sha).cloned().unwrap_or_default();
        row.is_head = self.plan.head_sha.as_deref() == Some(sha.as_str());
        self.push(placed, row);
        self.commits += 1;
    }
}

fn empty_row(id: &str, kind: GraphRowKind) -> GraphRow {
    GraphRow {
        id: id.to_string(),
        kind,
        sha: None,
        lane: 0,
        color: 0,
        edges: Vec::new(),
        parents: Vec::new(),
        summary: String::new(),
        author_name: String::new(),
        author_email: String::new(),
        authored_at: None,
        refs: Vec::new(),
        is_head: false,
        stash_index: None,
        wip_count: None,
    }
}

pub(super) async fn graph_page(core: &Core, repo_id: &str, cursor: Option<&str>, limit: u32) -> CoreResult<GraphPage> {
    let path = core.repo_path(repo_id)?;
    let view = core.db.with(|c| db::view_state::get(c, repo_id))?;
    let limit = limit.clamp(1, MAX_PAGE_SIZE) as usize;
    let cursor = cursor.map(Cursor::decode).transpose()?;
    let first_page = cursor.is_none();

    let (tips, head, stashes, wip_count) = tokio::join!(
        read_ref_tips(core, &path, repo_id, None),
        read_cmd(core, &path, repo_id).args(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).run_raw(),
        read_stashes(core, &path, repo_id),
        async {
            if first_page {
                changed_file_count(core, &path, repo_id).await
            } else {
                0
            }
        },
    );
    // If this fails there is no commit yet (or HEAD points nowhere): then nothing hangs off HEAD.
    let head_sha = Some(head?).filter(|out| out.success()).map(|out| out.stdout_text()).filter(|sha| is_full_sha(sha));
    let plan = build_plan(tips?, head_sha, stashes?, &view);

    let (offset, state) = match cursor {
        Some(c) if c.h == plan.fingerprint => (c.o, c.s),
        Some(_) => return Err(CoreError::stale_state()),
        None => (0, LayoutState::new()),
    };
    let mut builder = PageBuilder { plan: &plan, state, rows: Vec::new(), max_lane: 0, commits: 0 };

    if first_page && wip_count > 0 {
        let mut head = None;
        if let Some(sha) = &plan.head_sha {
            if head_in_graph(core, &path, repo_id, &plan, sha).await {
                head = Some(sha.as_str());
            }
        }
        builder.wip(wip_count, head);
    }

    let mut has_more = false;
    if !plan.tips.is_empty() {
        let mut stdin = String::with_capacity(plan.tips.len() * 41);
        for tip in &plan.tips {
            stdin.push_str(tip);
            stdin.push('\n');
        }
        let mut records = Records::new(LOG_FIELDS);
        // One commit more than requested: if it comes, there is another page.
        let mut on_field = |field: &[u8]| -> bool {
            if builder.commits >= limit {
                has_more = true;
            } else if let Some(fields) = records.push(field) {
                builder.commit(&fields);
            }
            true
        };
        read_cmd(core, &path, repo_id)
            .args(["log", "--date-order"])
            .args(LOG_SAFE)
            .args(["--ignore-missing", "-z", LOG_FORMAT])
            .arg(format!("--skip={offset}"))
            .arg(format!("--max-count={}", limit + 1))
            .arg("--stdin")
            .stdin(stdin)
            .run_records(0, None, &mut on_field)
            .await?;
    }

    let PageBuilder { state, rows, max_lane, commits, .. } = builder;
    let next_cursor = if has_more {
        Some(Cursor { v: CURSOR_VERSION, o: offset + commits as u64, h: plan.fingerprint.clone(), s: state }.encode()?)
    } else {
        None
    };
    Ok(GraphPage { rows, next_cursor, max_lane })
}

/// Number of changed files (staged, unstaged, untracked, conflicts; once per path).
/// If `git status` fails, the graph still shows the history – `status_get` reports the error.
async fn changed_file_count(core: &Core, path: &Path, repo_id: &str) -> u32 {
    let out = read_cmd(core, path, repo_id).args(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames"]).run_raw().await;
    match out {
        Ok(out) if out.success() => status::parse_porcelain_v2(&out.stdout).entries.len() as u32,
        _ => 0,
    }
}

/// Whether the HEAD commit appears in the graph. Without solo, HEAD itself is a starting point; in
/// solo mode it must be reachable from one of the solo refs.
async fn head_in_graph(core: &Core, path: &Path, repo_id: &str, plan: &Plan, head: &str) -> bool {
    if !plan.solo || plan.tips.iter().any(|t| t == head) {
        return true;
    }
    // Returns HEAD exactly when no starting point contains it.
    let mut stdin = format!("{head}\n");
    for tip in &plan.tips {
        stdin.push('^');
        stdin.push_str(tip);
        stdin.push('\n');
    }
    let out = read_cmd(core, path, repo_id).args(["rev-list", "--max-count=1", "--ignore-missing", "--stdin"]).stdin(stdin).run_raw().await;
    matches!(out, Ok(out) if out.success() && out.stdout_text().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RefKind;

    fn tip(full: &str, sha: &str, is_head: bool) -> RefTip {
        let (kind, name) = if let Some(n) = full.strip_prefix("refs/heads/") {
            (RefKind::Local, n)
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            (RefKind::Remote, n)
        } else {
            (RefKind::Tag, full.strip_prefix("refs/tags/").unwrap_or(full))
        };
        RefTip { label: RefLabelInfo { kind, name: name.into(), full_name: full.into(), is_head }, sha: sha.into() }
    }

    fn stash(index: u32, sha: &str, base: &str) -> StashEntry {
        StashEntry {
            index,
            sha: sha.into(),
            parents: vec![base.into(), format!("{sha}-index")],
            message: format!("WIP {index}"),
            author_name: String::new(),
            author_email: String::new(),
            authored_at: 0,
        }
    }

    fn refs() -> Vec<RefTip> {
        vec![
            tip("refs/heads/feature", "f1", false),
            tip("refs/heads/main", "m1", true),
            tip("refs/remotes/origin/main", "m0", false),
            tip("refs/tags/v1", "m0", false),
        ]
    }

    fn head() -> Option<String> {
        Some("m1".into())
    }

    #[test]
    fn plan_takes_head_all_refs_and_stash_bases() {
        let plan = build_plan(refs(), head(), vec![stash(0, "s0", "old")], &RepoViewState::default());
        assert_eq!(plan.tips, vec!["m1", "f1", "m0", "old"]);
        assert!(!plan.solo);
        assert_eq!(plan.labels["m0"].iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["origin/main", "v1"]);
        assert!(plan.labels["m1"][0].is_head);
        assert_eq!(plan.stashes["old"][0].sha, "s0");
        assert_eq!(plan.head_sha.as_deref(), Some("m1"));
    }

    #[test]
    fn hidden_refs_are_neither_start_points_nor_labels() {
        let view = RepoViewState { hidden_refs: vec!["refs/heads/feature".into(), "refs/tags/v1".into(), STASH_REF.into()], ..Default::default() };
        let plan = build_plan(refs(), head(), vec![stash(0, "s0", "old")], &view);
        assert_eq!(plan.tips, vec!["m1", "m0"]);
        assert!(!plan.labels.contains_key("f1"));
        assert_eq!(plan.labels["m0"].len(), 1);
        assert!(plan.stashes.is_empty());
    }

    #[test]
    fn solo_refs_are_the_only_start_points() {
        let view = RepoViewState { solo_refs: vec!["refs/heads/feature".into()], ..Default::default() };
        let plan = build_plan(refs(), head(), vec![stash(0, "s0", "old")], &view);
        assert!(plan.solo);
        assert_eq!(plan.tips, vec!["f1"]);
        // Labels of other refs stay in case their commits show up in the graph.
        assert!(plan.labels.contains_key("m1"));

        let view = RepoViewState { solo_refs: vec![STASH_REF.into()], ..Default::default() };
        let plan = build_plan(refs(), head(), vec![stash(0, "s0", "old")], &view);
        assert_eq!(plan.tips, vec!["old"]);

        // A solo ref that no longer exists does not turn the graph empty.
        let view = RepoViewState { solo_refs: vec!["refs/heads/geloescht".into()], ..Default::default() };
        let plan = build_plan(refs(), head(), Vec::new(), &view);
        assert!(!plan.solo);
        assert_eq!(plan.tips.len(), 3);
    }

    #[test]
    fn unborn_head_without_refs_has_no_start_points() {
        let plan = build_plan(Vec::new(), None, Vec::new(), &RepoViewState::default());
        assert!(plan.tips.is_empty());
        assert_eq!(plan.head_sha, None);
    }

    #[test]
    fn fingerprint_follows_everything_the_page_shows() {
        let base = build_plan(refs(), head(), vec![stash(0, "s0", "old")], &RepoViewState::default()).fingerprint;
        assert_eq!(base, build_plan(refs(), head(), vec![stash(0, "s0", "old")], &RepoViewState::default()).fingerprint);

        let mut moved = refs();
        moved[0].sha = "f2".into();
        assert_ne!(base, build_plan(moved, head(), vec![stash(0, "s0", "old")], &RepoViewState::default()).fingerprint);

        let mut renamed = refs();
        renamed[3] = tip("refs/tags/v2", "m0", false);
        assert_ne!(base, build_plan(renamed, head(), vec![stash(0, "s0", "old")], &RepoViewState::default()).fingerprint);

        assert_ne!(base, build_plan(refs(), head(), Vec::new(), &RepoViewState::default()).fingerprint);
        let elsewhere = Some("f1".to_string());
        assert_ne!(base, build_plan(refs(), elsewhere, vec![stash(0, "s0", "old")], &RepoViewState::default()).fingerprint);
        let view = RepoViewState { hidden_refs: vec!["refs/tags/v1".into()], ..Default::default() };
        assert_ne!(base, build_plan(refs(), head(), vec![stash(0, "s0", "old")], &view).fingerprint);
    }

    #[test]
    fn cursor_roundtrip_and_garbage() {
        let mut state = LayoutState::new();
        state.place("a", &["b".to_string()], false);
        let text = Cursor { v: CURSOR_VERSION, o: 2000, h: "abc".into(), s: state.clone() }.encode().unwrap();
        let back = Cursor::decode(&text).unwrap();
        assert_eq!((back.o, back.h.as_str(), &back.s), (2000, "abc", &state));
        for bad in ["", "%%%", "bm9wZQ", &URL_SAFE_NO_PAD.encode(br#"{"v":99,"o":0,"h":"","s":{"l":[],"n":0}}"#)] {
            assert_eq!(Cursor::decode(bad).unwrap_err().code, crate::error::ErrorCode::StaleState, "{bad}");
        }
    }
}
