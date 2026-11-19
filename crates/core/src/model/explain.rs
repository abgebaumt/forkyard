//! Git in plain language

use super::*;

/// A command a plan may contain (allow list in `ai::features::plan_commands`); wire names as in
/// `CoreCommands` (`branchCreate` …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub enum PlanCommand {
    BranchCreate,
    BranchCheckout,
    BranchRename,
    BranchDelete,
    ResetBranch,
    RebaseStart,
    CherryPick,
    RevertCommit,
    MergeStart,
    StashCreate,
    TagCreate,
    CommitReword,
    Fetch,
    Pull,
    Push,
    BranchDeleteRemote,
    TagPush,
}

/// `local`: changes only this repository and is undone with the plan; `outward`: reaches a
/// remote, is confirmed on its own and cannot be undone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum PlanClass {
    Local,
    Outward,
}

/// JSON type of an argument and how the step editor shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum PlanArgKind {
    Text,
    OptionalText,
    Boolean,
    List,
    Choice,
    OptionalChoice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PlanArgField {
    pub name: String,
    pub kind: PlanArgKind,
    /// Allowed values of `choice` / `optional_choice`; empty otherwise.
    pub choices: Vec<String>,
}

/// One step as the model proposed it or the user edited it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub command: PlanCommand,
    /// The command's arguments as JSON values (`null` = not given).
    pub args: serde_json::Map<String, serde_json::Value>,
    /// Why the step is needed – the model's words, plain text.
    pub why: String,
}

/// Pre-check of one step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PlanCheck {
    /// Simulated: no conflicts.
    Clean,
    /// The step cannot stop on conflicts.
    NotNeeded,
    /// Simulated: would stop on conflicts in these files. Blocks the plan.
    Conflicts { files: Vec<String> },
    /// Not simulated (depends on an earlier step or a fetch, or Git cannot simulate it).
    Unknown { reason: String },
    /// The arguments do not fit the allow list or the repository. Blocks the plan.
    Invalid { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PlanStepView {
    pub command: PlanCommand,
    pub args: serde_json::Map<String, serde_json::Value>,
    pub why: String,
    pub class: PlanClass,
    /// Deletes a branch or discards changes (shown with the word "destructive").
    pub destructive: bool,
    /// The command's arguments for the step editor.
    pub fields: Vec<PlanArgField>,
    pub check: PlanCheck,
}

/// A checked plan. Nothing in the repository has changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PlanPreview {
    pub steps: Vec<PlanStepView>,
    /// The model's note (why nothing fits, what it left out), plain text.
    pub note: Option<String>,
    /// An operation (merge, rebase, cherry-pick, revert, `git am`) or open conflicts block every plan.
    pub blocked: bool,
    /// Expected state; `ai_plan_run` refuses with `stale_state` when it no longer holds.
    pub expect: String,
    /// No step is invalid or conflicts, nothing blocks and there is at least one step.
    pub runnable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Done,
    Failed,
    NotRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PlanStepOutcome {
    pub index: u32,
    pub status: PlanStepStatus,
    /// Only for `failed`.
    pub error: Option<crate::error::CoreError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct PlanRunResult {
    pub steps: Vec<PlanStepOutcome>,
    /// One group undo entry `plan` was recorded (Mod+Z takes the done steps back).
    pub undo_recorded: bool,
    /// Every step is done.
    pub completed: bool,
    pub cancelled: bool,
}

/// The four groups of the release notes (Keep a Changelog).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ReleaseGroupKind {
    Added,
    Changed,
    Fixed,
    Other,
}

/// The language the entries were written in; German and English have their own headings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ReleaseLanguage {
    De,
    En,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNoteGroup {
    pub kind: ReleaseGroupKind,
    /// `Added` / `Neu` …
    pub heading: String,
    /// One line each, without the bullet.
    pub entries: Vec<String>,
}

/// The commits of the release notes: after `from` (a tag or the given start) up to `to_sha`, merges left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotesRange {
    /// `None`: from the first commit (no earlier tag).
    pub from: Option<String>,
    pub from_sha: Option<String>,
    pub to_sha: String,
    /// All commits of the range (`git rev-list --no-merges --count`).
    pub commits: u32,
    /// How many of them (newest first) go to the provider.
    pub included: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    pub range: ReleaseNotesRange,
    pub language: ReleaseLanguage,
    /// Non-empty groups in the order Added, Changed, Fixed, Other.
    pub groups: Vec<ReleaseNoteGroup>,
    /// `### <heading>` blocks with `- ` entries; empty without commits.
    pub markdown: String,
    /// Commits no entry is based on (no visible change).
    pub unmentioned: u32,
}

/// `changelog_insert`: which file (relative to the working directory) and how.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ChangelogInsertResult {
    pub path: String,
    pub created: bool,
    pub keep_a_changelog: bool,
}

/// Which way the search by meaning goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiSearchRoute {
    /// The embedding provider on this computer from Settings › AI.
    LocalEmbeddings,
    /// The embeddings API of the main provider.
    ProviderEmbeddings,
    /// No embeddings: the main provider turns the question into a Git search and sorts the hits.
    Rephrase,
}

/// One hit of the search by meaning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiSemanticHit {
    pub commit: CommitSummary,
    /// Cosine similarity of the embedding routes.
    pub score: Option<f64>,
    /// The model's reason (rephrase route).
    pub reason: Option<String>,
    /// Words of the question that occur in the subject (lower case).
    pub matched_terms: Vec<String>,
}

/// Result of `ai_semantic_search`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiSemanticResult {
    pub route: AiSearchRoute,
    /// Best first, at most 50.
    pub hits: Vec<AiSemanticHit>,
    /// Commits in the index of this repository and model (0 for rephrasing).
    pub indexed: u64,
    /// More reachable commits than the index takes (200 000).
    pub capped: bool,
    /// Sorted by meaning or by the model; `false`: the ranking request was skipped (newest first).
    pub ranked: bool,
    /// Rephrase route: the narrowing that was searched with (`pickaxe` = the code text).
    pub filters: Option<CommitSearchFilters>,
    pub terms: Vec<String>,
    pub author: Option<String>,
    /// Paths or dates of the model's answer that were not valid and not used.
    pub ignored: Vec<String>,
}

/// `ai_semantic_status`: the way of the search and the index of this repository (sends nothing).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiSemanticStatus {
    pub route: AiSearchRoute,
    /// The embedder (embedding routes) or the main provider (rephrasing).
    pub provider: Option<AiProviderKind>,
    pub model: Option<String>,
    /// Commits in the index of this repository and model.
    pub indexed: u64,
    /// An index of this repository and model exists – "Meaning" was used.
    pub used: bool,
    /// Runs on this computer (for "local models take longer").
    pub local: bool,
}

/// `ai_semantic_index_update`: what the background growth did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiSemanticIndexUpdate {
    pub added: u64,
    pub removed: u64,
    /// New commits would need a confirmation: left for the next search.
    pub waiting: bool,
}

/// `ai_pr_description`: a suggestion for title and description – nothing is written
/// anywhere; the form places it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiPrDescription {
    /// One line, at most 300 characters.
    pub title: String,
    /// Markdown; ends with `Closes #n` for every host issue the commits mention.
    pub body: String,
    /// Host issues the description closes – from the commits, never from the AI.
    pub closes: Vec<u64>,
}

/// `ai_commit_message`: a draft for the commit form – the core never commits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiCommitMessage {
    /// One line, at most 72 characters (`ai::features::commit_message::SUMMARY_LIMIT`).
    pub summary: String,
    /// `None` when the summary says everything.
    pub body: Option<String>,
}

/// Sign-in of an AI command-line tool, as the tool reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiLoginState {
    LoggedIn,
    LoggedOut,
    /// The tool gave no readable answer (in time).
    Unknown,
}

/// Where a program was found (`tools::locate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ToolSource {
    Configured,
    Path,
    KnownLocation,
    LoginShell,
}

/// An AI command-line tool the setup found (`ai_detect`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiCliFound {
    pub provider: AiProviderKind,
    pub path: String,
    pub version: Option<String>,
    pub source: ToolSource,
    pub login: AiLoginState,
    /// "claude.ai", "ChatGPT" … – never an account name.
    pub login_method: Option<String>,
    /// Claude Code would use `ANTHROPIC_API_KEY` from the environment instead of the sign-in.
    pub uses_env_key: bool,
    /// All safety switches are there; otherwise `problem` names the missing ones.
    pub supported: bool,
    pub problem: Option<String>,
    /// The sign-in as text ("claude auth login").
    pub login_command: String,
}

/// Ollama or LM Studio answering on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiLocalFound {
    pub provider: AiProviderKind,
    pub base_url: String,
    pub models: Vec<String>,
}

/// What the setup dialog offers (`ai_detect`); nothing was sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiDetection {
    pub clis: Vec<AiCliFound>,
    pub local: Vec<AiLocalFound>,
    /// Providers with a stored API key.
    pub keys: Vec<AiProviderKind>,
    pub elapsed_ms: u64,
}

/// Own paths of the AI command-line tools (`Settings.ai_cli_paths`, global); `None` = found
/// automatically (PATH, the usual install folders, the login shell's PATH).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase", default)]
pub struct AiCliPaths {
    pub claude_code: Option<String>,
    pub codex: Option<String>,
    pub opencode: Option<String>,
}

impl AiCliPaths {
    /// The own path for a command-line tool; `None` for every other provider.
    pub fn get(&self, kind: AiProviderKind) -> Option<&str> {
        match kind {
            AiProviderKind::ClaudeCode => self.claude_code.as_deref(),
            AiProviderKind::Codex => self.codex.as_deref(),
            AiProviderKind::Opencode => self.opencode.as_deref(),
            _ => None,
        }
    }

    pub fn entries(&self) -> [(AiProviderKind, Option<&str>); 3] {
        [
            (AiProviderKind::ClaudeCode, self.claude_code.as_deref()),
            (AiProviderKind::Codex, self.codex.as_deref()),
            (AiProviderKind::Opencode, self.opencode.as_deref()),
        ]
    }
}

/// Global settings of the active profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    /// 0.8 to 1.5
    pub zoom: f64,
    pub date_format: DateFormat,
    pub show_initials: bool,
    pub toolbar_labels: bool,
    pub remember_tabs: bool,
    pub default_branch_name: String,
    /// 0 = off, otherwise 1 to 60.
    pub auto_fetch_minutes: u32,
    pub auto_prune: bool,
    /// At least 500.
    pub initial_commits: u32,
    pub lazy_load: bool,
    pub default_pull_mode: PullMode,
    pub squash_on_merge: bool,
    pub push_after_commit: bool,
    pub delete_orig_files: bool,
    pub diff_mode: DiffMode,
    pub diff_word_wrap: bool,
    pub diff_ignore_whitespace: bool,
    pub editor_font_size: u32,
    pub editor_tab_size: u32,
    pub external_editor: Option<String>,
    pub external_terminal: Option<String>,
    pub external_diff_tool: Option<String>,
    pub external_merge_tool: Option<String>,
    pub notify_on_fetch: bool,
    pub notify_on_error: bool,
    /// Ask GitHub once a day whether a newer stable release exists (`update_check`).
    #[serde(default = "yes")]
    pub check_for_updates: bool,
    /// The user's own coding-agent templates (Settings › Coding agents). Global; the built-in
    /// templates (Claude Code, Codex, opencode) are not stored.
    #[serde(default)]
    pub agent_templates: Vec<AgentTemplate>,
    pub ssh_use_agent: bool,
    /// Proxy for all HTTP(S) remotes (`http.proxy`); `None` = whatever Git already uses.
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// Different proxy per host (`http.<url>.proxy`).
    #[serde(default)]
    pub proxy_by_host: Vec<HostProxy>,
    /// Own CA bundle (`http.sslCAInfo`), path of a PEM file.
    #[serde(default)]
    pub ssl_ca_file: Option<String>,
    /// Hosts for which certificate verification is turned off (`http.<url>.sslVerify=false`,
    /// never global), in the form `https://host[:port]`.
    #[serde(default)]
    pub ssl_no_verify_hosts: Vec<String>,
    // --- AI (all global, see db::app_settings::GLOBAL_KEYS) ---
    /// Master switch: `None` = not set up yet, `Some(false)` = turned off on purpose.
    #[serde(default)]
    pub ai_enabled: Option<bool>,
    #[serde(default)]
    pub ai_provider: Option<AiProviderKind>,
    /// Model ID as the provider names it (`claude-sonnet-5-5`, `qwen3:8b` …).
    #[serde(default)]
    pub ai_model: Option<String>,
    /// Address of the OpenAI-compatible service, or another address for Ollama / LM Studio.
    #[serde(default)]
    pub ai_base_url: Option<String>,
    /// Functions that are switched off.
    #[serde(default)]
    pub ai_features_off: Vec<AiFeature>,
    /// Exclusion patterns (gitignore syntax) for every repository.
    #[serde(default)]
    pub ai_exclude: Vec<String>,
    /// Ask before a request whose estimated cost is above this (USD).
    #[serde(default = "default_ai_confirm_cost")]
    pub ai_confirm_cost_usd: f64,
    /// Ask before every further request once this month's estimated API costs reach this (USD).
    #[serde(default)]
    pub ai_monthly_limit_usd: Option<f64>,
    #[serde(default)]
    pub ai_prices: Vec<AiPriceOverride>,
    /// Own paths of the AI command-line tools; empty = found automatically.
    #[serde(default)]
    pub ai_cli_paths: AiCliPaths,
    /// Optional embedding provider of the search by meaning: only on
    /// this computer (Ollama, LM Studio). `None` = the main provider's embeddings, if it has any.
    #[serde(default)]
    pub ai_search_embed_provider: Option<AiProviderKind>,
    /// Embedding model: of the local provider above, otherwise of the main provider (empty = its
    /// default: `text-embedding-3-small` for OpenAI, `gemini-embedding-001` for Gemini).
    #[serde(default)]
    pub ai_search_embed_model: Option<String>,
    /// Other address of the local embedding provider (only this computer).
    #[serde(default)]
    pub ai_search_embed_base_url: Option<String>,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: Theme::Dark,
            zoom: 1.0,
            date_format: DateFormat::Relative,
            show_initials: false,
            toolbar_labels: true,
            remember_tabs: true,
            default_branch_name: "main".into(),
            auto_fetch_minutes: 1,
            auto_prune: true,
            initial_commits: 2000,
            lazy_load: true,
            default_pull_mode: PullMode::Ff,
            squash_on_merge: false,
            push_after_commit: false,
            delete_orig_files: true,
            diff_mode: DiffMode::Hunks,
            diff_word_wrap: false,
            diff_ignore_whitespace: false,
            editor_font_size: 13,
            editor_tab_size: 4,
            external_editor: None,
            external_terminal: None,
            external_diff_tool: None,
            external_merge_tool: None,
            notify_on_fetch: false,
            notify_on_error: true,
            check_for_updates: true,
            agent_templates: Vec::new(),
            ssh_use_agent: true,
            proxy_url: None,
            proxy_by_host: Vec::new(),
            ssl_ca_file: None,
            ssl_no_verify_hosts: Vec::new(),
            ai_enabled: None,
            ai_provider: None,
            ai_model: None,
            ai_base_url: None,
            ai_features_off: Vec::new(),
            ai_exclude: Vec::new(),
            ai_confirm_cost_usd: DEFAULT_AI_CONFIRM_COST_USD,
            ai_monthly_limit_usd: None,
            ai_prices: Vec::new(),
            ai_cli_paths: AiCliPaths::default(),
            ai_search_embed_provider: None,
            ai_search_embed_model: None,
            ai_search_embed_base_url: None,
        }
    }
}

/// App-side settings per repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct RepoSettings {
    pub encoding: String,
    pub hooks_path: Option<String>,
    pub commit_template: Option<String>,
    /// Content of the effective template file (`commit.template`, local or global; `~` resolved,
    /// also outside the repository). Read-only; `None` if there is no readable one.
    pub commit_template_text: Option<String>,
    pub default_pull_mode: Option<PullMode>,
    pub auto_fetch: bool,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    /// SSH key only for this repository (from the keys of the active profile); it is
    /// enforced for the app's network calls, even with an SSH agent. `None` = like the profile.
    #[serde(default)]
    pub ssh_key_id: Option<String>,
    /// After checkout, pull, merge, cherry-pick, revert, hard reset and a finished rebase: bring
    /// submodules whose recorded commit changed to it (`git submodule update --init --recursive`).
    pub submodules_auto_update: bool,
    /// Ticket link rules of this repository (presets, own rules, host links on/off). Checked on
    /// saving; the effective rules (including `.forkyard/links.json`) come from `link_rules_get`.
    #[serde(default)]
    pub link_rules: LinkRulesConfig,
    /// Test command for coding agents (run in the agent's worktree when it is done). `None` = none.
    /// App side (`repo_settings`), never read from the repository.
    #[serde(default)]
    pub test_command: Option<String>,
    /// "AI off for this repository": no AI element appears for it, nothing of it is sent.
    #[serde(default)]
    pub ai_off: bool,
    /// Project › AI and agents: run the AI review before every normal push (off by default).
    #[serde(default)]
    pub ai_review_before_push: bool,
    /// How many secret-scan findings this repository no longer reports ("Don't report again").
    /// Read-only; only hashes are stored, never values.
    #[serde(default)]
    pub secret_scan_ignored_count: u32,
    /// Own instruction for AI commit messages in this repository, at most 2000
    /// characters; stored in the app (`repo_settings`), never in .git/config.
    #[serde(default)]
    pub ai_commit_instruction: Option<String>,
}

impl Default for RepoSettings {
    fn default() -> Self {
        RepoSettings {
            encoding: "utf-8".into(),
            hooks_path: None,
            commit_template: None,
            commit_template_text: None,
            ai_review_before_push: false,
            secret_scan_ignored_count: 0,
            default_pull_mode: None,
            auto_fetch: true,
            author_name: None,
            author_email: None,
            ssh_key_id: None,
            submodules_auto_update: true,
            link_rules: LinkRulesConfig::default(),
            test_command: None,
            ai_off: false,
            ai_commit_instruction: None,
        }
    }
}

/// Trackers with a ready-made rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum LinkPresetKind {
    Jira,
    Linear,
    Youtrack,
    Redmine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LinkPreset {
    pub kind: LinkPresetKind,
    /// Address of the tracker, e.g. `https://firma.atlassian.net` (http/https, no trailing slash).
    pub base_url: String,
    /// Jira, Linear, YouTrack: only these project keys (`ABC` for `ABC-123`); empty = every key.
    /// Always empty for Redmine (`#123`).
    #[serde(default)]
    pub keys: Vec<String>,
}

/// An own rule: matches of `pattern` link to `url` (`$0` = whole match, `$1` … = groups).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CustomLinkRule {
    pub id: String,
    pub pattern: String,
    pub url: String,
}

/// Ticket links stored for a repository (`repo_settings`, key `linkRules`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase", default)]
pub struct LinkRulesConfig {
    /// `#123` (on GitLab also `!123`) link to the repository's host.
    pub host_rules: bool,
    pub presets: Vec<LinkPreset>,
    pub custom: Vec<CustomLinkRule>,
}

impl Default for LinkRulesConfig {
    fn default() -> Self {
        LinkRulesConfig { host_rules: true, presets: Vec::new(), custom: Vec::new() }
    }
}

/// Where an effective ticket link rule comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum LinkRuleSource {
    Custom,
    Preset,
    RepoFile,
    Host,
}

/// An effective rule: matches of `pattern` link to `url` (`$0` = whole match, `$1` … = groups).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LinkRule {
    /// `custom:<id>`, `preset:<kind>:<n>`, `file:<id or position>`, `host:issue`, `host:merge_request`.
    pub id: String,
    pub source: LinkRuleSource,
    pub pattern: String,
    pub url: String,
}

/// Where `.forkyard/links.json` was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "snake_case")]
pub enum LinkFileOrigin {
    Worktree,
    Head,
}

/// An ignored part of the repository file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LinkRuleProblem {
    /// Position in the file's `rules` (from 0); `None` = the file as a whole.
    pub index: Option<u32>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LinkRules {
    /// In order of precedence: where two rules match at the same place, the earlier one wins.
    pub rules: Vec<LinkRule>,
    /// `None`: the repository has no `.forkyard/links.json`.
    pub file: Option<LinkFileOrigin>,
    pub problems: Vec<LinkRuleProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "explain.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: Id,
    pub name: String,
    pub author_name: String,
    pub author_email: String,
    pub sync_gitconfig: bool,
    pub is_active: bool,
    /// Lane colour 1 to 8; `None` = by position in the list.
    pub color: Option<u8>,
}

