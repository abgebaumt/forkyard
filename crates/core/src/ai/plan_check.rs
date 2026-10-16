//! Checking a plan before it runs (spec Paket 5): every step against the allow list
//! (`plan_commands::project`), its arguments against the repository – refs without a leading `-`,
//! paths through `normalize_rel_path`, names through Git's own rules (`ref_name_check`) – and, where
//! a step can stop on conflicts, a simulation with `git merge-tree` (`preview::simulate`).
//!
//! The steps run one after another, so the check follows a *virtual* state: a branch created in
//! step 1 exists for step 2, a deleted one is gone, and after a step that makes new commits the
//! next simulation says "depends on what step n does". Nothing in the repository changes.
//!
//! `expect` fingerprints everything the result depends on: HEAD and index (`read_token`), every
//! branch and tag tip, every revision a step resolved, the lease of force pushes and the steps.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ai::plan_commands::{self, Args, PlanAction};
use crate::app::Core;
use crate::commands::{branches, graph, history, preview, remotes, status, sync};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::CancelToken;
use crate::model::{ConflictPreview, Head, MergeMode, PlanCheck, PlanCommand, PlanPreview, PlanStep, PlanStepView, PreviewOp, PullMode, RefNameKind, ResetMode};
use crate::{undo, util};

pub const MAX_STEPS: usize = 10;
/// Reason of `ai_invalid_answer` for longer plans; the UI recognises "plan too long".
pub const PLAN_TOO_LONG: &str = "plan too long: at most 10 steps";

pub struct Checked {
    pub preview: PlanPreview,
    /// Per step what runs; `None` for an invalid step.
    pub actions: Vec<Option<PlanAction>>,
    /// Local refs the steps may move (`refs/heads/…`, `refs/tags/…`).
    pub touched: BTreeSet<String>,
    /// Revisions resolved against the repository and the leases, part of `expect`.
    pub seen: BTreeMap<String, String>,
}

/// Tip of a branch in the virtual state.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Tip {
    At(String),
    /// Moved by this step; known only when the plan runs.
    MovedBy(usize),
}

/// A revision argument: known now, or only when the plan runs.
enum Rev {
    Known(String),
    Later { rev: String, step: usize },
}

impl Rev {
    fn tip(&self) -> Tip {
        match self {
            Rev::Known(sha) => Tip::At(sha.clone()),
            Rev::Later { step, .. } => Tip::MovedBy(*step),
        }
    }

    /// What the command gets: the SHA, or the name as given.
    fn arg(&self) -> String {
        match self {
            Rev::Known(sha) => sha.clone(),
            Rev::Later { rev, .. } => rev.clone(),
        }
    }
}

fn later(step: usize, what: &str) -> String {
    format!("{what} depends on what step {} does.", step + 1)
}

struct Virtual {
    head_branch: Option<String>,
    /// `None`: no commit yet, or unknown since `changed_by`.
    head_sha: Option<String>,
    /// The latest step whose result decides HEAD's commit.
    changed_by: Option<usize>,
    branches: BTreeMap<String, Tip>,
    deleted: BTreeSet<String>,
    tags: BTreeSet<String>,
    remotes: Vec<String>,
    /// The latest step that fetches.
    fetched_by: Option<usize>,
}

struct Sim<'a> {
    core: &'a Core,
    repo_id: &'a str,
    cancel: &'a CancelToken,
    v: Virtual,
    /// Branches checked out in another worktree (an agent's, for example).
    elsewhere: BTreeSet<String>,
    seen: BTreeMap<String, String>,
    touched: BTreeSet<String>,
}

/// Errors that end the check instead of marking one step invalid.
fn stays_error(code: ErrorCode) -> bool {
    matches!(code, ErrorCode::Cancelled | ErrorCode::RepoUntrusted | ErrorCode::PathNotFound | ErrorCode::GitMissing | ErrorCode::GitTooOld | ErrorCode::Io)
}

fn remote_branch_name(name: &str) -> CoreResult<String> {
    let name = name.trim();
    let bad = name.is_empty()
        || name.starts_with('-')
        || name.contains("..")
        || name.ends_with('/')
        || name.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ':' | '\\' | '~' | '^' | '?' | '*' | '['));
    if bad {
        return Err(CoreError::new(ErrorCode::InvalidName, format!("“{}” is not a branch name.", undo::shorten(name, 40))));
    }
    Ok(name.to_string())
}

impl<'a> Sim<'a> {
    async fn new(core: &'a Core, repo_id: &'a str, cancel: &'a CancelToken, head: &Head) -> CoreResult<Sim<'a>> {
        let local = branches::local_branches(core, repo_id).await?;
        let elsewhere = local.iter().filter(|b| b.worktree.is_some() && !b.is_head).map(|b| b.name.clone()).collect();
        let branches = local.into_iter().map(|b| (b.name, Tip::At(b.sha))).collect();
        let tags_out = core.git_for(repo_id)?.args(["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"]).read_only().no_log().run().await?;
        let tags = tags_out.stdout_lines().into_iter().map(util::decode_lossy).filter(|tag| !tag.is_empty()).collect();
        let remotes = remotes::remote_names(core, repo_id).await?;
        let (head_branch, head_sha) = match head {
            Head::Branch { branch, sha } => (Some(branch.clone()), Some(sha.clone())),
            Head::Detached { sha } => (None, Some(sha.clone())),
            Head::Unborn { branch } => (Some(branch.clone()), None),
        };
        Ok(Sim {
            core,
            repo_id,
            cancel,
            v: Virtual { head_branch, head_sha, changed_by: None, branches, deleted: BTreeSet::new(), tags, remotes, fetched_by: None },
            elsewhere,
            seen: BTreeMap::new(),
            touched: BTreeSet::new(),
        })
    }

    fn existing_branch(&self, name: &str) -> CoreResult<String> {
        let name = name.trim();
        let name = name.strip_prefix("refs/heads/").unwrap_or(name).to_string();
        if !self.v.branches.contains_key(&name) {
            return Err(CoreError::not_found(format!("The branch “{}” doesn't exist at that point of the plan.", undo::shorten(&name, 60))));
        }
        Ok(name)
    }

    fn not_elsewhere(&self, name: &str) -> CoreResult<()> {
        if self.elsewhere.contains(name) {
            return Err(CoreError::not_allowed(format!("“{name}” is checked out in another worktree.")));
        }
        Ok(())
    }

    async fn new_name(&self, name: &str, kind: RefNameKind) -> CoreResult<String> {
        let name = name.trim().to_string();
        let taken = match kind {
            RefNameKind::Branch => self.v.branches.contains_key(&name),
            RefNameKind::Tag => self.v.tags.contains(&name),
        };
        if taken {
            return Err(CoreError::new(ErrorCode::NameExists, format!("“{}” exists already at that point of the plan.", undo::shorten(&name, 60))));
        }
        let check = branches::ref_name_check(self.core, self.repo_id.to_string(), name.clone(), kind).await?;
        if !check.valid {
            return Err(CoreError::new(ErrorCode::InvalidName, check.reason.unwrap_or_else(|| format!("“{}” is not a valid name.", undo::shorten(&name, 60)))));
        }
        Ok(name)
    }

    /// `origin/x` → `Some("x")` when that remote branch exists.
    async fn remote_branch(&self, target: &str) -> CoreResult<Option<String>> {
        for remote in &self.v.remotes {
            if let Some(rest) = target.strip_prefix(&format!("{remote}/")) {
                if !rest.is_empty() && undo::rev_parse(self.core, self.repo_id, &format!("refs/remotes/{target}")).await?.is_some() {
                    return Ok(Some(rest.to_string()));
                }
            }
        }
        Ok(None)
    }

    async fn rev(&mut self, rev: &str) -> CoreResult<Rev> {
        let rev = rev.trim();
        if rev.is_empty() || rev.starts_with('-') || rev.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(CoreError::not_found(format!("“{}” is not a commit.", undo::shorten(rev, 40))));
        }
        let local = rev.strip_prefix("refs/heads/").unwrap_or(rev);
        if self.v.deleted.contains(local) && !self.v.branches.contains_key(local) {
            return Err(CoreError::not_found(format!("The branch “{local}” is deleted by an earlier step.")));
        }
        if let Some(tip) = self.v.branches.get(local) {
            return Ok(match tip {
                Tip::At(sha) => Rev::Known(sha.clone()),
                Tip::MovedBy(step) => Rev::Later { rev: rev.to_string(), step: *step },
            });
        }
        let head_relative = rev == "HEAD" || rev == "@" || ["HEAD~", "HEAD^", "@~", "@^"].iter().any(|prefix| rev.starts_with(prefix));
        if head_relative {
            if let Some(step) = self.v.changed_by {
                return Ok(Rev::Later { rev: rev.to_string(), step });
            }
            let Some(head) = self.v.head_sha.clone() else {
                return Err(CoreError::not_found("The repository has no commit yet."));
            };
            let rest = rev.strip_prefix("HEAD").or_else(|| rev.strip_prefix('@')).unwrap_or("");
            return Ok(Rev::Known(graph::resolve_commit(self.core, self.repo_id, &format!("{head}{rest}")).await?));
        }
        let sha = graph::resolve_commit(self.core, self.repo_id, rev).await?;
        self.seen.insert(format!("rev:{rev}"), sha.clone());
        if let Some(step) = self.v.fetched_by {
            if rev.starts_with("refs/remotes/") || self.remote_branch(rev).await?.is_some() {
                return Ok(Rev::Later { rev: rev.to_string(), step });
            }
        }
        Ok(Rev::Known(sha))
    }

    /// A revision that must be known now (it runs as a SHA).
    async fn known(&mut self, rev: &str) -> CoreResult<String> {
        match self.rev(rev).await? {
            Rev::Known(sha) => Ok(sha),
            Rev::Later { rev, step } => Err(CoreError::not_allowed(format!("“{rev}” depends on what step {} does; name the commit instead.", step + 1))),
        }
    }

    fn head_rev(&self) -> CoreResult<Rev> {
        match (self.v.changed_by, &self.v.head_sha) {
            (Some(step), _) => Ok(Rev::Later { rev: "HEAD".into(), step }),
            (None, Some(sha)) => Ok(Rev::Known(sha.clone())),
            (None, None) => Err(CoreError::not_allowed("The repository has no commit yet.")),
        }
    }

    /// The start commit of a simulation, or why there is none.
    fn sim_head(&self) -> Result<String, PlanCheck> {
        match (self.v.changed_by, &self.v.head_sha) {
            (Some(step), _) => Err(PlanCheck::Unknown { reason: later(step, "The result") }),
            (None, Some(sha)) => Ok(sha.clone()),
            (None, None) => Err(PlanCheck::Unknown { reason: "The repository has no commit yet.".into() }),
        }
    }

    async fn conflicts(&self, head: &str, op: PreviewOp) -> CoreResult<PlanCheck> {
        Ok(match preview::simulate(self.core, self.repo_id, self.cancel, head, op).await? {
            ConflictPreview::Clean => PlanCheck::Clean,
            ConflictPreview::Conflicts { files, .. } => PlanCheck::Conflicts { files },
            ConflictPreview::Unknown { reason } => PlanCheck::Unknown { reason },
        })
    }

    fn enter(&mut self, branch: Option<String>, tip: Tip) {
        self.v.head_branch = branch;
        match tip {
            Tip::At(sha) => {
                self.v.head_sha = Some(sha);
                self.v.changed_by = None;
            }
            Tip::MovedBy(step) => {
                self.v.head_sha = None;
                self.v.changed_by = Some(step);
            }
        }
    }

    /// HEAD's branch gets new commits in `step`.
    fn moved(&mut self, step: usize) {
        if let Some(branch) = self.v.head_branch.clone() {
            self.v.branches.insert(branch.clone(), Tip::MovedBy(step));
            self.touch_branch(&branch);
        }
        self.v.head_sha = None;
        self.v.changed_by = Some(step);
    }

    fn touch_branch(&mut self, name: &str) {
        self.touched.insert(format!("refs/heads/{name}"));
    }

    fn remote(&self, name: &str) -> CoreResult<String> {
        let name = name.trim();
        if self.v.remotes.iter().any(|remote| remote == name) {
            Ok(name.to_string())
        } else {
            Err(CoreError::new(ErrorCode::NoRemote, format!("There is no remote “{}”.", undo::shorten(name, 40))))
        }
    }

    /// (remote, branch on the remote) of a local branch's upstream.
    async fn upstream_of(&self, branch: &str) -> CoreResult<(String, String)> {
        match sync::branch_upstream(self.core, self.repo_id, branch).await? {
            Some((remote, merge)) if remote != "." => Ok((remote, merge.strip_prefix("refs/heads/").unwrap_or(&merge).to_string())),
            _ => Err(CoreError::new(ErrorCode::NoUpstream, format!("“{branch}” has no upstream; name the remote."))),
        }
    }

    async fn step(&mut self, i: usize, command: PlanCommand, a: &Args<'_>) -> CoreResult<(PlanAction, PlanCheck)> {
        match command {
            PlanCommand::BranchCreate => {
                let name = self.new_name(&a.text("name"), RefNameKind::Branch).await?;
                let start = match a.opt("start") {
                    Some(rev) => self.rev(&rev).await?,
                    None => self.head_rev()?,
                };
                let checkout = a.flag("checkout");
                let tip = start.tip();
                self.v.branches.insert(name.clone(), tip.clone());
                self.v.deleted.remove(&name);
                self.touch_branch(&name);
                if checkout {
                    self.enter(Some(name.clone()), tip);
                }
                Ok((PlanAction::BranchCreate { name, start: start.arg(), checkout }, PlanCheck::NotNeeded))
            }
            PlanCommand::BranchCheckout => {
                let target = a.text("target").trim().to_string();
                let local = target.strip_prefix("refs/heads/").unwrap_or(&target).to_string();
                if let Some(tip) = self.v.branches.get(&local).cloned() {
                    self.not_elsewhere(&local)?;
                    self.enter(Some(local), tip);
                } else if let Some(name) = self.remote_branch(&target).await? {
                    self.not_elsewhere(&name)?;
                    let tip = self.rev(&target).await?.tip();
                    self.v.branches.insert(name.clone(), tip.clone());
                    self.touch_branch(&name);
                    self.enter(Some(name), tip);
                } else {
                    let tip = self.rev(&target).await?.tip();
                    self.enter(None, tip);
                }
                Ok((PlanAction::BranchCheckout { target }, PlanCheck::NotNeeded))
            }
            PlanCommand::BranchRename => {
                let name = self.existing_branch(&a.text("name"))?;
                self.not_elsewhere(&name)?;
                let new_name = self.new_name(&a.text("newName"), RefNameKind::Branch).await?;
                let tip = self.v.branches.remove(&name).unwrap_or(Tip::MovedBy(i));
                self.v.branches.insert(new_name.clone(), tip);
                self.v.deleted.insert(name.clone());
                if self.v.head_branch.as_deref() == Some(name.as_str()) {
                    self.v.head_branch = Some(new_name.clone());
                }
                self.touch_branch(&name);
                self.touch_branch(&new_name);
                Ok((PlanAction::BranchRename { name, new_name }, PlanCheck::NotNeeded))
            }
            PlanCommand::BranchDelete => {
                let name = self.existing_branch(&a.text("name"))?;
                self.not_elsewhere(&name)?;
                if self.v.head_branch.as_deref() == Some(name.as_str()) {
                    return Err(CoreError::not_allowed(format!("“{name}” is checked out at that point of the plan; check out another branch first.")));
                }
                self.v.branches.remove(&name);
                self.v.deleted.insert(name.clone());
                self.touch_branch(&name);
                Ok((PlanAction::BranchDelete { name, force: a.flag("force") }, PlanCheck::NotNeeded))
            }
            PlanCommand::ResetBranch => {
                let mode: ResetMode = a.choice("resetMode")?;
                self.head_rev()?;
                let sha = self.known(&a.text("target")).await?;
                if let Some(branch) = self.v.head_branch.clone() {
                    self.v.branches.insert(branch.clone(), Tip::At(sha.clone()));
                    self.touch_branch(&branch);
                }
                self.enter(self.v.head_branch.clone(), Tip::At(sha.clone()));
                Ok((PlanAction::ResetBranch { sha, mode }, PlanCheck::NotNeeded))
            }
            PlanCommand::RebaseStart => {
                let onto_text = a.text("onto").trim().to_string();
                let onto = self.rev(&onto_text).await?;
                let given = match a.opt("branch") {
                    Some(name) => {
                        let name = self.existing_branch(&name)?;
                        self.not_elsewhere(&name)?;
                        Some(name)
                    }
                    None => None,
                };
                let branch = given
                    .clone()
                    .or_else(|| self.v.head_branch.clone())
                    .ok_or_else(|| CoreError::not_allowed("HEAD is detached at that point of the plan; name the branch to rebase."))?;
                let tip = self
                    .v
                    .branches
                    .get(&branch)
                    .cloned()
                    .ok_or_else(|| CoreError::not_found(format!("The branch “{branch}” doesn't exist at that point of the plan.")))?;
                let check = match (&onto, &tip) {
                    (Rev::Known(onto_sha), Tip::At(tip_sha)) => {
                        self.conflicts(tip_sha, PreviewOp::Rebase { onto: onto_sha.clone(), upstream: None, branch: None, commits: None }).await?
                    }
                    (Rev::Later { step, .. }, _) | (_, Tip::MovedBy(step)) => PlanCheck::Unknown { reason: later(*step, "The result") },
                };
                self.v.branches.insert(branch.clone(), Tip::MovedBy(i));
                self.touch_branch(&branch);
                // `git rebase <onto> <branch>` checks the branch out.
                self.enter(Some(branch), Tip::MovedBy(i));
                Ok((PlanAction::RebaseStart { onto: onto_text, branch: given }, check))
            }
            PlanCommand::CherryPick => {
                let list = a.list("commits");
                if list.is_empty() {
                    return Err(CoreError::not_allowed("Name at least one commit to cherry-pick."));
                }
                let mut shas = Vec::with_capacity(list.len());
                for rev in &list {
                    shas.push(self.known(rev).await?);
                }
                self.head_rev()?;
                let check = match self.sim_head() {
                    Ok(head) => self.conflicts(&head, PreviewOp::CherryPick { commits: shas.clone() }).await?,
                    Err(check) => check,
                };
                self.moved(i);
                Ok((PlanAction::CherryPick { shas }, check))
            }
            PlanCommand::RevertCommit => {
                let sha = self.known(&a.text("commit")).await?;
                self.head_rev()?;
                let check = match self.sim_head() {
                    Ok(head) => self.conflicts(&head, PreviewOp::Revert { commits: vec![sha.clone()] }).await?,
                    Err(check) => check,
                };
                self.moved(i);
                Ok((PlanAction::RevertCommit { sha }, check))
            }
            PlanCommand::MergeStart => {
                let mode: MergeMode = a.choice("mergeMode")?;
                let source = a.text("source").trim().to_string();
                let rev = self.rev(&source).await?;
                self.head_rev()?;
                let check = match (self.sim_head(), &rev) {
                    (Err(check), _) => check,
                    (Ok(_), Rev::Later { step, .. }) => PlanCheck::Unknown { reason: later(*step, &format!("“{source}”")) },
                    (Ok(head), Rev::Known(sha)) => self.conflicts(&head, PreviewOp::Merge { theirs: sha.clone() }).await?,
                };
                self.moved(i);
                Ok((PlanAction::MergeStart { source, mode }, check))
            }
            PlanCommand::StashCreate => {
                let mut paths = Vec::new();
                for path in a.list("paths") {
                    paths.push(history::normalize_rel_path(&path)?);
                }
                Ok((PlanAction::StashCreate { message: a.opt("message"), include_untracked: a.flag("includeUntracked"), paths }, PlanCheck::NotNeeded))
            }
            PlanCommand::TagCreate => {
                let name = self.new_name(&a.text("name"), RefNameKind::Tag).await?;
                let sha = match a.opt("commit") {
                    Some(rev) => Some(self.known(&rev).await?),
                    None => {
                        self.head_rev()?;
                        None
                    }
                };
                self.v.tags.insert(name.clone());
                self.touched.insert(format!("refs/tags/{name}"));
                Ok((PlanAction::TagCreate { name, sha, message: a.opt("message") }, PlanCheck::NotNeeded))
            }
            PlanCommand::CommitReword => {
                let sha = match a.opt("commit") {
                    Some(rev) => Some(self.known(&rev).await?),
                    None => None,
                };
                self.head_rev()?;
                let summary = a.text("summary").trim().to_string();
                if summary.is_empty() {
                    return Err(CoreError::new(ErrorCode::EmptyMessage, "The new commit message is empty."));
                }
                self.moved(i);
                Ok((PlanAction::CommitReword { sha, summary, description: a.text("description") }, PlanCheck::NotNeeded))
            }
            PlanCommand::Fetch => {
                let remote = match a.opt("remote") {
                    Some(name) => Some(self.remote(&name)?),
                    None if self.v.remotes.is_empty() => return Err(CoreError::new(ErrorCode::NoRemote, "The repository has no remote.")),
                    None => None,
                };
                self.v.fetched_by = Some(i);
                Ok((PlanAction::Fetch { remote, prune: a.flag("prune") }, PlanCheck::NotNeeded))
            }
            PlanCommand::Pull => {
                let mode: Option<PullMode> = a.choice("pullMode")?;
                let branch = self
                    .v
                    .head_branch
                    .clone()
                    .ok_or_else(|| CoreError::not_allowed("HEAD is detached at that point of the plan; there is no branch to pull into."))?;
                self.upstream_of(&branch).await?;
                self.v.fetched_by = Some(i);
                self.moved(i);
                Ok((PlanAction::Pull { mode }, PlanCheck::Unknown { reason: "The result depends on what the pull fetches.".into() }))
            }
            PlanCommand::Push => {
                let branch = match a.opt("branch") {
                    Some(name) => self.existing_branch(&name)?,
                    None => self
                        .v
                        .head_branch
                        .clone()
                        .filter(|name| self.v.branches.contains_key(name))
                        .ok_or_else(|| CoreError::not_allowed("No branch is checked out at that point of the plan; name the branch to push."))?,
                };
                let given = a.opt("remote");
                let (remote, remote_branch) = match &given {
                    Some(name) => (self.remote(name)?, branch.clone()),
                    None => self.upstream_of(&branch).await?,
                };
                let force = a.flag("force");
                let expected = if force {
                    // Force only with lease: the state of the remote branch the user sees now.
                    let tracking = format!("refs/remotes/{remote}/{remote_branch}");
                    let sha = undo::rev_parse(self.core, self.repo_id, &tracking).await?;
                    self.seen.insert(format!("lease:{tracking}"), sha.clone().unwrap_or_default());
                    sha
                } else {
                    None
                };
                Ok((PlanAction::Push { branch, remote: given.map(|_| remote), force, expected }, PlanCheck::NotNeeded))
            }
            PlanCommand::BranchDeleteRemote => {
                let remote = self.remote(&a.text("remote"))?;
                let name = remote_branch_name(&a.text("name"))?;
                Ok((PlanAction::BranchDeleteRemote { remote, name }, PlanCheck::NotNeeded))
            }
            PlanCommand::TagPush => {
                let name = a.text("name").trim().to_string();
                if !self.v.tags.contains(&name) {
                    return Err(CoreError::not_found(format!("The tag “{}” doesn't exist at that point of the plan.", undo::shorten(&name, 40))));
                }
                let remote = self.remote(&a.text("remote"))?;
                Ok((PlanAction::TagPush { name, remote }, PlanCheck::NotNeeded))
            }
        }
    }
}

/// Checks `steps` against the allow list and the repository; changes nothing.
pub async fn check(core: &Core, repo_id: &str, steps: &[PlanStep], cancel: &CancelToken) -> CoreResult<Checked> {
    if !core.repo_row(repo_id)?.trusted {
        return Err(CoreError::repo_untrusted());
    }
    if steps.len() > MAX_STEPS {
        return Err(CoreError::ai_invalid_answer(PLAN_TOO_LONG));
    }
    let current = status::read_status(core, repo_id).await?;
    let blocked = current.operation.is_some() || current.foreign_operation.is_some() || !current.conflicted.is_empty();
    let mut sim = Sim::new(core, repo_id, cancel, &current.head).await?;
    let mut views = Vec::with_capacity(steps.len());
    let mut actions = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        cancel.check()?;
        let (action, check) = match plan_commands::project(step.command, &step.args) {
            Err(reason) => (None, PlanCheck::Invalid { reason }),
            Ok(args) => match sim.step(index, step.command, &Args::new(&args)).await {
                Ok((action, check)) => (Some(action), check),
                Err(e) if stays_error(e.code) => return Err(e),
                Err(e) => (None, PlanCheck::Invalid { reason: e.message }),
            },
        };
        views.push(PlanStepView {
            command: step.command,
            args: step.args.clone(),
            why: step.why.clone(),
            class: step.command.class(),
            destructive: plan_commands::destructive(step.command, &step.args),
            fields: plan_commands::fields_view(step.command),
            check,
        });
        actions.push(action);
    }
    let Sim { seen, touched, .. } = sim;
    let expect = expect_token(core, repo_id, steps, &seen).await?;
    let runnable = !blocked && !views.is_empty() && views.iter().all(|view| !matches!(view.check, PlanCheck::Invalid { .. } | PlanCheck::Conflicts { .. }));
    Ok(Checked { preview: PlanPreview { steps: views, note: None, blocked, expect, runnable }, actions, touched, seen })
}

/// SHA-256 over HEAD + index, every branch and tag tip, the resolved revisions and leases, and the steps.
pub async fn expect_token(core: &Core, repo_id: &str, steps: &[PlanStep], seen: &BTreeMap<String, String>) -> CoreResult<String> {
    let mut hash = Sha256::new();
    hash.update(status::read_token(core, repo_id).await?.as_bytes());
    let tips = core.git_for(repo_id)?.args(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"]).read_only().no_log().run().await?;
    hash.update(&tips.stdout);
    for (name, sha) in seen {
        hash.update(b"\0");
        hash.update(name.as_bytes());
        hash.update(b"=");
        hash.update(sha.as_bytes());
    }
    hash.update(b"\0steps\0");
    hash.update(canonical(steps).as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}

/// The steps as JSON with sorted argument names (independent of the map's order).
pub fn canonical(steps: &[PlanStep]) -> String {
    let rows: Vec<Value> = steps
        .iter()
        .map(|step| {
            let mut names: Vec<&String> = step.args.keys().collect();
            names.sort();
            let args: Vec<Value> = names.into_iter().map(|name| json!([name, step.args[name]])).collect();
            json!([step.command.as_str(), args, step.why])
        })
        .collect();
    Value::Array(rows).to_string()
}
