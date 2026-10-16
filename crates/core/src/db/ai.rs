//! Tables `ai_usage` (numbers only: requests, tokens, cost per month, provider, model and
//! function – never contents) and `ai_preview_seen` (which confirmation was already given:
//! globally with `repository_id` null, or per repository).

use rusqlite::{params, Connection};

use crate::error::CoreResult;

/// One request's numbers.
#[derive(Debug, Clone)]
pub struct NewUsage<'a> {
    /// `YYYY-MM` (UTC).
    pub month: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub feature: &'a str,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd_micros: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageRow {
    pub provider: String,
    pub model: String,
    pub feature: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd_micros: i64,
}

/// Was this confirmation already given? `repo_id: None` = global.
pub fn seen(conn: &Connection, repo_id: Option<&str>, ask: &str) -> CoreResult<bool> {
    let count: i64 = conn.query_row(
        "select count(*) from ai_preview_seen where coalesce(repository_id, '') = coalesce(?1, '') and ask = ?2",
        params![repo_id, ask],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

pub fn mark_seen(conn: &Connection, repo_id: Option<&str>, ask: &str) -> CoreResult<()> {
    conn.execute("insert or ignore into ai_preview_seen (repository_id, ask) values (?1, ?2)", params![repo_id, ask])?;
    Ok(())
}

/// "Ask again everywhere": forgets every given confirmation. Returns the number of rows.
pub fn reset_seen(conn: &Connection) -> CoreResult<usize> {
    Ok(conn.execute("delete from ai_preview_seen", [])?)
}

/// Adds one request to its month/provider/model/function row.
pub fn add_usage(conn: &Connection, usage: &NewUsage<'_>) -> CoreResult<()> {
    conn.execute(
        "insert into ai_usage (month, provider, model, feature, requests, input_tokens, output_tokens, cost_usd_micros)
         values (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)
         on conflict (month, provider, model, feature) do update set
           requests = requests + 1,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cost_usd_micros = cost_usd_micros + excluded.cost_usd_micros",
        params![
            usage.month,
            usage.provider,
            usage.model,
            usage.feature,
            usage.input_tokens as i64,
            usage.output_tokens as i64,
            usage.cost_usd_micros.max(0)
        ],
    )?;
    Ok(())
}

/// Estimated cost of this month for the given providers (micro-USD).
pub fn month_cost_micros(conn: &Connection, month: &str, providers: &[&str]) -> CoreResult<i64> {
    let mut total = 0i64;
    for provider in providers {
        let sum: i64 = conn.query_row(
            "select coalesce(sum(cost_usd_micros), 0) from ai_usage where month = ?1 and provider = ?2",
            params![month, provider],
            |r| r.get(0),
        )?;
        total += sum;
    }
    Ok(total)
}

pub fn usage_rows(conn: &Connection, month: &str) -> CoreResult<Vec<UsageRow>> {
    let mut stmt = conn.prepare(
        "select provider, model, feature, requests, input_tokens, output_tokens, cost_usd_micros
         from ai_usage where month = ?1 order by provider, model, feature",
    )?;
    let rows = stmt
        .query_map([month], |r| {
            Ok(UsageRow {
                provider: r.get(0)?,
                model: r.get(1)?,
                feature: r.get(2)?,
                requests: r.get::<_, i64>(3)?.max(0) as u64,
                input_tokens: r.get::<_, i64>(4)?.max(0) as u64,
                output_tokens: r.get::<_, i64>(5)?.max(0) as u64,
                cost_usd_micros: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{repos, Db};

    fn usage<'a>(month: &'a str, provider: &'a str, feature: &'a str, input: u64, output: u64, micros: i64) -> NewUsage<'a> {
        NewUsage { month, provider, model: "claude-sonnet-5-5", feature, input_tokens: input, output_tokens: output, cost_usd_micros: micros }
    }

    #[test]
    fn usage_adds_up_per_month_provider_model_and_feature() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            add_usage(c, &usage("2026-10", "anthropic", "commit_message", 100, 10, 1000))?;
            add_usage(c, &usage("2026-10", "anthropic", "commit_message", 50, 5, 500))?;
            add_usage(c, &usage("2026-10", "anthropic", "compose", 7, 3, 20))?;
            add_usage(c, &usage("2026-10", "ollama", "commit_message", 900, 90, 0))?;
            add_usage(c, &usage("2026-09", "anthropic", "commit_message", 1, 1, 99_999))?;
            Ok(())
        })
        .unwrap();
        let rows = db.with(|c| usage_rows(c, "2026-10")).unwrap();
        let commit = rows.iter().find(|r| r.provider == "anthropic" && r.feature == "commit_message").unwrap();
        assert_eq!((commit.requests, commit.input_tokens, commit.output_tokens, commit.cost_usd_micros), (2, 150, 15, 1500));
        assert_eq!(rows.len(), 3, "September is a month of its own");
        let api = db.with(|c| month_cost_micros(c, "2026-10", &["anthropic", "openai"])).unwrap();
        assert_eq!(api, 1520, "only the named providers, only this month");
        assert_eq!(db.with(|c| month_cost_micros(c, "2026-11", &["anthropic"])).unwrap(), 0);
    }

    #[test]
    fn seen_is_global_or_per_repository() {
        let db = Db::open_in_memory().unwrap();
        let repo = db.with(|c| repos::upsert(c, std::path::Path::new("/tmp/Übungs Repo"))).unwrap().id;
        db.with(|c| {
            mark_seen(c, None, "first_use:commit_message")?;
            mark_seen(c, None, "first_use:commit_message")?;
            mark_seen(c, Some(&repo), "repo_first")?;
            Ok(())
        })
        .unwrap();
        assert!(db.with(|c| seen(c, None, "first_use:commit_message")).unwrap());
        assert!(!db.with(|c| seen(c, None, "first_use:compose")).unwrap());
        assert!(db.with(|c| seen(c, Some(&repo), "repo_first")).unwrap());
        assert!(!db.with(|c| seen(c, None, "repo_first")).unwrap(), "a repository's confirmation is not global");
        let rows: i64 = db.with(|c| Ok(c.query_row("select count(*) from ai_preview_seen", [], |r| r.get(0))?)).unwrap();
        assert_eq!(rows, 2, "marking twice keeps one row");
        db.with(|c| Ok(c.execute("delete from repositories where id = ?1", [&repo])?)).unwrap();
        assert!(!db.with(|c| seen(c, Some(&repo), "repo_first")).unwrap(), "removed with the repository");
        assert_eq!(db.with(reset_seen).unwrap(), 1);
        assert!(!db.with(|c| seen(c, None, "first_use:commit_message")).unwrap());
    }
}
