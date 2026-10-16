//! App database (SQLite, WAL). App state only – Git remains the source of truth.
//!
//! Access is always short and synchronous through `Db::with` or `Db::tx`; never hold a
//! connection across an `.await`. The functions of the submodules take a `&Connection`
//! and, where profiles are concerned, filter by the given `profile_id` (usually that of
//! the active profile).

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{Connection, Transaction};

use crate::error::CoreResult;

pub mod activity;
pub mod agents;
pub mod ai;
pub mod app_settings;
pub mod drafts;
pub mod host_accounts;
pub mod hoster_accounts;
pub mod profile_repos;
pub mod profiles;
pub mod repo_settings;
pub mod repos;
pub mod settings;
pub mod ssh_keys;
pub mod stats_cache;
pub mod tabs;
pub mod undo;
pub mod view_state;
pub mod workspaces;

/// The schema source is db/schema.sql: the complete schema in the latest version. A new
/// database is created directly from it.
const SCHEMA: &str = include_str!("schema.sql");

/// Steps for existing databases, in order: `UPGRADES[n]` takes `user_version` from n + 1 to
/// n + 2. Each step yields exactly what schema.sql creates for new databases.
const UPGRADES: &[&str] = &[
    // Version 2: error code in the log.
    "alter table activity_log add column code text;",
    // Version 3: host accounts (replaces the never used table `integrations`).
    V3_HOSTER_ACCOUNTS,
    // Version 4: trust per repository. Whatever is already in the list has been used by the
    // user – it counts as trusted; newly opened folders are checked from now on.
    V4_REPOSITORY_TRUST,
    // Version 5: global settings (values from the active profile), repo list per profile (every
    // profile gets all known repos so nothing disappears), profile colour; the setting of the
    // removed AI feature is dropped.
    V5_PROFILE_LEVELS,
    // Collapsed merges in the graph (per repository): two columns of the view state.
    V_COLLAPSED_MERGES,
    // Statistics cache (`stats_compute`). Written with `if not exists`: schema.sql creates the
    // table for every database, including the version-1 database the upgrade test builds from it.
    STATS_CACHE,
    // Host accounts: the new host kinds, user name for Basic authentication (table rebuilt,
    // because SQLite cannot change a CHECK in place).
    HOSTER_KINDS_AND_USERNAME,
    // Undo: the group actions of 1.2 (several refs and optionally a snapshot of working directory and
    // index in one entry). Table rebuilt, because SQLite cannot change a CHECK in place.
    UNDO_GROUP_ACTIONS,
    // v1.2: AI usage and given preview confirmations; existing installations get the one-time
    // notice about the new AI features (`ai.introPending`), new ones do not (schema.sql has no insert).
    AI_USAGE_AND_PREVIEW,
    // Coding agents of the cockpit (metadata only). Written with `if not exists`, like STATS_CACHE.
    AGENTS,
];

const STATS_CACHE: &str = "
create table if not exists stats_cache (
  repository_id text not null references repositories (id) on delete cascade,
  cache_key     text not null,
  value         text not null check (json_valid(value)),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (repository_id, cache_key)
) strict;
";

const AGENTS: &str = "
create table if not exists agents (
  id            text primary key,
  repository_id text not null references repositories (id) on delete cascade,
  short_name    text not null,
  template_id   text not null,
  task          text not null default '',
  branch        text not null,
  worktree_path text not null,
  base          text not null,
  base_sha      text not null,
  unattended    integer not null default 0 check (unattended in (0, 1)),
  started_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at      text,
  exit_code     integer,
  end_reason    text check (end_reason is null or end_reason in ('exited', 'stopped', 'app_closed'))
) strict;
create unique index if not exists agents_short_name on agents (repository_id, short_name);
create index if not exists agents_repo_time on agents (repository_id, started_at desc);
";

const AI_USAGE_AND_PREVIEW: &str = "
create table if not exists ai_usage (
  month           text not null check (length(month) = 7),
  provider        text not null,
  model           text not null,
  feature         text not null,
  requests        integer not null default 0 check (requests >= 0),
  input_tokens    integer not null default 0 check (input_tokens >= 0),
  output_tokens   integer not null default 0 check (output_tokens >= 0),
  cost_usd_micros integer not null default 0 check (cost_usd_micros >= 0),
  primary key (month, provider, model, feature)
) strict, without rowid;
create table if not exists ai_preview_seen (
  repository_id text references repositories (id) on delete cascade,
  ask           text not null,
  seen_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;
create unique index if not exists ai_preview_seen_key on ai_preview_seen (coalesce(repository_id, ''), ask);
insert or ignore into app_settings (key, value) values ('ai.introPending', 'true');
";

const V_COLLAPSED_MERGES: &str = "
alter table repo_view_state add column collapsed_merges text not null default '[]' check (json_valid(collapsed_merges));
alter table repo_view_state add column collapse_all_merges integer not null default 0 check (collapse_all_merges in (0, 1));
";

const V5_PROFILE_LEVELS: &str = "
alter table profiles add column color text check (color is null or color in ('1','2','3','4','5','6','7','8'));
create table app_settings (
  key        text primary key,
  value      text not null check (json_valid(value)),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict, without rowid;
insert into app_settings (key, value)
  select key, value from settings
  where profile_id = (select id from profiles where is_active = 1)
    and key in ('theme','zoom','dateFormat','showInitials','toolbarLabels','diffMode','diffWordWrap',
                'diffIgnoreWhitespace','editorFontSize','editorTabSize','externalEditor','externalTerminal',
                'externalDiffTool','externalMergeTool','notifyOnFetch','notifyOnError');
delete from settings
  where key in ('theme','zoom','dateFormat','showInitials','toolbarLabels','diffMode','diffWordWrap',
                'diffIgnoreWhitespace','editorFontSize','editorTabSize','externalEditor','externalTerminal',
                'externalDiffTool','externalMergeTool','notifyOnFetch','notifyOnError','aiModel');
create table profile_repositories (
  profile_id     text not null references profiles (id) on delete cascade,
  repository_id  text not null references repositories (id) on delete cascade,
  is_favorite    integer not null default 0 check (is_favorite in (0, 1)),
  group_name     text,
  last_opened_at text,
  primary key (profile_id, repository_id)
) strict, without rowid;
create index profile_repositories_recent on profile_repositories (profile_id, last_opened_at desc);
create index profile_repositories_repo on profile_repositories (repository_id);
insert into profile_repositories (profile_id, repository_id, is_favorite, group_name, last_opened_at)
  select p.id, r.id, r.is_favorite, r.group_name, r.last_opened_at from profiles p cross join repositories r;
drop index if exists repositories_recent;
drop index if exists repositories_favorites;
alter table repositories drop column is_favorite;
alter table repositories drop column group_name;
alter table repositories drop column last_opened_at;
";

const V4_REPOSITORY_TRUST: &str = "
create table repository_trust (
  repository_id text primary key references repositories (id) on delete cascade,
  trusted_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict, without rowid;
insert into repository_trust (repository_id) select id from repositories;
";

const V3_HOSTER_ACCOUNTS: &str = "
drop table if exists integrations;
create table hoster_accounts (
  id             text primary key,
  profile_id     text not null references profiles (id) on delete cascade,
  kind           text not null check (kind in ('github', 'gitlab')),
  base_url       text not null,
  login          text,
  name           text,
  avatar_url     text,
  token_hint     text,
  scopes_ok      integer not null default 1 check (scopes_ok in (0, 1)),
  missing_scopes text not null default '',
  last_error     text,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;
create unique index hoster_accounts_key on hoster_accounts (profile_id, kind, base_url);
";

const HOSTER_KINDS_AND_USERNAME: &str = "
create table hoster_accounts_next (
  id             text primary key,
  profile_id     text not null references profiles (id) on delete cascade,
  kind           text not null check (kind in ('github', 'gitlab', 'gitea', 'bitbucket', 'azure_devops')),
  base_url       text not null,
  username       text,
  login          text,
  name           text,
  avatar_url     text,
  token_hint     text,
  scopes_ok      integer not null default 1 check (scopes_ok in (0, 1)),
  missing_scopes text not null default '',
  last_error     text,
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;
insert into hoster_accounts_next (id, profile_id, kind, base_url, login, name, avatar_url, token_hint, scopes_ok, missing_scopes, last_error, created_at, updated_at)
  select id, profile_id, kind, base_url, login, name, avatar_url, token_hint, scopes_ok, missing_scopes, last_error, created_at, updated_at from hoster_accounts;
drop table hoster_accounts;
alter table hoster_accounts_next rename to hoster_accounts;
create unique index hoster_accounts_key on hoster_accounts (profile_id, kind, base_url);
";

const UNDO_GROUP_ACTIONS: &str = "
create table undo_entries_next (
  id            text primary key,
  repository_id text not null references repositories (id) on delete cascade,
  worktree_path text not null default '',
  action        text not null check (action in (
                  'checkout', 'commit', 'amend', 'discard', 'delete_branch',
                  'remove_remote', 'reset', 'rebase', 'cherry_pick', 'squash',
                  'reword', 'drop', 'merge', 'revert', 'stash', 'stash_pop',
                  'compose', 'plan', 'agent_cleanup', 'range_apply', 'stack_create', 'review_fixups')),
  label         text not null default '',
  ref_name      text,
  ref_before    text,
  ref_after     text,
  head_before   text not null,
  head_after    text,
  payload       text not null default '{}' check (json_valid(payload)),
  state         text not null default 'done' check (state in ('done', 'undone')),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;
insert into undo_entries_next (id, repository_id, worktree_path, action, label, ref_name, ref_before, ref_after, head_before, head_after, payload, state, created_at)
  select id, repository_id, worktree_path, action, label, ref_name, ref_before, ref_after, head_before, head_after, payload, state, created_at from undo_entries;
drop table undo_entries;
alter table undo_entries_next rename to undo_entries;
create index undo_entries_repo_time on undo_entries (repository_id, created_at desc);
";

/// The table `integrations` as versions 1 and 2 created it (only for the migration test; new
/// databases no longer get it).
#[cfg(test)]
const OLD_INTEGRATIONS: &str = "
create table integrations (
  id           text primary key,
  profile_id   text not null references profiles (id) on delete cascade,
  provider     text not null check (provider in (
                 'github', 'github_enterprise', 'gitlab', 'gitlab_self_managed',
                 'bitbucket', 'azure_devops')),
  base_url     text not null,
  account      text not null,
  keychain_ref text not null,
  created_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;
create unique index integrations_key on integrations (profile_id, provider, base_url, account);
";

/// `user_version` of an up-to-date database.
const LATEST_VERSION: i64 = 1 + UPGRADES.len() as i64;

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    /// Opens (or creates) the database file and brings the schema up to date.
    pub fn open(path: &Path) -> CoreResult<Db> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// In-memory database (for tests).
    pub fn open_in_memory() -> CoreResult<Db> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> CoreResult<Db> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // The return value ("wal" or "memory") does not matter here.
        let _mode: String = conn.query_row("pragma journal_mode = wal", [], |r| r.get(0))?;
        migrate(&mut conn)?;
        Ok(Db { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Short access without a transaction.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> CoreResult<T>) -> CoreResult<T> {
        let conn = self.conn.lock();
        f(&conn)
    }

    /// Access inside a transaction; rolled back on `Err`.
    pub fn tx<T>(&self, f: impl FnOnce(&Transaction) -> CoreResult<T>) -> CoreResult<T> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }
}

fn migrate(conn: &mut Connection) -> CoreResult<()> {
    let version: i64 = conn.query_row("pragma user_version", [], |r| r.get(0))?;
    if version <= 0 {
        // The pragmas are in schema.sql for documentation; they are set in `init` and must
        // not run inside the transaction.
        let body: String = SCHEMA
            .lines()
            .filter(|l| !l.trim_start().to_ascii_lowercase().starts_with("pragma "))
            .collect::<Vec<_>>()
            .join("\n");
        let tx = conn.transaction()?;
        tx.execute_batch(&body)?;
        tx.pragma_update(None, "user_version", LATEST_VERSION)?;
        tx.commit()?;
        return Ok(());
    }
    for (index, sql) in UPGRADES.iter().enumerate().skip((version - 1) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as i64 + 2)?;
        tx.commit()?;
    }
    Ok(())
}

/// SQLite integer (0/1) to bool.
pub(crate) fn int_bool(v: i64) -> bool {
    v != 0
}

/// Is a rusqlite error a violated UNIQUE constraint?
pub fn is_unique_violation(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(err, _)
            if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                || err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
    )
}

/// Is a rusqlite error a violated foreign key constraint?
pub fn is_foreign_key_violation(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(err, _) if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_loads_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let db = Db::open(&path).unwrap();
        let tables: i64 = db
            .with(|c| Ok(c.query_row("select count(*) from sqlite_master where type = 'table'", [], |r| r.get(0))?))
            .unwrap();
        assert!(tables >= 14, "{tables}");
        let mode: String = db.with(|c| Ok(c.query_row("pragma journal_mode", [], |r| r.get(0))?)).unwrap();
        assert_eq!(mode, "wal");
        let fk: i64 = db.with(|c| Ok(c.query_row("pragma foreign_keys", [], |r| r.get(0))?)).unwrap();
        assert_eq!(fk, 1);
        drop(db);
        let db = Db::open(&path).unwrap();
        let v: i64 = db.with(|c| Ok(c.query_row("pragma user_version", [], |r| r.get(0))?)).unwrap();
        assert_eq!(v, LATEST_VERSION);
    }

    /// A database from version 1 (without `activity_log.code`) is upgraded on opening and
    /// keeps its rows; afterwards its schema matches that of a new database.
    #[test]
    fn existing_databases_are_upgraded_step_by_step() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("alt.db");
        let code_lines: Vec<&str> = SCHEMA.lines().filter(|l| l.trim_start().starts_with("code ") || l.contains("Since version 2")).collect();
        assert_eq!(code_lines.len(), 2, "schema.sql names the column code and its version: {code_lines:?}");
        // Version 1: without the column `code`, without the blocks of versions 3 and 4, but with `integrations`.
        let mut in_later = false;
        let mut markers = 0;
        let v1: String = SCHEMA
            .lines()
            .filter(|l| {
                let later = l.starts_with("-- Since version ");
                if later && (l.ends_with("begin") || l.ends_with("end")) {
                    in_later = l.ends_with("begin");
                    markers += 1;
                    return false;
                }
                !in_later && !code_lines.contains(l) && !l.trim_start().to_ascii_lowercase().starts_with("pragma ")
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(markers % 2, 0, "every block in schema.sql has a begin and an end");
        assert!(markers >= 12, "schema.sql brackets the blocks of versions 3, 4, 5 and the collapsed merges");
        assert!(!v1.contains("collapsed_merges") && !v1.contains("collapse_all_merges"));
        assert!(!v1.contains("hoster_accounts") && !v1.contains("repository_trust"));
        assert!(!v1.contains("create table app_settings") && !v1.contains("create table profile_repositories"));
        let v1 = format!("{v1}\n{OLD_INTEGRATIONS}");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&v1).unwrap();
            // Up to version 4, favourite, group and last opened were stored on the repository itself.
            conn.execute_batch(
                "alter table repositories add column is_favorite integer not null default 0 check (is_favorite in (0, 1));
                 alter table repositories add column group_name text;
                 alter table repositories add column last_opened_at text;
                 create index repositories_recent on repositories (last_opened_at desc);
                 create index repositories_favorites on repositories (is_favorite) where is_favorite = 1;",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute("insert into activity_log (scope, description, command, exit_code) values ('application', 'git x', 'git x', 1)", []).unwrap();
            conn.execute("insert into profiles (id, name, author_name, author_email, is_active) values ('p', 'P', '', '', 1)", []).unwrap();
            conn.execute("insert into workspaces (id, profile_id, name) values ('w', 'p', 'Alt')", []).unwrap();
            conn.execute("insert into profiles (id, name, author_name, author_email, is_active) values ('q', 'Q', '', '', 0)", []).unwrap();
            conn.execute(
                "insert into repositories (id, path, path_key, is_favorite, group_name, last_opened_at) values ('r', '/alt/repo', '/alt/repo', 1, 'Kunden', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute("insert into repo_view_state (repository_id, hidden_refs) values ('r', '[\"refs/heads/alt\"]')", []).unwrap();
            conn.execute_batch(
                "insert into settings (profile_id, key, value) values ('p', 'theme', '\"light\"'), ('p', 'autoFetchMinutes', '5'),
                   ('q', 'theme', '\"dark\"'), ('q', 'aiModel', '\"x\"');",
            )
            .unwrap();
            conn.execute("insert into integrations (id, profile_id, provider, base_url, account, keychain_ref) values ('i', 'p', 'bitbucket', 'https://bitbucket.org', 'x', 'ref')", []).unwrap();
        }
        let columns = |db: &Db, table: &str| -> Vec<String> {
            db.with(|c| {
                let mut stmt = c.prepare(&format!("select name from pragma_table_info('{table}') order by cid"))?;
                let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(names)
            })
            .unwrap()
        };
        let db = Db::open(&path).unwrap();
        let v: i64 = db.with(|c| Ok(c.query_row("pragma user_version", [], |r| r.get(0))?)).unwrap();
        assert_eq!(v, LATEST_VERSION);
        let page = db.with(|c| activity::page(c, crate::model::ActivityScope::App, None, None, 10)).unwrap();
        assert_eq!(page.entries.len(), 1, "the old row is still there");
        assert_eq!((page.entries[0].command.as_str(), page.entries[0].code), ("git x", None));
        let kept: String = db.with(|c| Ok(c.query_row("select name from workspaces where id = 'w'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(kept, "Alt");
        let fresh = Db::open_in_memory().unwrap();
        for table in ["activity_log", "workspaces", "workspace_repositories", "hoster_accounts", "repositories", "repository_trust", "profiles", "settings", "app_settings", "profile_repositories", "repo_view_state", "stats_cache", "ai_usage", "ai_preview_seen", "agents"] {
            assert_eq!(columns(&db, table), columns(&fresh, table), "{table}");
        }
        // The view state of before keeps its fields and gets the new ones with their defaults.
        let view = db.with(|c| view_state::get(c, "r")).unwrap();
        assert_eq!(view.hidden_refs, vec!["refs/heads/alt"]);
        assert!(view.collapsed_merges.is_empty() && !view.collapse_all_merges);
        // Version 5: every profile lists the known repos with favourite and group; the theme moves
        // from the active profile into the global table, the AI setting is gone.
        let listed: Vec<(String, i64, Option<String>, Option<String>)> = db
            .with(|c| {
                let mut s = c.prepare(
                    "select profile_id, is_favorite, group_name, last_opened_at from profile_repositories where repository_id = 'r' order by profile_id",
                )?;
                let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap();
        let stamp = Some("2026-01-01T00:00:00Z".to_string());
        assert_eq!(listed, vec![("p".into(), 1, Some("Kunden".into()), stamp.clone()), ("q".into(), 1, Some("Kunden".into()), stamp)]);
        let theme: String = db.with(|c| Ok(c.query_row("select value from app_settings where key = 'theme'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(theme, "\"light\"");
        let left: i64 = db.with(|c| Ok(c.query_row("select count(*) from settings where key in ('theme', 'aiModel')", [], |r| r.get(0))?)).unwrap();
        assert_eq!(left, 0);
        let kept: String = db
            .with(|c| Ok(c.query_row("select value from settings where profile_id = 'p' and key = 'autoFetchMinutes'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(kept, "5");
        // Version 4: what was already in the list counts as trusted; new entries do not.
        let (old, new) = db
            .with(|c| {
                let old = repos::require(c, "r")?.trusted;
                let new = repos::upsert(c, std::path::Path::new("/neu/repo"))?.trusted;
                Ok((old, new))
            })
            .unwrap();
        assert!(old, "existing repositories stay usable");
        assert!(!new, "new ones must be checked first");
        assert!(!columns(&db, "hoster_accounts").is_empty(), "the new table exists");
        // The old table is gone, in the upgraded as well as in the new database.
        assert!(columns(&db, "integrations").is_empty());
        assert!(columns(&fresh, "integrations").is_empty());
        let indexes = |db: &Db| -> Vec<String> {
            db.with(|c| {
                let mut stmt = c.prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name")?;
                let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(names)
            })
            .unwrap()
        };
        assert_eq!(indexes(&db), indexes(&fresh), "the same indexes");
        // v1.2: an upgraded database announces the AI features once; a new installation does not.
        let intro = |db: &Db| -> i64 {
            db.with(|c| Ok(c.query_row("select count(*) from app_settings where key = 'ai.introPending' and value = 'true'", [], |r| r.get(0))?)).unwrap()
        };
        assert_eq!(intro(&db), 1, "after the upgrade");
        assert_eq!(intro(&fresh), 0, "not on a new installation");
        // Every undo action the core knows can be stored in the upgraded database.
        for (index, action) in crate::undo::UndoAction::ALL.iter().enumerate() {
            db.with(|c| {
                c.execute("insert into undo_entries (id, repository_id, action, head_before) values (?1, 'r', ?2, 'refs/heads/main')", rusqlite::params![format!("a{index}"), action.as_str()])?;
                Ok(())
            })
            .unwrap();
        }
        // Opening a second time changes nothing more.
        drop(db);
        Db::open(&path).unwrap();
    }

    /// The statistics cache step creates exactly the table schema.sql has, and may run twice.
    #[test]
    fn the_stats_cache_upgrade_matches_the_schema() {
        assert!(UPGRADES.contains(&STATS_CACHE), "the step is part of UPGRADES");
        let columns = |db: &Db| -> Vec<(String, String, i64)> {
            db.with(|c| {
                let mut stmt = c.prepare("select name, type, pk from pragma_table_info('stats_cache') order by cid")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap()
        };
        let fresh = Db::open_in_memory().unwrap();
        let expected = columns(&fresh);
        assert_eq!(expected.len(), 4, "{expected:?}");
        let upgraded = Db::open_in_memory().unwrap();
        upgraded
            .with(|c| {
                c.execute_batch("drop table stats_cache;")?;
                c.execute_batch(STATS_CACHE)?;
                c.execute_batch(STATS_CACHE)?;
                Ok(())
            })
            .unwrap();
        assert_eq!(columns(&upgraded), expected);
    }

    /// The agents step creates exactly the table and indexes schema.sql has, and may run twice.
    #[test]
    fn the_agents_upgrade_matches_the_schema() {
        // `contains`, not `last()`: later packages append their own steps behind this one.
        assert!(UPGRADES.contains(&AGENTS), "the step is part of UPGRADES");
        // Columns (name, type, notnull, pk) and index names.
        type Shape = (Vec<(String, String, i64, i64)>, Vec<String>);
        let shape = |db: &Db| -> Shape {
            db.with(|c| {
                let mut stmt = c.prepare("select name, type, \"notnull\", pk from pragma_table_info('agents') order by cid")?;
                let columns = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                let mut stmt = c.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'agents' and name not like 'sqlite_%' order by name")?;
                let indexes = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((columns, indexes))
            })
            .unwrap()
        };
        let fresh = Db::open_in_memory().unwrap();
        let expected = shape(&fresh);
        assert_eq!(expected.0.len(), 14, "{expected:?}");
        assert_eq!(expected.1, vec!["agents_repo_time".to_string(), "agents_short_name".to_string()]);
        let upgraded = Db::open_in_memory().unwrap();
        upgraded
            .with(|c| {
                c.execute_batch("drop table agents;")?;
                c.execute_batch(AGENTS)?;
                c.execute_batch(AGENTS)?;
                Ok(())
            })
            .unwrap();
        assert_eq!(shape(&upgraded), expected);
    }

    /// The AI step creates exactly what schema.sql has, may run twice, and is part of UPGRADES.
    #[test]
    fn the_ai_step_matches_the_schema_and_may_run_twice() {
        assert!(UPGRADES.contains(&AI_USAGE_AND_PREVIEW), "the step is part of UPGRADES");
        let shape = |db: &Db, table: &str| -> Vec<(String, String, i64, i64)> {
            db.with(|c| {
                let mut stmt = c.prepare(&format!("select name, type, \"notnull\", pk from pragma_table_info('{table}') order by cid"))?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap()
        };
        let fresh = Db::open_in_memory().unwrap();
        let upgraded = Db::open_in_memory().unwrap();
        upgraded
            .with(|c| {
                c.execute_batch("drop table ai_usage; drop table ai_preview_seen;")?;
                c.execute_batch(AI_USAGE_AND_PREVIEW)?;
                c.execute_batch(AI_USAGE_AND_PREVIEW)?;
                Ok(())
            })
            .unwrap();
        for table in ["ai_usage", "ai_preview_seen"] {
            assert!(!shape(&fresh, table).is_empty(), "{table} exists");
            assert_eq!(shape(&upgraded, table), shape(&fresh, table), "{table}");
        }
        let pending: i64 = upgraded.with(|c| Ok(c.query_row("select count(*) from app_settings where key = 'ai.introPending'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(pending, 1, "running the step twice keeps one entry");
    }

    #[test]
    fn the_upgrade_moves_exactly_the_global_keys() {
        // Settings added after version 5 never existed at the profile level.
        const ADDED_LATER: [&str; 2] = ["checkForUpdates", "agentTemplates"];
        for key in app_settings::GLOBAL_KEYS.into_iter().filter(|key| !ADDED_LATER.contains(key)) {
            assert_eq!(V5_PROFILE_LEVELS.matches(&format!("'{key}'")).count(), 2, "{key} is missing from the upgrade (copy and delete)");
        }
    }

    /// The host accounts upgrade keeps existing rows, adds `username` and widens the list of kinds –
    /// independent of the version number it ends up with.
    #[test]
    fn the_hoster_upgrade_keeps_accounts_and_accepts_the_new_kinds() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("pragma foreign_keys = on; create table profiles (id text primary key) strict; insert into profiles (id) values ('p');").unwrap();
        conn.execute_batch(V3_HOSTER_ACCOUNTS).unwrap();
        conn.execute("insert into hoster_accounts (id, profile_id, kind, base_url, login, token_hint) values ('h', 'p', 'gitlab', 'https://gitlab.com', 'lena', '…abcd')", []).unwrap();
        assert!(conn.execute("insert into hoster_accounts (id, profile_id, kind, base_url) values ('x', 'p', 'gitea', 'https://codeberg.org')", []).is_err(), "before: only GitHub and GitLab");
        conn.execute_batch(HOSTER_KINDS_AND_USERNAME).unwrap();
        let kept: (String, String, Option<String>, Option<String>, Option<String>) = conn
            .query_row("select kind, base_url, login, token_hint, username from hoster_accounts where id = 'h'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap();
        assert_eq!(kept, ("gitlab".into(), "https://gitlab.com".into(), Some("lena".into()), Some("…abcd".into()), None));
        for (id, kind) in [("g", "gitea"), ("b", "bitbucket"), ("a", "azure_devops")] {
            conn.execute("insert into hoster_accounts (id, profile_id, kind, base_url, username) values (?1, 'p', ?2, ?3, 'lena')", rusqlite::params![id, kind, format!("https://{kind}.example")]).unwrap();
        }
        assert!(conn.execute("insert into hoster_accounts (id, profile_id, kind, base_url) values ('s', 'p', 'svn', 'https://svn.example')", []).is_err());
        let unique: i64 = conn.query_row("select count(*) from sqlite_master where type = 'index' and name = 'hoster_accounts_key'", [], |r| r.get(0)).unwrap();
        assert_eq!(unique, 1, "the unique index is back");
        assert!(conn.execute("insert into hoster_accounts (id, profile_id, kind, base_url) values ('h2', 'p', 'gitlab', 'https://gitlab.com')", []).is_err(), "and works");
    }

    /// `undo_entries` as versions 1 to 8 created it (only for this test).
    const OLD_UNDO_ENTRIES: &str = "
create table undo_entries (
  id            text primary key,
  repository_id text not null references repositories (id) on delete cascade,
  worktree_path text not null default '',
  action        text not null check (action in (
                  'checkout', 'commit', 'amend', 'discard', 'delete_branch',
                  'remove_remote', 'reset', 'rebase', 'cherry_pick', 'squash',
                  'reword', 'drop', 'merge', 'revert', 'stash', 'stash_pop')),
  label         text not null default '',
  ref_name      text,
  ref_before    text,
  ref_after     text,
  head_before   text not null,
  head_after    text,
  payload       text not null default '{}' check (json_valid(payload)),
  state         text not null default 'done' check (state in ('done', 'undone')),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) strict;
create index undo_entries_repo_time on undo_entries (repository_id, created_at desc);
";

    /// The undo upgrade keeps existing entries and accepts the group actions of 1.2 – independent of the
    /// version number it ends up with.
    #[test]
    fn the_undo_upgrade_keeps_entries_and_accepts_the_group_actions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("pragma foreign_keys = on; create table repositories (id text primary key) strict; insert into repositories (id) values ('r');").unwrap();
        conn.execute_batch(OLD_UNDO_ENTRIES).unwrap();
        conn.execute(
            "insert into undo_entries (id, repository_id, action, label, ref_name, ref_before, ref_after, head_before, head_after, payload, state, created_at)
             values ('u1', 'r', 'commit', 'Undo commit', 'refs/heads/main', 'aaa', 'bbb', 'refs/heads/main', 'refs/heads/main', '{\"x\":1}', 'undone', '2026-10-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let insert = |id: &str, action: &str| conn.execute("insert into undo_entries (id, repository_id, action, head_before) values (?1, 'r', ?2, 'refs/heads/main')", rusqlite::params![id, action]);
        assert!(insert("vorher", "compose").is_err(), "before: no group actions");
        assert!(UPGRADES.contains(&UNDO_GROUP_ACTIONS), "the step is part of UPGRADES");
        conn.execute_batch(UNDO_GROUP_ACTIONS).unwrap();
        let kept: (String, String, String, String, String, String) = conn
            .query_row("select action, label, ref_after, payload, state, created_at from undo_entries where id = 'u1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .unwrap();
        assert_eq!(kept, ("commit".into(), "Undo commit".into(), "bbb".into(), "{\"x\":1}".into(), "undone".into(), "2026-10-01T00:00:00.000Z".into()));
        for (index, action) in ["compose", "plan", "agent_cleanup", "range_apply", "stack_create", "review_fixups"].iter().enumerate() {
            insert(&format!("g{index}"), action).unwrap();
        }
        assert!(insert("falsch", "bogus").is_err(), "unknown actions stay forbidden");
        assert!(conn.execute("insert into undo_entries (id, repository_id, action, head_before) values ('fk', 'gibt-es-nicht', 'plan', 'x')", []).is_err(), "the foreign key holds");
        let index: i64 = conn.query_row("select count(*) from sqlite_master where type = 'index' and name = 'undo_entries_repo_time'", [], |r| r.get(0)).unwrap();
        assert_eq!(index, 1);
    }

    #[test]
    fn ssh_keys_and_host_accounts() {
        use crate::model::HostAccountKind;
        let db = Db::open_in_memory().unwrap();
        let profile = db
            .tx(|tx| {
                let id = profiles::insert(tx, "P", "", "", false)?;
                profiles::set_active(tx, &id)?;
                Ok(id)
            })
            .unwrap();

        let (a, b) = db
            .tx(|tx| {
                let a = ssh_keys::insert(tx, &profile, "Arbeit", "/k/id_a", "/k/id_a.pub")?;
                let b = ssh_keys::insert(tx, &profile, "Privat", "/k/id_b", "/k/id_b.pub")?;
                ssh_keys::set_default(tx, &profile, Some(&a))?;
                ssh_keys::set_default(tx, &profile, Some(&b))?;
                Ok((a, b))
            })
            .unwrap();
        let keys = db.with(|c| ssh_keys::list(c, &profile)).unwrap();
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().find(|k| k.id == b).unwrap().is_default);
        assert!(!keys.iter().find(|k| k.id == a).unwrap().is_default);
        db.with(|c| ssh_keys::set_default(c, &profile, None)).unwrap();
        db.with(|c| ssh_keys::delete(c, &profile, &a)).unwrap();
        let keys = db.with(|c| ssh_keys::list(c, &profile)).unwrap();
        assert_eq!(keys.len(), 1);
        assert!(!keys[0].is_default);
        assert!(db.with(|c| ssh_keys::get(c, &profile, &a)).unwrap().is_none());

        let first = db
            .with(|c| host_accounts::upsert(c, &profile, "github.com", "anna", HostAccountKind::Password, "ref-1"))
            .unwrap();
        let again = db
            .with(|c| host_accounts::upsert(c, &profile, "github.com", "anna", HostAccountKind::Password, "ref-2"))
            .unwrap();
        assert_eq!(first, again, "same host and user = the same entry");
        db.with(|c| host_accounts::upsert(c, &profile, "/k/id_b", "", HostAccountKind::Passphrase, "ref-3")).unwrap();
        let rows = db.with(|c| host_accounts::list(c, &profile)).unwrap();
        assert_eq!(rows.len(), 2);
        let pw = rows.iter().find(|r| r.host == "github.com").unwrap();
        assert_eq!(pw.keychain_ref, "ref-2");
        assert_eq!(pw.to_model().kind, HostAccountKind::Password);
        let removed = db.with(|c| host_accounts::delete_all(c, &profile)).unwrap();
        assert_eq!(removed.len(), 2);
        assert!(db.with(|c| host_accounts::list(c, &profile)).unwrap().is_empty());
    }

    #[test]
    fn constraints_from_schema_hold() {
        let db = Db::open_in_memory().unwrap();
        // The index profiles_one_active prevents two active profiles.
        let err = db
            .with(|c| {
                c.execute("insert into profiles (id, name, author_name, author_email, is_active) values ('a', 'A', '', '', 1)", [])?;
                c.execute("insert into profiles (id, name, author_name, author_email, is_active) values ('b', 'B', '', '', 1)", [])?;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::Io);
        // The same path written differently yields the same entry.
        let (one, two) = db
            .with(|c| {
                let one = repos::upsert(c, std::path::Path::new("/tmp/Projekt/"))?;
                let two = repos::upsert(c, std::path::Path::new("/tmp/Projekt"))?;
                Ok((one, two))
            })
            .unwrap();
        assert_eq!(one.id, two.id);
    }
}
