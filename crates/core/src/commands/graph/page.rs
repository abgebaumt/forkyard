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
//!
//! Collapsed merges (`RepoViewState.collapsedMerges`, `collapseAllMerges`): for each visible merge
//! to be collapsed, `collapse_for` reads the commits it brought in (`rev-list M^2 --not M^1`, minus
//! everything a ref, starting point or stash keeps). The merge row draws no line to those parents,
//! and a commit is hidden as long as only hidden commits lead to it: it is in the frontier
//! `PageBuilder.hidden` and no open lane waits for it. The frontier travels in the cursor, so hiding
//! continues across pages; hidden commits do not count towards the page size.

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
use crate::model::{GraphPage, GraphRow, GraphRowKind, RefLabelInfo, RepoViewState, SyncMark};
use crate::util;

/// Largest page; a call never returns more (the rest comes via the cursor).
pub const MAX_PAGE_SIZE: u32 = 10_000;
/// Name under which the stashes appear in `hiddenRefs` and `soloRefs`.
pub const STASH_REF: &str = "refs/stash";
/// `id` of the WIP row.
pub const WIP_ID: &str = "wip";

const LOG_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s";
const LOG_FIELDS: usize = 6;
/// Version 2: the frontier of hidden commits (`f`).
const CURSOR_VERSION: u32 = 2;
/// More commits than this under one merge: it stays expanded (`collapseTooLarge`).
pub(super) const MAX_COLLAPSE: usize = 20_000;
/// Records per `git log` call once hidden commits left the page short: at least this many, doubling
/// up to `MAX_READ_CHUNK`.
const MIN_READ_CHUNK: usize = 1_000;
const MAX_READ_CHUNK: usize = 64_000;

#[derive(Debug, Serialize, Deserialize)]
struct Cursor {
    v: u32,
    /// Commits already delivered (without WIP and stash rows).
    o: u64,
    /// Fingerprint of the plan the first page was built with.
    h: String,
    s: LayoutState,
    /// Commits that only hidden commits lead to and that have not appeared yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    f: Vec<String>,
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
    /// Commits a starting point, a visible ref or a stash keeps visible, even under a collapsed merge.
    pub keep: HashSet<String>,
    /// Every merge is collapsed.
    pub collapse_all: bool,
    /// Merges to collapse.
    pub collapsed: HashSet<String>,
}

impl Plan {
    /// Whether the merge `sha` is to be collapsed.
    pub fn collapses(&self, sha: &str) -> bool {
        self.collapse_all || self.collapsed.contains(sha)
    }
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

    hash.field("|");
    hash.field(if view.collapse_all_merges { "all-collapsed" } else { "" });
    let mut collapsed: Vec<&String> = view.collapsed_merges.iter().collect();
    collapsed.sort_unstable();
    collapsed.dedup();
    for sha in &collapsed {
        hash.field(sha);
    }

    let keep: HashSet<String> = tips.iter().chain(labels.keys()).chain(by_base.keys()).cloned().collect();
    Plan {
        tips,
        labels,
        stashes: by_base,
        head_sha,
        solo,
        fingerprint: hash.finish(),
        keep,
        collapse_all: view.collapse_all_merges,
        collapsed: collapsed.into_iter().cloned().collect(),
    }
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
    /// Commits that only hidden commits (or a collapsed merge) lead to and that have not appeared yet.
    hidden: HashSet<String>,
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

    /// Only hidden commits lead here: no visible line waits for it, and no ref, starting point or
    /// stash keeps it.
    fn is_hidden(&self, sha: &str) -> bool {
        self.hidden.contains(sha) && !self.plan.keep.contains(sha) && !self.state.awaits(sha)
    }

    /// The parents of a visible merge that is to be collapsed; otherwise `None`.
    fn wants_collapse(&self, fields: &[Vec<u8>]) -> Option<Vec<String>> {
        let parents = split_shas(&fields[1]);
        if parents.len() < 2 {
            return None;
        }
        let sha = util::decode_lossy(&fields[0]);
        (self.plan.collapses(&sha) && !self.is_hidden(&sha)).then_some(parents)
    }

    /// One record from `git log` (fields as in `LOG_FORMAT`); before it the stashes hanging off it.
    /// `collapse`: what `collapse_for` found for a merge to be collapsed. Returns whether the commit
    /// got a row (hidden commits do not).
    fn commit(&mut self, fields: &[Vec<u8>], collapse: Option<Collapse>) -> bool {
        let sha = util::decode_lossy(&fields[0]);
        let parents = split_shas(&fields[1]);
        if self.is_hidden(&sha) {
            self.hidden.remove(&sha);
            self.hidden.extend(parents);
            return false;
        }
        self.hidden.remove(&sha);
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
        let mut lines = parents.clone();
        let mut collapsed_count = None;
        let mut collapse_too_large = false;
        match collapse {
            Some(Collapse::Hide { count, hidden_parents }) => {
                // A parent another visible commit already waits for stays connected.
                let dropped: Vec<String> = hidden_parents.into_iter().filter(|p| !self.state.awaits(p)).collect();
                lines.retain(|p| !dropped.contains(p));
                self.hidden.extend(dropped);
                collapsed_count = Some(count);
            }
            Some(Collapse::TooLarge) => collapse_too_large = true,
            None => {}
        }
        let placed = self.state.place(&sha, &lines, false);
        let mut row = empty_row(&sha, if parents.len() > 1 { GraphRowKind::Merge } else { GraphRowKind::Commit });
        row.sha = Some(sha.clone());
        row.parents = parents;
        row.author_name = display_text(&fields[2]);
        row.author_email = display_text(&fields[3]);
        row.authored_at = Some(util::unix_to_iso(parse_i64(&fields[4])));
        row.summary = display_text(&fields[5]);
        row.refs = self.plan.labels.get(&sha).cloned().unwrap_or_default();
        row.is_head = self.plan.head_sha.as_deref() == Some(sha.as_str());
        row.collapsed_count = collapsed_count;
        row.collapse_too_large = collapse_too_large;
        self.push(placed, row);
        self.commits += 1;
        true
    }
}

/// What collapsing a merge means for the graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Collapse {
    /// `count` commits disappear; no line is drawn to `hidden_parents`.
    Hide { count: u32, hidden_parents: Vec<String> },
    /// The merge brings in more than the limit: it stays expanded.
    TooLarge,
}

/// The commits a merge brought in: reachable from its further parents but not from the first
/// (`rev-list M^2 --not M^1`). Commits a ref, starting point or stash keeps visible – and everything
/// they reach – stay out. More than `max`: `TooLarge`.
pub(super) async fn collapse_for(core: &Core, path: &Path, repo_id: &str, plan: &Plan, parents: &[String], max: usize) -> CoreResult<Collapse> {
    let Some((first, side)) = parents.split_first() else {
        return Ok(Collapse::Hide { count: 0, hidden_parents: Vec::new() });
    };
    let all = side_commits(core, path, repo_id, first, side, &[], max).await?;
    if all.len() > max {
        return Ok(Collapse::TooLarge);
    }
    let kept: Vec<String> = all.iter().filter(|sha| plan.keep.contains(*sha)).cloned().collect();
    let hidden = if kept.is_empty() { all } else { side_commits(core, path, repo_id, first, side, &kept, max).await? };
    let set: HashSet<&str> = hidden.iter().map(String::as_str).collect();
    let hidden_parents = side.iter().filter(|p| set.contains(p.as_str())).cloned().collect();
    Ok(Collapse::Hide { count: u32::try_from(hidden.len()).unwrap_or(u32::MAX), hidden_parents })
}

/// `git rev-list <side…> --not <first> <kept…>`, at most `max + 1` commits.
async fn side_commits(core: &Core, path: &Path, repo_id: &str, first: &str, side: &[String], kept: &[String], max: usize) -> CoreResult<Vec<String>> {
    let mut stdin = String::with_capacity((side.len() + kept.len() + 1) * 42);
    for sha in side {
        stdin.push_str(sha);
        stdin.push('\n');
    }
    for sha in std::iter::once(first).chain(kept.iter().map(String::as_str)) {
        stdin.push('^');
        stdin.push_str(sha);
        stdin.push('\n');
    }
    let out = read_cmd(core, path, repo_id)
        .args(["rev-list", "--ignore-missing"])
        .arg(format!("--max-count={}", max + 1))
        .arg("--stdin")
        .stdin(stdin)
        .run()
        .await?;
    Ok(out.stdout_lines().into_iter().map(util::decode_lossy).filter(|sha| is_full_sha(sha)).collect())
}

#[cfg(test)]
thread_local! {
    /// Number of `read_records` calls on this thread (tests run on a current-thread runtime).
    pub(super) static LOG_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// `limit` records of `git log` after the first `skip`, over the starting points in `stdin`.
async fn read_records(core: &Core, path: &Path, repo_id: &str, stdin: &str, skip: u64, limit: usize) -> CoreResult<Vec<Vec<Vec<u8>>>> {
    #[cfg(test)]
    LOG_READS.with(|n| n.set(n.get() + 1));
    let mut records = Records::new(LOG_FIELDS);
    let mut out = Vec::with_capacity(limit);
    let mut on_field = |field: &[u8]| -> bool {
        if let Some(record) = records.push(field) {
            out.push(record);
        }
        true
    };
    read_cmd(core, path, repo_id)
        .args(["log", "--date-order"])
        .args(LOG_SAFE)
        .args(["--ignore-missing", "-z", LOG_FORMAT])
        .arg(format!("--skip={skip}"))
        .arg(format!("--max-count={limit}"))
        .arg("--stdin")
        .stdin(stdin.to_owned())
        .run_records(0, None, &mut on_field)
        .await?;
    Ok(out)
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
        collapsed_count: None,
        collapse_too_large: false,
        sync: SyncMark::None,
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

    let (offset, state, hidden) = match cursor {
        Some(c) if c.h == plan.fingerprint => (c.o, c.s, c.f.into_iter().collect()),
        Some(_) => return Err(CoreError::stale_state()),
        None => (0, LayoutState::new(), HashSet::new()),
    };
    let mut builder = PageBuilder { plan: &plan, state, rows: Vec::new(), max_lane: 0, commits: 0, hidden };

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
    // Commits read from `git log` so far, hidden ones included: the next page starts after them.
    let mut consumed = offset;
    if !plan.tips.is_empty() {
        let mut stdin = String::with_capacity(plan.tips.len() * 41);
        for tip in &plan.tips {
            stdin.push_str(tip);
            stdin.push('\n');
        }
        // Hidden commits do not count towards `limit`: read on until the page is full or the history
        // ends. One commit more than needed: if it comes, there is another page. Every call sorts the
        // whole history (`--date-order`), so after the first one the chunk grows: a long hidden run
        // costs a few calls, not one per missing row. Extra records are harmless – `consumed` only
        // counts the ones processed.
        let mut chunk = limit + 1;
        loop {
            let want = (limit - builder.commits + 1).max(chunk);
            chunk = (chunk.max(MIN_READ_CHUNK / 2) * 2).min(MAX_READ_CHUNK);
            let records = read_records(core, &path, repo_id, &stdin, consumed, want).await?;
            let got = records.len();
            for fields in records {
                if builder.commits >= limit {
                    has_more = true;
                    break;
                }
                consumed += 1;
                let collapse = match builder.wants_collapse(&fields) {
                    Some(parents) => Some(collapse_for(core, &path, repo_id, &plan, &parents, MAX_COLLAPSE).await?),
                    None => None,
                };
                builder.commit(&fields, collapse);
            }
            if has_more || got < want {
                break;
            }
        }
    }

    let PageBuilder { state, rows, max_lane, hidden, .. } = builder;
    let next_cursor = if has_more {
        let mut f: Vec<String> = hidden.into_iter().collect();
        f.sort_unstable();
        Some(Cursor { v: CURSOR_VERSION, o: consumed, h: plan.fingerprint.clone(), s: state, f }.encode()?)
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
        let text = Cursor { v: CURSOR_VERSION, o: 2000, h: "abc".into(), s: state.clone(), f: vec!["s1".into()] }.encode().unwrap();
        let back = Cursor::decode(&text).unwrap();
        assert_eq!((back.o, back.h.as_str(), &back.s, back.f.as_slice()), (2000, "abc", &state, ["s1".to_string()].as_slice()));
        let old = URL_SAFE_NO_PAD.encode(br#"{"v":1,"o":0,"h":"","s":{"l":[],"n":0}}"#);
        let future = URL_SAFE_NO_PAD.encode(br#"{"v":99,"o":0,"h":"","s":{"l":[],"n":0}}"#);
        for bad in ["", "%%%", "bm9wZQ", &future, &old] {
            assert_eq!(Cursor::decode(bad).unwrap_err().code, crate::error::ErrorCode::StaleState, "{bad}");
        }
    }

    #[test]
    fn fingerprint_follows_collapsed_merges() {
        let base = build_plan(refs(), head(), Vec::new(), &RepoViewState::default()).fingerprint;
        let one = RepoViewState { collapsed_merges: vec!["m0".into()], ..Default::default() };
        assert_ne!(base, build_plan(refs(), head(), Vec::new(), &one).fingerprint);
        let all = RepoViewState { collapse_all_merges: true, ..Default::default() };
        assert_ne!(base, build_plan(refs(), head(), Vec::new(), &all).fingerprint);
        // The order of the list does not matter.
        let a = RepoViewState { collapsed_merges: vec!["x".into(), "y".into()], ..Default::default() };
        let b = RepoViewState { collapsed_merges: vec!["y".into(), "x".into()], ..Default::default() };
        assert_eq!(build_plan(refs(), head(), Vec::new(), &a).fingerprint, build_plan(refs(), head(), Vec::new(), &b).fingerprint);
    }

    fn record(sha: &str, parents: &str) -> Vec<Vec<u8>> {
        vec![sha.as_bytes().to_vec(), parents.as_bytes().to_vec(), b"Test".to_vec(), b"t@example.com".to_vec(), b"0".to_vec(), sha.as_bytes().to_vec()]
    }

    fn builder(plan: &Plan) -> PageBuilder<'_> {
        PageBuilder { plan, state: LayoutState::new(), rows: Vec::new(), max_lane: 0, commits: 0, hidden: HashSet::new() }
    }

    fn row_ids<'a>(b: &'a PageBuilder<'_>) -> Vec<&'a str> {
        b.rows.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn a_collapsed_merge_hides_what_only_it_leads_to() {
        // m merges s2 (side branch s2 ── s1) into p1; s1 and p1 share the base b.
        let plan = build_plan(vec![tip("refs/heads/main", "m", true)], Some("m".into()), Vec::new(), &RepoViewState::default());
        let mut b = builder(&plan);
        assert!(b.commit(&record("m", "p1 s2"), Some(Collapse::Hide { count: 2, hidden_parents: vec!["s2".into()] })));
        assert!(!b.commit(&record("s2", "s1"), None));
        assert!(b.commit(&record("p1", "b"), None));
        assert!(!b.commit(&record("s1", "b"), None));
        assert!(b.commit(&record("b", ""), None));
        assert_eq!(row_ids(&b), vec!["m", "p1", "b"]);
        assert_eq!(b.rows[0].collapsed_count, Some(2));
        assert_eq!(b.rows[0].parents, vec!["p1".to_string(), "s2".to_string()], "the row still names both parents");
        assert_eq!(b.commits, 3);
        assert!(b.hidden.is_empty(), "nothing is left waiting: {:?}", b.hidden);
        crate::commands::graph::layout::check::check_rows(&b.rows, true).unwrap();
    }

    #[test]
    fn a_ref_keeps_a_hidden_commit_and_a_too_large_merge_keeps_its_lines() {
        let plan = build_plan(
            vec![tip("refs/heads/main", "m", true), tip("refs/heads/keep", "s1", false)],
            Some("m".into()),
            Vec::new(),
            &RepoViewState::default(),
        );
        let mut b = builder(&plan);
        b.commit(&record("m", "p1 s2"), Some(Collapse::Hide { count: 1, hidden_parents: vec!["s2".into()] }));
        assert!(!b.commit(&record("s2", "s1"), None));
        assert!(b.commit(&record("s1", "b"), None), "a branch points to s1");

        let mut b = builder(&plan);
        b.commit(&record("m", "p1 s2"), Some(Collapse::TooLarge));
        assert!(b.rows[0].collapse_too_large);
        assert_eq!(b.rows[0].collapsed_count, None);
        assert_eq!(b.state.lanes().iter().flatten().count(), 2, "both parents stay awaited");
        assert!(b.commit(&record("s2", "s1"), None));
    }

    #[test]
    fn a_parent_that_a_lane_already_waits_for_keeps_its_line() {
        // f (a branch that branches off the side branch) comes before m and already waits for s2.
        let plan = build_plan(
            vec![tip("refs/heads/f", "f", false), tip("refs/heads/main", "m", true)],
            Some("m".into()),
            Vec::new(),
            &RepoViewState::default(),
        );
        let mut b = builder(&plan);
        b.commit(&record("f", "s2"), None);
        b.commit(&record("m", "p1 s2"), Some(Collapse::Hide { count: 1, hidden_parents: vec!["s2".into()] }));
        assert!(b.commit(&record("s2", "b"), None));
        assert!(b.commit(&record("p1", "b"), None));
        assert!(b.commit(&record("b", ""), None));
        assert_eq!(row_ids(&b), vec!["f", "m", "s2", "p1", "b"]);
        crate::commands::graph::layout::check::check_rows(&b.rows, true).unwrap();
    }
}
