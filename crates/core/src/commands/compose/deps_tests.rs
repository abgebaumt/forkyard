//! "Doesn't build on its own": the requirements `compose_units` reports, on realistic projects.
//! Every expectation is written down by hand from what a compiler or test runner would need – the
//! oracle is the project, not the rule code.

use std::collections::BTreeMap;

use super::deps::{contains_word, defined_name, tested_sources};
use super::units_tests::open;
use super::*;
use crate::testkit::TestRepo;

/// `path#<hunk>` or `path#file` for a unit ID (the token cut off).
fn short(id: &str) -> String {
    id.rsplit_once('@').map_or(id, |(head, _)| head).to_string()
}

/// Every unit with requirements, as short IDs.
async fn requirements_of(repo: &TestRepo) -> BTreeMap<String, Vec<String>> {
    let (tc, id) = open(repo).await;
    let state = compose_units(&tc, id).await.unwrap();
    state
        .units
        .iter()
        .filter(|unit| !unit.requires.is_empty())
        .map(|unit| {
            let mut needs: Vec<String> = unit.requires.iter().map(|id| short(id)).collect();
            needs.sort();
            (short(&unit.id), needs)
        })
        .collect()
}

fn expected(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
    pairs.iter().map(|(unit, needs)| (unit.to_string(), needs.iter().map(|need| need.to_string()).collect())).collect()
}

const STAFF_TABLE: &str = r#"import {Table,Column} from "../../ui/table"
import {t} from "../../i18n"
import type {StaffUser} from "./types"

/** All staff members with role and last login. */
export function StaffTable({ users }: { users: StaffUser[] }) {
  const sorted = [...users].sort((a, b) => a.name.localeCompare(b.name));
  const empty = sorted.length === 0;
  if (empty) {
    return <p className="empty">{t("staff.none")}</p>;
  }
  return (
    <Table rows={sorted}>
      <Column title={t("staff.name")} value={(u) => u.name} />
      <Column title={t("staff.email")} value={(u) => u.email} />
      <Column title={t("staff.role")} value={(u) => u.role} />
      <Column title={t("staff.lastLogin")} value={(u) => u.lastLogin} />
    </Table>
  );
}
"#;

const EXPIRY: &str = r#"import { addDays, endOfDay } from "../../time";
import { formatDate } from "./format";

/** When an invitation sent at `sentAt` stops working. */
export function inviteExpiry(sentAt: Date): Date {
  const days = addDays(sentAt, 7);
  return endOfDay(days);
}

export function expiryLabel(sentAt: Date): string {
  return formatDate(inviteExpiry(sentAt));
}
"#;

const EXPIRY_TEST: &str = r#"import { describe, expect, it } from "vitest";
import { inviteExpiry } from "./expiry";

describe("inviteExpiry", () => {
  it("is a week later", () => {
    expect(inviteExpiry(new Date("2026-03-01T10:00:00Z")).getUTCDate()).toBe(8);
  });
});
"#;

/// The admin portal of the prototype: a new MFA helper and stylesheet used by the staff table,
/// a fixed expiry with its test, translations, a changelog and a lock file.
fn admin_portal() -> TestRepo {
    let repo = TestRepo::with_commit();
    repo.write_file("src/admin/accounts/StaffTable.tsx", STAFF_TABLE);
    repo.write_file("src/admin/accounts/types.ts", "export interface StaffUser { name: string; email: string; role: string; lastLogin: string; mfa?: { confirmedAt?: string } }\n");
    repo.write_file("src/portal/invite/expiry.ts", EXPIRY);
    repo.write_file("src/portal/invite/expiry.test.ts", EXPIRY_TEST);
    repo.write_file("src/portal/invite/format.ts", "export function formatDate(date: Date): string {\n  return date.toLocaleDateString(\"de-DE\");\n}\n");
    repo.write_file("src/i18n/de.json", "{\n  \"staff\": {\n    \"lastLogin\": \"Letzte Anmeldung\",\n    \"role\": \"Rolle\"\n  }\n}\n");
    repo.write_file("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## 1.0.0\n\n- First release.\n");
    repo.write_file("package-lock.json", "{\n  \"lockfileVersion\": 3\n}\n");
    repo.commit("Admin portal");

    // New helper with a new name, and a new stylesheet.
    repo.write_file(
        "src/admin/accounts/mfa.ts",
        "import type { StaffUser } from \"./types\";\n\nexport type MfaStatus = \"active\" | \"pending\" | \"off\";\n\nexport function mfaStatus(user: StaffUser): MfaStatus {\n  if (!user.mfa) return \"off\";\n  return user.mfa.confirmedAt ? \"active\" : \"pending\";\n}\n",
    );
    repo.write_file("src/admin/accounts/staff.css", ".mfa-badge { font-weight: 600; }\n");
    // Hunk 0: the imports, formatted, plus the stylesheet. Hunk 1: the new column using mfaStatus.
    let table = STAFF_TABLE
        .replace(
            "import {Table,Column} from \"../../ui/table\"\nimport {t} from \"../../i18n\"\nimport type {StaffUser} from \"./types\"\n",
            "import { Column, Table } from \"../../ui/table\";\nimport { t } from \"../../i18n\";\nimport type { StaffUser } from \"./types\";\nimport \"./staff.css\";\n",
        )
        .replace(
            "      <Column title={t(\"staff.lastLogin\")} value={(u) => u.lastLogin} />\n",
            "      <Column title={t(\"staff.lastLogin\")} value={(u) => u.lastLogin} />\n      <Column title={t(\"staff.mfa\")} value={(u) => mfaStatus(u)} />\n",
        );
    repo.write_file("src/admin/accounts/StaffTable.tsx", table);
    // The fix and its test; the label keeps using the existing formatDate.
    repo.write_file(
        "src/portal/invite/expiry.ts",
        EXPIRY.replace("  const days = addDays(sentAt, 7);\n  return endOfDay(days);\n", "  // Seven full days from sending, not seven calendar days.\n  return new Date(sentAt.getTime() + 7 * 24 * 60 * 60 * 1000);\n"),
    );
    repo.write_file(
        "src/portal/invite/expiry.test.ts",
        EXPIRY_TEST.replace(
            "  });\n});\n",
            "  });\n\n  it(\"expires exactly 168 hours after sending\", () => {\n    const sent = new Date(\"2026-03-28T23:30:00+01:00\");\n    expect(inviteExpiry(sent).toISOString()).toBe(\"2026-04-04T21:30:00.000Z\");\n  });\n});\n",
        ),
    );
    repo.write_file("src/i18n/de.json", "{\n  \"staff\": {\n    \"lastLogin\": \"Letzte Anmeldung\",\n    \"mfa\": \"Zwei-Faktor\",\n    \"role\": \"Rolle\"\n  }\n}\n");
    // Prose that names the new function is no code that needs it.
    repo.write_file("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- Admin: MFA column (mfaStatus in mfa.ts).\n\n## 1.0.0\n\n- First release.\n");
    repo.write_file("package-lock.json", "{\n  \"lockfileVersion\": 3,\n  \"packages\": {}\n}\n");
    repo
}

#[tokio::test]
async fn a_typescript_project_new_helper_stylesheet_and_the_test_of_a_fix() {
    let repo = admin_portal();
    assert_eq!(
        requirements_of(&repo).await,
        expected(&[
            // `import "./staff.css"` – the stylesheet is new.
            ("src/admin/accounts/StaffTable.tsx#0", &["src/admin/accounts/staff.css#file"]),
            // `mfaStatus(u)` – defined only in the new mfa.ts.
            ("src/admin/accounts/StaffTable.tsx#1", &["src/admin/accounts/mfa.ts#file"]),
            // The test of expiry.ts needs the fix in expiry.ts.
            ("src/portal/invite/expiry.test.ts#0", &["src/portal/invite/expiry.ts#0"]),
        ]),
        "formatDate exists in HEAD, translations, changelog and lock file need nothing"
    );
}

#[tokio::test]
async fn a_python_package_relative_and_absolute_imports_of_a_new_module() {
    let repo = TestRepo::with_commit();
    repo.write_file("app/__init__.py", "");
    repo.write_file("app/views.py", "from flask import render_template\n\nfrom .models import Article\n\n\ndef article(id):\n    return render_template(\"article.html\", article=Article.get(id))\n");
    repo.write_file("app/models.py", "class Article:\n    @staticmethod\n    def get(id):\n        return Article()\n");
    repo.commit("Blog");

    repo.write_file("app/slugify.py", "import re\n\n\ndef make_slug(title):\n    return re.sub(r\"[^a-z0-9]+\", \"-\", title.lower()).strip(\"-\")\n");
    repo.write_file(
        "app/views.py",
        "from flask import render_template\n\nfrom .models import Article\nfrom .slugify import make_slug\n\n\ndef article(id):\n    return render_template(\"article.html\", article=Article.get(id))\n\n\ndef article_link(article):\n    return \"/a/\" + make_slug(article.title)\n",
    );
    repo.write_file("tests/test_slugify.py", "from app.slugify import make_slug\n\n\ndef test_umlauts_are_dropped():\n    assert make_slug(\"Größe & Gewicht\") == \"gr-e-gewicht\"\n");
    // Imports an existing module only.
    repo.write_file("app/models.py", "import datetime\n\n\nclass Article:\n    @staticmethod\n    def get(id):\n        return Article()\n");

    assert_eq!(
        requirements_of(&repo).await,
        expected(&[("app/views.py#0", &["app/slugify.py#file"]), ("tests/test_slugify.py#file", &["app/slugify.py#file"])]),
        "`import datetime` in models.py is no new module"
    );
}

#[tokio::test]
async fn a_rust_crate_new_module_its_function_and_a_test_file() {
    let repo = TestRepo::with_commit();
    repo.write_file("Cargo.toml", "[package]\nname = \"stationen\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
    repo.write_file("src/lib.rs", "pub mod config;\n");
    repo.write_file("src/config.rs", "pub struct Config {\n    pub stations: Vec<String>,\n}\n\npub fn load(text: &str) -> Config {\n    Config { stations: text.lines().map(str::to_string).collect() }\n}\n");
    repo.commit("Config");

    repo.write_file("src/lib.rs", "pub mod config;\nmod parser;\n#[cfg(test)]\nmod config_tests;\n");
    repo.write_file("src/parser.rs", "pub fn parse_station(line: &str) -> Option<String> {\n    line.split(';').next().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)\n}\n");
    repo.write_file(
        "src/config.rs",
        "pub struct Config {\n    pub stations: Vec<String>,\n}\n\npub fn load(text: &str) -> Config {\n    Config { stations: text.lines().filter_map(crate::parser::parse_station).collect() }\n}\n",
    );
    repo.write_file("src/config_tests.rs", "use super::config::load;\n\n#[test]\nfn empty_lines_are_no_stations() {\n    assert_eq!(load(\"N;Nord\\n\\n\").stations, vec![\"N\"]);\n}\n");

    assert_eq!(
        requirements_of(&repo).await,
        expected(&[
            // `mod parser;` and `mod config_tests;` name the two new files.
            ("src/lib.rs#0", &["src/config_tests.rs#file", "src/parser.rs#file"]),
            // `crate::parser::parse_station` – the function is new.
            ("src/config.rs#0", &["src/parser.rs#file"]),
            // config_tests.rs tests config.rs, which changes too.
            ("src/config_tests.rs#file", &["src/config.rs#0"]),
        ])
    );
}

#[tokio::test]
async fn hunks_of_one_file_a_helper_added_at_the_end_and_used_at_the_top() {
    let repo = TestRepo::with_commit();
    let body: String = (1..=12).map(|n| format!("  step{n}();\n")).collect();
    let original = format!("export function run() {{\n{body}}}\n");
    repo.commit_file("src/run.js", &original, "Run");
    let changed = format!("export function run() {{\n  announceStart();\n{body}}}\n\nfunction announceStart() {{\n  console.log(\"start\");\n}}\n");
    repo.write_file("src/run.js", changed);

    assert_eq!(requirements_of(&repo).await, expected(&[("src/run.js#0", &["src/run.js#1"])]), "the call in hunk 0 needs the definition in hunk 1");
}

#[tokio::test]
async fn nothing_is_required_when_every_name_and_path_already_exists() {
    let repo = TestRepo::with_commit();
    repo.write_file("src/util.ts", "export function clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value));\n}\n");
    repo.write_file("src/slider.ts", "export const MIN = 0;\n");
    repo.commit("Util");
    // A new file whose only definition reuses an existing name, used elsewhere without an import of it.
    repo.write_file("src/legacy/clamp.ts", "export function clamp(value: number): number {\n  return value;\n}\n");
    repo.write_file("src/slider.ts", "import { clamp } from \"./util\";\n\nexport const MIN = 0;\nexport const position = (x: number) => clamp(x, MIN, 100);\n");

    assert_eq!(requirements_of(&repo).await, BTreeMap::new(), "clamp exists in HEAD; ./util is no new file");
}

#[test]
fn test_files_and_the_sources_they_test() {
    let sources = |path: &str| -> Option<Vec<&'static str>> {
        let candidates = tested_sources(path)?;
        let files = [
            "src/portal/expiry.ts",
            "pkg/server/handler.go",
            "app/slug.py",
            "src/main/java/de/wetter/Station.java",
            "src/components/Button.tsx",
            "src/units.rs",
            "lib/parser.rb",
        ];
        Some(files.into_iter().filter(|file| candidates.iter().any(|c| c.matches(file))).collect())
    };
    assert_eq!(sources("src/portal/expiry.test.ts"), Some(vec!["src/portal/expiry.ts"]));
    assert_eq!(sources("src/portal/expiry.spec.ts"), Some(vec!["src/portal/expiry.ts"]));
    assert_eq!(sources("pkg/server/handler_test.go"), Some(vec!["pkg/server/handler.go"]));
    assert_eq!(sources("app/test_slug.py"), Some(vec!["app/slug.py"]));
    assert_eq!(sources("src/test/java/de/wetter/StationTest.java"), Some(vec!["src/main/java/de/wetter/Station.java"]));
    assert_eq!(sources("src/components/__tests__/Button.tsx"), Some(vec!["src/components/Button.tsx"]));
    assert_eq!(sources("src/units_tests.rs"), Some(vec!["src/units.rs"]));
    assert_eq!(sources("lib/parser_spec.rb"), Some(vec!["lib/parser.rb"]));
    for no_test in ["src/portal/expiry.ts", "src/contest.ts", "README.md", "src/testing.ts", "src/latest.py"] {
        assert_eq!(sources(no_test), None, "{no_test}");
    }
}

#[test]
fn definitions_and_words() {
    for (line, name) in [
        ("export function mfaStatus(user: StaffUser): MfaStatus {", Some("mfaStatus")),
        ("export default async function loadAll() {", Some("loadAll")),
        ("export const SEVEN_DAYS = 7;", Some("SEVEN_DAYS")),
        ("pub(crate) fn parse_station(line: &str) {", Some("parse_station")),
        ("pub struct Station {", Some("Station")),
        ("def make_slug(title):", Some("make_slug")),
        ("class ArticleView(View):", Some("ArticleView")),
        ("func HandleInvite(w http.ResponseWriter) {", Some("HandleInvite")),
        ("  const local = 1;", None),
        ("    def method(self):", None),
        ("fn go() {", None),
        ("return mfaStatus(user);", None),
    ] {
        assert_eq!(defined_name(line), name, "{line}");
    }
    assert!(contains_word("value={(u) => mfaStatus(u)}", "mfaStatus"));
    assert!(!contains_word("const mfaStatusLabel = 1;", "mfaStatus"));
    assert!(!contains_word("$mfaStatus", "mfaStatus"));
    assert!(contains_word("crate::parser::parse_station", "parse_station"));
}
