//! Table `hoster_accounts`: connected accounts at the hosts (without the token – that lives in
//! the keychain under `hoster:<id>`). The kind is stored by its name (`HostKind::as_str`); a name
//! the app does not know is an error, never a silent fallback.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::CoreResult;
use crate::model::{HostKind, HostUser, HosterAccount};
use crate::util;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HosterAccountRow {
    pub id: String,
    pub profile_id: String,
    pub kind: HostKind,
    /// Address of the web UI without a trailing slash.
    pub base_url: String,
    /// User name for Basic authentication (Bitbucket); not secret.
    pub username: Option<String>,
    pub login: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub token_hint: Option<String>,
    pub scopes_ok: bool,
    pub missing_scopes: Vec<String>,
    pub last_error: Option<String>,
}

impl HosterAccountRow {
    pub fn to_model(&self) -> HosterAccount {
        HosterAccount {
            id: self.id.clone(),
            kind: self.kind,
            base_url: self.base_url.clone(),
            username: self.username.clone(),
            user: self.login.clone().map(|login| HostUser { login, name: self.name.clone(), avatar_url: self.avatar_url.clone() }),
            token_hint: self.token_hint.clone(),
            scopes_ok: self.scopes_ok,
            missing_scopes: self.missing_scopes.clone(),
            last_error: self.last_error.clone(),
        }
    }
}

pub fn kind_to_db(kind: HostKind) -> &'static str {
    kind.as_str()
}

fn from_row(r: &Row) -> rusqlite::Result<HosterAccountRow> {
    let stored: String = r.get("kind")?;
    let kind = HostKind::parse(&stored).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, format!("unknown host kind “{stored}”").into())
    })?;
    let missing: String = r.get("missing_scopes")?;
    Ok(HosterAccountRow {
        id: r.get("id")?,
        profile_id: r.get("profile_id")?,
        kind,
        base_url: r.get("base_url")?,
        username: r.get("username")?,
        login: r.get("login")?,
        name: r.get("name")?,
        avatar_url: r.get("avatar_url")?,
        token_hint: r.get("token_hint")?,
        scopes_ok: super::int_bool(r.get("scopes_ok")?),
        missing_scopes: missing.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect(),
        last_error: r.get("last_error")?,
    })
}

const COLUMNS: &str = "id, profile_id, kind, base_url, username, login, name, avatar_url, token_hint, scopes_ok, missing_scopes, last_error";

/// Accounts of the profile: GitHub before GitLab, then by address.
pub fn list(conn: &Connection, profile_id: &str) -> CoreResult<Vec<HosterAccountRow>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from hoster_accounts where profile_id = ?1 order by kind, base_url"))?;
    let rows = stmt.query_map([profile_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, profile_id: &str, id: &str) -> CoreResult<Option<HosterAccountRow>> {
    Ok(conn
        .query_row(&format!("select {COLUMNS} from hoster_accounts where profile_id = ?1 and id = ?2"), params![profile_id, id], from_row)
        .optional()?)
}

/// What becomes known about an account when connecting or checking it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccountFacts {
    pub login: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub scopes_ok: bool,
    pub missing_scopes: Vec<String>,
}

/// Creates the account or replaces the details of the existing one (same kind and address).
/// Returns the row; the ID of an existing account is kept.
pub fn upsert(conn: &Connection, profile_id: &str, kind: HostKind, base_url: &str, username: Option<&str>, token_hint: &str, facts: &AccountFacts) -> CoreResult<HosterAccountRow> {
    let now = util::now_iso();
    conn.execute(
        "insert into hoster_accounts (id, profile_id, kind, base_url, username, login, name, avatar_url, token_hint, scopes_ok, missing_scopes, last_error, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, null, ?12, ?12)
         on conflict (profile_id, kind, base_url) do update set
           username = excluded.username, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, token_hint = excluded.token_hint,
           scopes_ok = excluded.scopes_ok, missing_scopes = excluded.missing_scopes, last_error = null, updated_at = excluded.updated_at",
        params![
            util::new_id(),
            profile_id,
            kind_to_db(kind),
            base_url,
            username,
            facts.login,
            facts.name,
            facts.avatar_url,
            token_hint,
            facts.scopes_ok as i64,
            facts.missing_scopes.join(","),
            now
        ],
    )?;
    Ok(conn.query_row(
        &format!("select {COLUMNS} from hoster_accounts where profile_id = ?1 and kind = ?2 and base_url = ?3"),
        params![profile_id, kind_to_db(kind), base_url],
        from_row,
    )?)
}

/// Updates the details after a successful check.
pub fn set_facts(conn: &Connection, id: &str, facts: &AccountFacts) -> CoreResult<()> {
    conn.execute(
        "update hoster_accounts set login = ?2, name = ?3, avatar_url = ?4, scopes_ok = ?5, missing_scopes = ?6, last_error = null, updated_at = ?7 where id = ?1",
        params![id, facts.login, facts.name, facts.avatar_url, facts.scopes_ok as i64, facts.missing_scopes.join(","), util::now_iso()],
    )?;
    Ok(())
}

/// Remembers the last error of the account (`None` clears it). Returns whether anything changed.
pub fn set_last_error(conn: &Connection, id: &str, error: Option<&str>) -> CoreResult<bool> {
    let changed = conn.execute(
        "update hoster_accounts set last_error = ?2, updated_at = ?3 where id = ?1 and last_error is not ?2",
        params![id, error, util::now_iso()],
    )?;
    Ok(changed > 0)
}

pub fn delete(conn: &Connection, profile_id: &str, id: &str) -> CoreResult<bool> {
    Ok(conn.execute("delete from hoster_accounts where profile_id = ?1 and id = ?2", params![profile_id, id])? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db_with_profile() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            c.execute("insert or ignore into profiles (id, name, author_name, author_email, is_active) values ('p', 'P', '', '', 0)", [])?;
            Ok(())
        })
        .unwrap();
        db
    }

    #[test]
    fn every_host_kind_is_stored_by_name_and_read_back() {
        let db = db_with_profile();
        let facts = AccountFacts { login: Some("lena".into()), scopes_ok: true, ..AccountFacts::default() };
        for kind in HostKind::ALL.iter().copied() {
            let base = format!("https://{}.example", kind.as_str());
            let row = db.with(|c| upsert(c, "p", kind, &base, Some("lena@example.org"), "…abcd", &facts)).unwrap();
            assert_eq!((row.kind, row.base_url.as_str(), row.username.as_deref()), (kind, base.as_str(), Some("lena@example.org")));
            let stored: String = db.with(|c| Ok(c.query_row("select kind from hoster_accounts where id = ?1", [&row.id], |r| r.get(0))?)).unwrap();
            assert_eq!(stored, kind.as_str());
            // Reconnecting replaces the user name, the ID stays.
            let again = db.with(|c| upsert(c, "p", kind, &base, None, "…wxyz", &facts)).unwrap();
            assert_eq!((again.id.as_str(), again.username.as_deref()), (row.id.as_str(), None));
            assert_eq!(again.to_model().username, None);
        }
        assert_eq!(db.with(|c| list(c, "p")).unwrap().len(), HostKind::ALL.len());
    }

    #[test]
    fn an_unknown_kind_is_an_error_not_github() {
        let db = db_with_profile();
        db.with(|c| {
            // Only possible from outside (older or newer app, manual edit): the CHECK is bypassed here.
            c.execute_batch("pragma ignore_check_constraints = on;")?;
            c.execute("insert into hoster_accounts (id, profile_id, kind, base_url) values ('x', 'p', 'svn', 'https://svn.example')", [])?;
            c.execute_batch("pragma ignore_check_constraints = off;")?;
            Ok(())
        })
        .unwrap();
        let error = db.with(|c| list(c, "p")).unwrap_err();
        assert!(error.message.contains("unknown host kind “svn”"), "{}", error.message);
        assert!(db.with(|c| get(c, "p", "x")).is_err(), "neither as GitHub nor silently skipped");
        // The CHECK itself refuses unknown names.
        let refused = db.with(|c| Ok(c.execute("insert into hoster_accounts (id, profile_id, kind, base_url) values ('y', 'p', 'svn', 'https://svn.example')", [])?));
        assert!(refused.is_err());
    }
}
