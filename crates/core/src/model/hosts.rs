//! Hosts (GitHub, GitLab): accounts, pull requests, issues

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum HostKind {
    Github,
    Gitlab,
    /// Gitea and Forgejo (including Codeberg).
    Gitea,
    /// Bitbucket Cloud.
    Bitbucket,
    /// Azure DevOps Services.
    AzureDevops,
}

impl HostKind {
    /// Every host the app knows, in the order it lists them.
    pub const ALL: &'static [HostKind] = &[HostKind::Github, HostKind::Gitlab, HostKind::Gitea, HostKind::Bitbucket, HostKind::AzureDevops];

    /// Name in the contract and in `hoster_accounts.kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            HostKind::Github => "github",
            HostKind::Gitlab => "gitlab",
            HostKind::Gitea => "gitea",
            HostKind::Bitbucket => "bitbucket",
            HostKind::AzureDevops => "azure_devops",
        }
    }

    /// The opposite of `as_str`; `None` for a name the app does not know.
    pub fn parse(name: &str) -> Option<HostKind> {
        HostKind::ALL.iter().copied().find(|kind| kind.as_str() == name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// A connected account. The token itself never leaves the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HosterAccount {
    pub id: Id,
    pub kind: HostKind,
    /// Address of the web UI, e.g. `https://github.com`.
    pub base_url: String,
    /// User name for Basic authentication (Bitbucket); `None` for hosts that only need the token.
    pub username: Option<String>,
    /// `None` as long as the account was never checked successfully.
    pub user: Option<HostUser>,
    /// `…` and the last four characters of the token.
    pub token_hint: Option<String>,
    /// Whether the token has the required permissions (as far as the host reveals it).
    pub scopes_ok: bool,
    pub missing_scopes: Vec<String>,
    /// Last error of this account (e.g. token expired); `None` after a success.
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostRepoRef {
    pub owner: String,
    pub name: String,
    pub web_url: String,
}

/// Why the details from the host are missing (the repository is still recognized).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostInfoError {
    pub code: crate::error::ErrorCode,
    pub message: String,
}

/// What a host offers. The UI only shows what is there; the core refuses the rest with
/// `host_unsupported` before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    /// The host has an issue tracker (Azure DevOps: work items) – for this repository, as far as known.
    pub issues: bool,
    /// Issues can be created from the app.
    pub issue_create: bool,
    /// Pull requests can be created as drafts.
    pub draft_prs: bool,
    /// An existing pull request can switch between draft and ready.
    pub draft_toggle: bool,
    /// Merge methods the API accepts, in display order.
    pub merge_methods: Vec<PrMergeMethod>,
    /// The source branch can be deleted when merging.
    pub delete_source_branch: bool,
    /// A closed pull request can be reopened.
    pub pr_reopen: bool,
    /// Reviewers can be requested by user name.
    pub pr_reviewers: bool,
    /// Pull requests carry labels.
    pub pr_labels: bool,
    /// Pull requests from forks can be checked out (the host offers a ref for them).
    pub fork_checkout: bool,
    /// Review threads (comments on lines with their answers and resolved state) can be read.
    pub review_threads: bool,
    /// Answers can be posted to a review thread.
    pub review_reply: bool,
    /// The API has no answers inside a thread: an answer goes out as a new review comment on the same
    /// line that quotes the thread.
    pub review_reply_quotes: bool,
    /// Releases can be created for a tag (GitHub, GitLab, Gitea/Forgejo).
    pub releases: bool,
}

/// A release at the host, as `release_create` returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostRelease {
    pub tag: String,
    pub name: String,
    /// The release's page; `None` if the host does not name one.
    pub web_url: Option<String>,
}

/// The repository at the host, recognized by the URL of a remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostRepoInfo {
    /// Name of the remote by which it was recognized.
    pub remote: String,
    pub kind: HostKind,
    /// The connected account for this host; `None` = none (then the details below are missing).
    pub account: Option<HosterAccount>,
    /// On GitLab with groups: `group/subgroup`.
    pub owner: String,
    pub name: String,
    pub web_url: String,
    pub default_branch: Option<String>,
    pub can_push: Option<bool>,
    pub fork_parent: Option<HostRepoRef>,
    /// What this host offers for the repository (`issues` reflects a tracker switched off in the repository).
    pub capabilities: HostCapabilities,
    /// Set when there is an account but the host did not answer or refused.
    pub error: Option<HostInfoError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum PrListState {
    Open,
    Closed,
    Merged,
    All,
}

/// Summarized state of the checks (CI) of a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ChecksState {
    Passing,
    Failing,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum PrReviewState {
    Approved,
    ChangesRequested,
    /// Reviewers are requested but have not decided yet.
    ReviewRequired,
    Commented,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostLabel {
    pub name: String,
    /// `#rrggbb` if the host names a colour.
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub state: PrState,
    pub is_draft: bool,
    pub author: Option<HostUser>,
    pub source_branch: String,
    pub target_branch: String,
    pub updated_at: IsoTime,
    pub web_url: String,
    pub checks: Option<ChecksState>,
    pub review_state: Option<PrReviewState>,
    pub labels: Vec<HostLabel>,
    /// The source branch lives in a fork.
    pub is_fork: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PrPage {
    pub items: Vec<PrSummary>,
    /// Number of the next page; `None` = end.
    pub next_page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PrReviewer {
    pub user: HostUser,
    /// `None` = requested, no decision yet.
    pub state: Option<PrReviewState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct HostComment {
    pub id: String,
    pub author: Option<HostUser>,
    /// Markdown.
    pub body: String,
    pub created_at: IsoTime,
    /// For comments on a line of the diff.
    pub path: Option<String>,
    pub line: Option<u32>,
}

/// Which version of the file a review comment refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ReviewSide {
    /// The pull request's version (added or unchanged lines).
    New,
    /// The target's version (removed lines).
    Old,
}

/// A review thread: comments on lines of the diff with their answers (8.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    /// What `pr_review_reply` takes: GitHub, Gitea/Forgejo – ID of the first comment; GitLab – the
    /// discussion ID; Bitbucket – ID of the top comment; Azure DevOps – the thread ID.
    pub id: String,
    pub path: String,
    /// Last commented line on `side`; `None` = the lines are no longer in the pull request.
    pub line: Option<u32>,
    /// First line of a range of several lines; `None` = one line.
    pub start_line: Option<u32>,
    pub side: ReviewSide,
    /// Commit the comment was written on, as far as the host says.
    pub commit: Option<Sha>,
    pub resolved: bool,
    /// The host marks the thread as outdated (the code changed since).
    pub outdated: bool,
    /// Oldest first.
    pub comments: Vec<HostComment>,
}

/// What `pr_review_reply` posted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReviewReply {
    pub comment: HostComment,
    /// Posted as a new review comment on the same line that quotes the thread (no answers inside
    /// threads in the host's API).
    pub quoted: bool,
}

/// What a line of a suggested fix is in its diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ReviewFixLineKind {
    Context,
    Removed,
    Added,
}

/// One line of the hunk of a suggested fix, decoded for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReviewFixLine {
    pub kind: ReviewFixLineKind,
    pub text: String,
    /// Line number in the pull request's version; `None` for added lines.
    pub old: Option<u32>,
    /// Line number after the fix; `None` for removed lines.
    pub new: Option<u32>,
}

/// Why the core chose a fixup target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum FixupReason {
    /// Blame of the commented lines points to this pull request commit.
    Blame,
    /// The newest pull request commit that changes the file.
    File,
}

/// A commit of the pull request a fix can be a `fixup!` for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct FixupTarget {
    pub sha: Sha,
    pub summary: String,
    /// `None` for the candidates the user can choose from.
    pub reason: Option<FixupReason>,
}

/// `aiReviewFix` (8.2): a suggested fix for one review thread – nothing is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiReviewFix {
    pub thread_id: String,
    pub path: String,
    /// The replaced lines at `head_sha` (1-based, inclusive).
    pub start_line: u32,
    pub end_line: u32,
    pub new_text: String,
    /// The AI's reason, for the user and the reply draft.
    pub why: String,
    /// The pull request's newest commit the fix was built for.
    pub head_sha: Sha,
    /// The replaced lines as they are.
    pub old_text: String,
    /// The hunk for display (built by the core).
    pub lines: Vec<ReviewFixLine>,
    /// The commit the fix belongs to; `None` = the user chooses from `candidates`.
    pub target: Option<FixupTarget>,
    /// The pull request's commits, newest first.
    pub candidates: Vec<FixupTarget>,
    /// The local branch of the pull request.
    pub branch: String,
    /// `branch` is checked out here (otherwise the UI offers "Check out branch").
    pub on_branch: bool,
}

/// What `review_fix_apply` takes from a suggestion – the core checks and rebuilds everything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReviewFixInput {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub new_text: String,
    /// The pull request's newest commit the suggestion was made for.
    pub head_sha: Sha,
}

/// What `review_fix_apply` committed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReviewFixApplied {
    pub commit: Sha,
    /// `fixup! <subject of the target>`.
    pub summary: String,
    /// `fixup!` commits between `base` and HEAD now (for "n fixup commits – squash now?").
    pub fixups: u32,
    /// Merge base with the pull request's target: the base of the autosquash plan.
    pub base: Sha,
    pub undo_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    pub sha: Sha,
    pub summary: String,
    pub author_name: String,
    pub authored_at: IsoTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CheckRunState {
    Passing,
    Failing,
    Pending,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub state: CheckRunState,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PrDetails {
    #[serde(flatten)]
    pub summary: PrSummary,
    /// Markdown.
    pub body: String,
    pub reviewers: Vec<PrReviewer>,
    /// General comments, review texts and comments on lines, by time.
    pub comments: Vec<HostComment>,
    pub commits: Vec<PrCommit>,
    /// `None` = the host is still computing.
    pub mergeable: Option<bool>,
    /// The individual checks (`checks` is their summary).
    pub check_runs: Vec<PrCheck>,
    pub head_sha: Sha,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum PrMergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum IssueListState {
    Open,
    Closed,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    /// Identifier for display, e.g. `#12`.
    pub key: String,
    pub title: String,
    pub state: IssueState,
    pub author: Option<HostUser>,
    pub assignees: Vec<HostUser>,
    pub labels: Vec<HostLabel>,
    pub updated_at: IsoTime,
    pub web_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub items: Vec<IssueSummary>,
    pub next_page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "hosts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct IssueDetails {
    #[serde(flatten)]
    pub summary: IssueSummary,
    /// Markdown.
    pub body: String,
    pub comments: Vec<HostComment>,
}

#[cfg(test)]
mod host_kind_tests {
    use super::*;

    #[test]
    fn host_kinds_have_one_name_in_the_contract_and_in_the_database() {
        for kind in HostKind::ALL.iter().copied() {
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str(), "{kind:?}");
            assert_eq!(HostKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(HostKind::parse("svn"), None);
        assert_eq!(HostKind::parse("GitHub"), None, "names are exact");
        assert_eq!(HostKind::parse(""), None);
    }
}
