//! Paket 4: title and description of a pull request from the commits of a branch.
//!
//! Context: the branch's commits without merges (oldest first, the newest 100), the diff statistics
//! against the merge base (never file contents), ticket references the v1.1 link rules find in the
//! commit messages, the repository's pull request template and up to 50 commit subjects of the
//! target as a sample of the repository's language (Grundregel 6). Secret and ignored paths are
//! not named; everything is redacted and sent between the markers of `ai::prompt`.
//!
//! The answer `{ title, body }` is checked beyond the schema: a single-line title of at most 300
//! characters, and every heading of the repository's template still there – otherwise the one
//! repair attempt of `run::complete_json_checked`. Afterwards the core adds `Closes #n` for every
//! host issue the commits mention and reduces closing keywords before any other number to the
//! plain reference – every form the hosts act on (other repositories, issue URLs, GitLab's
//! keywords and lists after one keyword): closing an issue is an effect at the host the user did
//! not ask for, so neither the model nor a prompt injection in a commit may add one.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::ai::context::{self, Built, Exclusions};
use crate::ai::language;
use crate::ai::prompt::{self, Section};
use crate::app::Core;
use crate::commands::graph::{display_text, read_cmd, resolve_commit, LOG_SAFE};
use crate::commands::host::find_pr_template;
use crate::commands::links;
use crate::error::{CoreError, CoreResult};
use crate::host;
use crate::model::{AiOmitReason, AiOmitted, AiPrDescription, HostKind, LinkRule, LinkRuleSource, Settings};
use crate::util;

/// Longest title (the form's limit, `TITLE_LIMIT` in `PullRequestCreate`).
pub const TITLE_LIMIT: usize = 300;
/// At most this many ticket references go into the prompt.
pub const MAX_TICKETS: usize = 50;

/// A reference a link rule found in a commit message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub text: String,
    pub url: String,
}

/// The answer: title and Markdown description.
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "body": { "type": "string" }
        },
        "required": ["title", "body"],
        "additionalProperties": false
    })
}

/// `## Text` → `"## Text"`: an ATX heading (`#` to `######` and a space; closing `#`s and repeated
/// whitespace dropped). `None` for anything else.
fn atx_heading(line: &str) -> Option<String> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &line[level..];
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let text = rest.trim();
    let stripped = text.trim_end_matches('#');
    let text = if stripped.len() < text.len() && (stripped.is_empty() || stripped.ends_with([' ', '\t'])) { stripped.trim_end() } else { text };
    if text.is_empty() {
        return None;
    }
    Some(format!("{} {}", "#".repeat(level), text.split_whitespace().collect::<Vec<_>>().join(" ")))
}

/// The ATX headings of a Markdown text, outside fenced code blocks and HTML comments.
pub fn template_headings(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut in_comment = false;
    for line in text.lines() {
        if in_comment {
            if line.contains("-->") {
                in_comment = false;
            }
            continue;
        }
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        if let Some((mark, length)) = fence {
            let run = trimmed.chars().take_while(|c| *c == mark).count();
            if indent < 4 && run >= length && trimmed[run..].trim().is_empty() {
                fence = None;
            }
            continue;
        }
        if indent >= 4 {
            continue;
        }
        let opened = ['`', '~'].into_iter().find_map(|mark| {
            let run = trimmed.chars().take_while(|c| *c == mark).count();
            (run >= 3).then_some((mark, run))
        });
        if opened.is_some() {
            fence = opened;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("<!--") {
            in_comment = !rest.contains("-->");
            continue;
        }
        if let Some(heading) = atx_heading(trimmed) {
            out.push(heading);
        }
    }
    out
}

/// Meaning check of the answer (after the schema check).
pub fn check_answer(value: &Value, headings: &[String]) -> Result<(), String> {
    let title = value["title"].as_str().unwrap_or_default().trim();
    if title.is_empty() {
        return Err("$.title: the title is empty".into());
    }
    if title.contains(['\n', '\r']) {
        return Err("$.title: the title must be a single line".into());
    }
    if title.chars().count() > TITLE_LIMIT {
        return Err(format!("$.title: the title has more than {TITLE_LIMIT} characters"));
    }
    let present: BTreeSet<String> = template_headings(value["body"].as_str().unwrap_or_default()).into_iter().collect();
    let missing: Vec<&str> = headings.iter().filter(|heading| !present.contains(*heading)).map(String::as_str).collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("$.body: every heading of the pull request template must stay exactly as it is; missing: {}", missing.join(" | ")))
    }
}

/// `$0` … `$9` of a rule's address, filled from the match.
fn expand(template: &str, caps: &regex::Captures<'_>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            if let Some(digit) = chars.peek().and_then(|d| d.to_digit(10)) {
                chars.next();
                out.push_str(caps.get(digit as usize).map_or("", |m| m.as_str()));
                continue;
            }
        }
        out.push(c);
    }
    out
}

struct Hit<'a> {
    start: usize,
    rule: &'a LinkRule,
    ticket: Ticket,
    number: Option<u64>,
}

/// The matches of all rules in one message; where two overlap, the earlier rule wins (as in the UI).
fn hits<'a>(message: &str, compiled: &'a [(LinkRule, Regex)]) -> Vec<Hit<'a>> {
    let mut taken: Vec<(usize, usize)> = Vec::new();
    let mut out = Vec::new();
    for (rule, regex) in compiled {
        for caps in regex.captures_iter(message) {
            let Some(whole) = caps.get(0) else { continue };
            if taken.iter().any(|(start, end)| whole.start() < *end && *start < whole.end()) {
                continue;
            }
            taken.push((whole.start(), whole.end()));
            let number = caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok()).filter(|n| *n > 0);
            out.push(Hit { start: whole.start(), rule, ticket: Ticket { text: whole.as_str().to_string(), url: expand(&rule.url, &caps) }, number });
        }
    }
    out.sort_by_key(|hit| hit.start);
    out
}

fn compile(rules: &[LinkRule]) -> Vec<(LinkRule, Regex)> {
    rules.iter().filter_map(|rule| Regex::new(&rule.pattern).ok().map(|regex| (rule.clone(), regex))).collect()
}

/// Ticket references in the messages (oldest first), each text once, at most `MAX_TICKETS`.
pub fn tickets(messages: &[String], rules: &[LinkRule]) -> Vec<Ticket> {
    let compiled = compile(rules);
    let mut out: Vec<Ticket> = Vec::new();
    for message in messages {
        for hit in hits(message, &compiled) {
            if out.len() < MAX_TICKETS && !out.iter().any(|known| known.text == hit.ticket.text) {
                out.push(hit.ticket);
            }
        }
    }
    out
}

/// Numbers of host issues (`host:issue`) the messages mention, in order of first appearance.
pub fn issue_numbers(messages: &[String], rules: &[LinkRule]) -> Vec<u64> {
    let compiled = compile(rules);
    let mut out = Vec::new();
    for message in messages {
        for hit in hits(message, &compiled) {
            if hit.rule.source == LinkRuleSource::Host && hit.rule.id == "host:issue" {
                if let Some(number) = hit.number.filter(|n| !out.contains(n)) {
                    out.push(number);
                }
            }
        }
    }
    out
}

/// One reference a closing keyword can act on: `#n`, `owner/repo#n` or `group/sub/project#n`, an
/// issue URL, or an upper-case external ticket (`PROJ-7`, GitLab's Jira form); GitLab also allows
/// `issue`/`issues` in front of each.
const CLOSING_REF: &str = r"(?:issues?\s+)?(?:#\d+\b|[\w.-]+(?:/[\w.-]+)*#\d+\b|https?://[^\s,]+|(?-i:[A-Z][A-Z0-9_]+-\d+\b))";

/// A closing statement as the hosts read it: one keyword of the GitHub/Gitea set or GitLab's
/// larger one (`closing`, `implements`, `fixing`, `resolving` …), then a list of references joined
/// as GitLab joins them: an optional comma and/or `and`, plain spaces or nothing at all
/// (`#12 #77`, `#12#77`) – GitLab closes every issue of such a list.
fn closing_keyword() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let keyword = r"clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resol(?:ve[sd]?|ving)|implement(?:s|ed|ing)?";
        let list = format!(r"{CLOSING_REF}(?:(?:\s*,?\s*and\s+|\s*,?\s*){CLOSING_REF})*");
        Regex::new(&format!(r"(?i)\b(?:{keyword})\s*:?\s*({list})")).expect("valid pattern")
    })
}

fn closing_ref() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!("(?i){CLOSING_REF}")).expect("valid pattern"))
}

/// The issue numbers a closing statement's list closes, or `None` when one of its references is
/// anything but a plain `#n` (another repository, a URL, an `issue` prefix, a ticket).
fn plain_numbers(list: &str) -> Option<Vec<u64>> {
    closing_ref().find_iter(list).map(|item| item.as_str().strip_prefix('#').and_then(|digits| digits.parse().ok())).collect()
}

/// "Fixes #77" → "#77": a closing statement keeps its keyword only when every reference in it is
/// a plain `#n` of `closes`; otherwise the keyword goes and the references stay as plain text.
pub fn strip_foreign_closes(body: &str, closes: &[u64]) -> String {
    closing_keyword()
        .replace_all(body, |caps: &regex::Captures<'_>| match plain_numbers(&caps[1]) {
            Some(numbers) if numbers.iter().all(|n| closes.contains(n)) => caps[0].to_string(),
            _ => caps[1].to_string(),
        })
        .into_owned()
}

/// Appends `Closes #n` for every number the text does not close yet.
pub fn with_closes(body: &str, closes: &[u64]) -> String {
    let present: BTreeSet<u64> =
        closing_keyword().captures_iter(body).filter_map(|caps| plain_numbers(&caps[1])).flatten().collect();
    let lines: Vec<String> = closes.iter().filter(|n| !present.contains(n)).map(|n| format!("Closes #{n}")).collect();
    if lines.is_empty() {
        body.to_string()
    } else if body.trim().is_empty() {
        lines.join("\n")
    } else {
        format!("{body}\n\n{}", lines.join("\n"))
    }
}

/// The checked answer as the form gets it.
pub fn finish(value: &Value, closes: &[u64]) -> AiPrDescription {
    let title = value["title"].as_str().unwrap_or_default().trim().to_string();
    let body = strip_foreign_closes(value["body"].as_str().unwrap_or_default(), closes);
    AiPrDescription { title, body: with_closes(body.trim_end(), closes), closes: closes.to_vec() }
}

pub const MAX_COMMITS: usize = 100;
pub const LANGUAGE_SAMPLE: usize = 50;
/// At most this many files are listed; the rest goes into one summary line.
pub const MAX_STAT_FILES: usize = 300;
/// Commit bodies are cut to this many lines first when the budget is tight.
const BODY_LINES: usize = 12;
/// Rough size of a section's title line and markers beyond title and body.
const SECTION_OVERHEAD: usize = 96;

/// The instruction of the system text. `language`: Paket 3.1's `ai::language::detect` of the
/// target's recent subjects (Grundregel 6); `None` leaves it to the sample section.
pub fn instruction(language: Option<&str>) -> String {
    let language = match language {
        Some(language) => format!("Write title and description in {language}, the language of this repository's commit messages. "),
        None => "Write title and description in the language most of the recent commit subjects use. ".to_string(),
    };
    format!(
        "Write the title and the description (Markdown) of a pull request from the commits of a branch. \
         The title is one line, ideally at most 72 characters, never more than 300. \
         The description says what changes and why, based only on the commits and the changed files; do not invent tests, numbers, links or issues. \
         If a pull request template is given, keep every heading, checklist item and HTML comment of it exactly as it is and write your text under its headings; leave a checklist item unticked unless a commit clearly says it is done. \
         {language}Do not write closing keywords such as “Closes #12”; Forkyard adds them itself."
    )
}

/// What `build` hands to the command and to `ai_preview`.
#[derive(Debug, Clone)]
pub struct PrBuilt {
    pub built: Built,
    /// Headings of the template that was sent (empty without one).
    pub headings: Vec<String>,
    /// Host issues the description will close.
    pub closes: Vec<u64>,
}

#[derive(Debug, Clone)]
struct BranchCommit {
    subject: String,
    body: String,
}

#[derive(Debug, Clone)]
struct Stat {
    path: String,
    line: String,
    added: u64,
    deleted: u64,
}

struct Parts {
    branch: String,
    commits: Vec<BranchCommit>,
    total_commits: usize,
    stats: Vec<Stat>,
    tickets: Vec<Ticket>,
    template: Option<String>,
    sample: Vec<String>,
}

/// Hosts whose pull request descriptions close issues with “Closes #n”.
fn closes_issues(kind: HostKind) -> bool {
    matches!(kind, HostKind::Github | HostKind::Gitlab | HostKind::Gitea)
}

/// `refs/heads/feature/x` → `feature/x`, `refs/remotes/origin/main` → `origin/main`.
fn short_ref(name: &str) -> &str {
    name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/remotes/")).unwrap_or(name)
}

/// The commits of `source` that `target` does not have, without merges, newest `MAX_COMMITS`, oldest first.
async fn branch_commits(core: &Core, repo_id: &str, target_sha: &str, source_sha: &str) -> CoreResult<(Vec<BranchCommit>, usize)> {
    let path = core.repo_path(repo_id)?;
    let range = format!("{target_sha}..{source_sha}");
    let count = read_cmd(core, &path, repo_id).args(["rev-list", "--count", "--no-merges", range.as_str(), "--"]).run().await?;
    let total: usize = count.stdout_text().trim().parse().unwrap_or(0);
    let out = read_cmd(core, &path, repo_id)
        .args(["log", "--no-merges", "--topo-order", "-z"])
        .args(LOG_SAFE)
        .arg(format!("--max-count={MAX_COMMITS}"))
        .args(["--format=%H%x00%s%x00%b", range.as_str(), "--"])
        .run()
        .await?;
    let fields = out.stdout_z();
    let mut commits: Vec<BranchCommit> =
        fields.chunks(3).filter(|chunk| chunk.len() == 3).map(|chunk| BranchCommit { subject: display_text(chunk[1]), body: display_text(chunk[2]).trim_end().to_string() }).collect();
    commits.reverse();
    let total = total.max(commits.len());
    Ok((commits, total))
}

/// `git diff --numstat` from the merge base (or, without one, from the target) to the source.
async fn diff_stats(core: &Core, repo_id: &str, target_sha: &str, source_sha: &str) -> CoreResult<Vec<(Option<u64>, Option<u64>, Option<String>, String)>> {
    let path = core.repo_path(repo_id)?;
    let merge_base = read_cmd(core, &path, repo_id).args(["merge-base", target_sha, source_sha]).run_raw().await?;
    let base = if merge_base.success() { merge_base.stdout_text() } else { target_sha.to_string() };
    let out = read_cmd(core, &path, repo_id)
        .args(["diff", "--numstat", "-z", "-M", "--no-color", "--no-ext-diff", "--no-textconv", base.as_str(), source_sha, "--"])
        .run()
        .await?;
    Ok(context::parse_numstat(&out.stdout)
        .into_iter()
        .map(|(added, deleted, old, new)| (added, deleted, old.as_deref().map(util::decode_lossy), util::decode_lossy(&new)))
        .collect())
}

/// Up to 50 commit subjects of the target, newest first (Grundregel 6).
async fn language_sample(core: &Core, repo_id: &str, target_sha: &str) -> CoreResult<Vec<String>> {
    let path = core.repo_path(repo_id)?;
    let out = read_cmd(core, &path, repo_id)
        .args(["log", "--no-merges", "-z"])
        .args(LOG_SAFE)
        .arg(format!("--max-count={LANGUAGE_SAMPLE}"))
        .args(["--format=%s", target_sha, "--"])
        .run()
        .await?;
    Ok(out.stdout_z().into_iter().map(display_text).collect())
}

fn stat_line(path: &str, old_path: Option<&str>, added: Option<u64>, deleted: Option<u64>, generated: bool) -> String {
    let mut line = path.to_string();
    if let Some(old) = old_path {
        line.push_str(&format!(" (renamed from {old})"));
    }
    match (added, deleted) {
        (Some(added), Some(deleted)) => line.push_str(&format!(" +{added} -{deleted}")),
        _ => line.push_str(" – binary file"),
    }
    if generated {
        line.push_str(" – generated or lock file");
    }
    line
}

fn render_commits(commits: &[BranchCommit], total: usize, body_lines: Option<usize>) -> String {
    let mut out = if total > commits.len() {
        format!("The newest {} of {} commits, oldest first (merge commits left out):\n", commits.len(), total)
    } else {
        format!("{} commit(s), oldest first (merge commits left out):\n", commits.len())
    };
    for commit in commits {
        out.push_str(&format!("- {}\n", commit.subject));
        let lines: Vec<&str> = commit.body.lines().collect();
        let keep = body_lines.unwrap_or(usize::MAX).min(lines.len());
        for line in &lines[..keep] {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
        if keep > 0 && keep < lines.len() {
            out.push_str("  … (message shortened)\n");
        }
    }
    out
}

fn render_stats(stats: &[Stat], listed: usize) -> String {
    if stats.is_empty() {
        return "(no files to list)".to_string();
    }
    let listed = listed.min(stats.len());
    let mut lines: Vec<String> = stats[..listed].iter().map(|stat| stat.line.clone()).collect();
    let rest = &stats[listed..];
    if !rest.is_empty() {
        let (added, deleted) = rest.iter().fold((0u64, 0u64), |(a, d), stat| (a + stat.added, d + stat.deleted));
        lines.push(format!("… {} more files (+{added} -{deleted}) not listed", rest.len()));
    }
    lines.join("\n")
}

fn sections(parts: &Parts, body_lines: Option<usize>, listed: usize, with_sample: bool, secrets: &[String]) -> Vec<Section> {
    let mut out = vec![
        Section { title: "Branch".into(), body: parts.branch.clone() },
        Section { title: "Commits of the branch".into(), body: render_commits(&parts.commits, parts.total_commits, body_lines) },
        Section { title: "Changed files (diff statistics, no contents)".into(), body: render_stats(&parts.stats, listed) },
    ];
    if !parts.tickets.is_empty() {
        let body = parts.tickets.iter().map(|ticket| format!("{} → {}", ticket.text, ticket.url)).collect::<Vec<_>>().join("\n");
        out.push(Section { title: "Ticket references in the commits".into(), body });
    }
    if let Some(template) = &parts.template {
        out.push(Section { title: "Pull request template".into(), body: template.clone() });
    }
    if with_sample && !parts.sample.is_empty() {
        out.push(Section { title: "Recent commit subjects of the target branch (sample of the repository's language)".into(), body: parts.sample.join("\n") });
    }
    for section in &mut out {
        section.body = context::redact_for_ai(&section.body, secrets);
    }
    out
}

fn size(sections: &[Section]) -> usize {
    sections.iter().map(|section| section.title.chars().count() + section.body.chars().count() + SECTION_OVERHEAD).sum()
}

fn left_out(stats: &[Stat]) -> impl Iterator<Item = AiOmitted> + '_ {
    stats.iter().map(|stat| AiOmitted { path: stat.path.clone(), reason: AiOmitReason::Budget, size: 0 })
}

/// The budget in a fixed order: full → bodies to 12 lines → fewer files → no bodies → no sample.
fn fit(parts: &Parts, budget_chars: usize, secrets: &[String], omitted: &mut Vec<AiOmitted>) -> Vec<Section> {
    let cap = parts.stats.len().min(MAX_STAT_FILES);
    for body_lines in [None, Some(BODY_LINES)] {
        let candidate = sections(parts, body_lines, cap, true, secrets);
        if size(&candidate) <= budget_chars {
            omitted.extend(left_out(&parts.stats[cap..]));
            return candidate;
        }
    }
    for (body_lines, with_sample) in [(Some(BODY_LINES), true), (Some(0), true), (Some(0), false)] {
        let mut listed = cap;
        while listed > 0 && size(&sections(parts, body_lines, listed, with_sample, secrets)) > budget_chars {
            listed -= 1;
        }
        let candidate = sections(parts, body_lines, listed, with_sample, secrets);
        if size(&candidate) <= budget_chars {
            omitted.extend(left_out(&parts.stats[listed..]));
            return candidate;
        }
    }
    omitted.extend(left_out(&parts.stats));
    sections(parts, Some(0), 0, false, secrets)
}

/// The prompt for the pull request from `source` into `target` (full ref names or any commit).
/// `secrets`: values known to be secret (the provider key), scrubbed literally.
#[allow(clippy::too_many_arguments)]
pub async fn build(core: &Core, repo_id: &str, settings: &Settings, source: &str, target: &str, budget_tokens: u64, locale: &str, secrets: &[String]) -> CoreResult<PrBuilt> {
    let source_sha = resolve_commit(core, repo_id, source).await?;
    let target_sha = resolve_commit(core, repo_id, target).await?;
    let (commits, total_commits) = branch_commits(core, repo_id, &target_sha, &source_sha).await?;
    if commits.is_empty() {
        return Err(CoreError::not_allowed(format!("“{}” has no commits that “{}” does not have.", short_ref(source), short_ref(target))));
    }
    let exclusions = Exclusions::load(core, repo_id, &settings.ai_exclude).await?;
    let hidden = |path: &str| exclusions.reason(path).filter(|reason| matches!(reason, AiOmitReason::Secret | AiOmitReason::Ignored));
    let mut omitted: Vec<AiOmitted> = Vec::new();
    let mut stats = Vec::new();
    for (added, deleted, old_path, path) in diff_stats(core, repo_id, &target_sha, &source_sha).await? {
        // A renamed secret stays a secret under its new name.
        if let Some(reason) = hidden(&path).or_else(|| old_path.as_deref().and_then(hidden)) {
            omitted.push(AiOmitted { path, reason, size: 0 });
            continue;
        }
        let generated = exclusions.reason(&path) == Some(AiOmitReason::Generated);
        let line = stat_line(&path, old_path.as_deref(), added, deleted, generated);
        stats.push(Stat { path, line, added: added.unwrap_or(0), deleted: deleted.unwrap_or(0) });
    }

    let messages: Vec<String> = commits.iter().map(|commit| format!("{}\n{}", commit.subject, commit.body)).collect();
    let rules = links::link_rules_get(core, repo_id.to_string()).await?.rules;
    let kind = host::resolve(core, repo_id, None).await?.map(|found| found.detected.kind);
    let closes = if kind.is_some_and(closes_issues) { issue_numbers(&messages, &rules) } else { Vec::new() };
    let tickets = tickets(&messages, &rules);

    let budget_chars = (budget_tokens as f64 * context::CHARS_PER_TOKEN) as usize;
    let template = match find_pr_template(core, repo_id).await? {
        Some((path, text)) => {
            let reason = hidden(&path).or_else(|| (text.chars().count() > budget_chars / 2).then_some(AiOmitReason::Budget));
            match reason {
                Some(reason) => {
                    if !omitted.iter().any(|known| known.path == path) {
                        omitted.push(AiOmitted { size: text.len() as u64, path, reason });
                    }
                    None
                }
                None => Some(text),
            }
        }
        None => None,
    };
    let headings = template.as_deref().map(|text| template_headings(&context::redact_for_ai(text, secrets))).unwrap_or_default();
    let sample = language_sample(core, repo_id, &target_sha).await?;
    let text = instruction(language::detect(&sample));

    let parts = Parts {
        branch: format!("Source branch: {}\nTarget branch: {}", short_ref(source), short_ref(target)),
        commits,
        total_commits,
        stats,
        tickets,
        template,
        sample,
    };
    let sections = fit(&parts, budget_chars, secrets, &mut omitted);
    let prompt = prompt::build(&text, locale, &sections);
    Ok(PrBuilt { built: Built { prompt, omitted, shortened: Vec::new() }, headings, closes })
}

#[cfg(test)]
mod tests;
