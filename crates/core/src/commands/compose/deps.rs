//! "Doesn't build on its own" (v1.2, 3.2): which unit needs which other unit, worked out without
//! the AI and the same way every time. The UI marks a unit whose requirement sits in a later
//! commit or in "Don't commit".
//!
//! The rules are deliberately conservative – a missing warning is better than a wrong one:
//!
//! 1. **New files.** A unit whose added lines import, include or `mod`-declare a path that resolves
//!    exactly to a file this change adds (or renames to) needs that file. Only lines that look
//!    like an import (`import`, `from`, `require`, `include`, `mod`, `src=` …) count, and the path
//!    must resolve to the new file: relative to the importing file, from the repository root, or
//!    as a Python module path.
//! 2. **New symbols.** A top-level definition in added lines (`function x`, `export const x`,
//!    `pub fn x`, `def x`, `class X` …) whose name appears nowhere in HEAD is new. A unit whose
//!    added lines use that name as a whole word needs the defining unit. Names shorter than four
//!    characters and names defined by more than one unit are left out.
//! 3. **Tests.** A unit of a test file (`x.test.ts`, `x.spec.js`, `x_test.go`, `test_x.py`,
//!    `x_tests.rs`, `__tests__/x.ts`, `XTest.java` …) needs every unit of the source file it tests
//!    when that file changes too.
//!
//! Prose and data files (Markdown, text, JSON, YAML, TOML, CSV, lock files) never need anything:
//! a changelog that names a new function does not stop building without it.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::units::ChangedFile;
use crate::app::Core;
use crate::commands::diff::patch::LineKind;
use crate::error::CoreResult;
use crate::util;

/// At most this many new names are looked up in HEAD (one `git grep`).
const MAX_SYMBOLS: usize = 400;
/// Shorter names are too likely to mean something else.
const MIN_SYMBOL_CHARS: usize = 4;

/// One unit as the rules see it.
#[derive(Debug, Clone)]
pub(crate) struct UnitText {
    pub(crate) id: String,
    pub(crate) path: String,
    /// The file is added (or renamed to this path) by the change.
    pub(crate) new_file: bool,
    pub(crate) added: Vec<String>,
}

/// The units of the changed files, in file order.
pub(crate) fn unit_texts(files: &[ChangedFile]) -> Vec<UnitText> {
    let mut out = Vec::new();
    for file in files {
        let new_file = matches!(file.entry.status, b'A' | b'R');
        let added_of = |hunks: &mut dyn Iterator<Item = &crate::commands::diff::patch::PatchHunk>| -> Vec<String> {
            hunks
                .flat_map(|hunk| hunk.lines.iter())
                .filter(|line| line.kind == LineKind::Add)
                .map(|line| util::decode_lossy(line.content.strip_suffix(b"\r").unwrap_or(&line.content)))
                .collect()
        };
        match (file.hunk_count(), &file.patch) {
            (Some(_), Some(patch)) => {
                for (index, hunk) in patch.hunks.iter().enumerate() {
                    out.push(UnitText { id: file.unit_id(Some(index)), path: file.path.clone(), new_file, added: added_of(&mut std::iter::once(hunk)) });
                }
            }
            (_, patch) => {
                let added = patch.as_ref().map(|patch| added_of(&mut patch.hunks.iter())).unwrap_or_default();
                out.push(UnitText { id: file.unit_id(None), path: file.path.clone(), new_file, added });
            }
        }
    }
    out
}

/// Unit ID → the IDs of the units it needs, for every unit that needs one. Reads HEAD once
/// (`git grep`) to tell new names from existing ones.
pub(crate) async fn read(core: &Core, repo_id: &str, head: &str, files: &[ChangedFile]) -> CoreResult<BTreeMap<String, Vec<String>>> {
    let units = unit_texts(files);
    let candidates: Vec<String> = definitions(&units).into_keys().take(MAX_SYMBOLS).collect();
    let existing = existing_in_head(core, repo_id, head, &candidates).await?;
    Ok(requirements(&units, &existing))
}

/// Which of `names` appear as a whole word anywhere in `head`.
async fn existing_in_head(core: &Core, repo_id: &str, head: &str, names: &[String]) -> CoreResult<HashSet<String>> {
    if names.is_empty() {
        return Ok(HashSet::new());
    }
    let mut cmd = core.git_for(repo_id)?.read_only().no_log().args(["grep", "-I", "-w", "-F", "-o", "-h", "--no-color"]);
    for name in names {
        cmd = cmd.arg("-e").arg(name.as_str());
    }
    let out = cmd.args([head, "--"]).run_raw().await?;
    // Exit code 1: no match at all. Anything else that failed: assume every name exists (no warning).
    if !out.success() && out.code != Some(1) {
        return Ok(names.iter().cloned().collect());
    }
    Ok(util::decode_lossy(&out.stdout).lines().map(|line| line.trim().to_string()).filter(|line| !line.is_empty()).collect())
}

/// The rules on given units; `existing`: names that HEAD already has.
pub(crate) fn requirements(units: &[UnitText], existing: &HashSet<String>) -> BTreeMap<String, Vec<String>> {
    let mut needs: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    let mut add = |from: usize, to: usize| {
        if from != to && !is_prose(&units[from].path) {
            needs.entry(units[from].id.clone()).or_default().insert(to);
        }
    };

    // 1. New files referenced by an import-like line.
    let new_files: Vec<usize> = (0..units.len()).filter(|&i| units[i].new_file).collect();
    if !new_files.is_empty() {
        for (index, unit) in units.iter().enumerate() {
            for line in &unit.added {
                for candidate in references(line, &unit.path) {
                    for &target in &new_files {
                        if units[target].path != unit.path && candidate.matches(&units[target].path) {
                            add(index, target);
                        }
                    }
                }
            }
        }
    }

    // 2. New top-level names.
    for (name, definer) in definitions(units) {
        if existing.contains(&name) {
            continue;
        }
        for (index, unit) in units.iter().enumerate() {
            if index != definer && unit.added.iter().any(|line| contains_word(line, &name)) {
                add(index, definer);
            }
        }
    }

    // 3. Tests need the changes of the file they test.
    let mut by_path: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, unit) in units.iter().enumerate() {
        by_path.entry(unit.path.as_str()).or_default().push(index);
    }
    for (index, unit) in units.iter().enumerate() {
        let Some(sources) = tested_sources(&unit.path) else { continue };
        for (path, indices) in &by_path {
            if *path != unit.path && tested_sources(path).is_none() && sources.iter().any(|source| source.matches(path)) {
                for &target in indices {
                    add(index, target);
                }
            }
        }
    }

    needs.into_iter().map(|(id, targets)| (id, targets.into_iter().map(|i| units[i].id.clone()).collect())).collect()
}

// ---------------------------------------------------------------------------------------------
// Paths

/// Documentation and data: what these files say is not code that needs something to build.
const PROSE: [&str; 14] = ["md", "markdown", "mdx", "txt", "rst", "adoc", "org", "json", "lock", "yaml", "yml", "toml", "csv", "tsv"];

fn is_prose(path: &str) -> bool {
    let name = file_name(path);
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => PROSE.contains(&extension.to_ascii_lowercase().as_str()),
        _ => matches!(name.to_ascii_uppercase().as_str(), "CHANGELOG" | "README" | "LICENSE" | "NEWS" | "AUTHORS" | "CONTRIBUTORS"),
    }
}

/// A path an import may mean. `exact`: the path itself, with any extension, or a folder with
/// `index.*`, `mod.rs` or `__init__.py`. `suffix`: a Python module path that may sit below any
/// source folder (at least two segments).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    path: String,
    suffix: bool,
}

impl Candidate {
    fn exact(path: String) -> Candidate {
        Candidate { path, suffix: false }
    }

    pub(crate) fn matches(&self, file: &str) -> bool {
        let stem = strip_extension(file);
        let same = |p: &str| file == p || stem == p || ["index", "mod", "__init__"].iter().any(|name| strip_extension(file) == format!("{p}/{name}"));
        if same(&self.path) {
            return true;
        }
        self.suffix && (stem.ends_with(&format!("/{}", self.path)) || ["__init__"].iter().any(|name| stem.ends_with(&format!("/{}/{name}", self.path))))
    }
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn file_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// `a/b.test.ts` → `a/b.test`; a leading dot is part of the name (`.env`).
fn strip_extension(path: &str) -> &str {
    let name = file_name(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => &path[..path.len() - (name.len() - dot)],
        _ => path,
    }
}

/// `dir` + `rel` with `.` and `..` resolved; `None` when it leaves the repository.
fn join(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Words that make a line an import, an include or a reference to a file.
const IMPORT_WORDS: [&str; 10] = ["import", "from", "require", "include", "@use", "@forward", "src=", "href=", "load(", "source "];

fn looks_like_import(line: &str) -> bool {
    let trimmed = line.trim_start();
    IMPORT_WORDS.iter().any(|word| trimmed.contains(word)) || mod_declaration(trimmed).is_some()
}

/// `mod name;`, `pub mod name;`, `pub(crate) mod name;` → `name`.
fn mod_declaration(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix("pub ").or_else(|| trimmed.strip_prefix("pub(crate) ")).or_else(|| trimmed.strip_prefix("pub(super) ")).unwrap_or(trimmed);
    let name = rest.strip_prefix("mod ")?.trim().strip_suffix(';')?.trim();
    is_identifier(name).then_some(name)
}

/// Every path an added line may refer to.
pub(crate) fn references(line: &str, from: &str) -> Vec<Candidate> {
    if !looks_like_import(line) {
        return Vec::new();
    }
    let trimmed = line.trim_start();
    let dir = dir_of(from);
    let mut out = Vec::new();
    if let Some(name) = mod_declaration(trimmed) {
        out.extend(join(dir, name).map(Candidate::exact));
        let own = strip_extension(file_name(from));
        if !["mod", "lib", "main"].contains(&own) {
            out.extend(join(dir, &format!("{own}/{name}")).map(Candidate::exact));
        }
        return out;
    }
    if let Some(module) = python_module(trimmed) {
        out.extend(python_candidates(module, dir));
    }
    for spec in quoted(trimmed) {
        if spec.is_empty() || spec.contains("://") || spec.contains(char::is_whitespace) || spec.starts_with('#') {
            continue;
        }
        if spec.starts_with("./") || spec.starts_with("../") {
            out.extend(join(dir, spec).map(Candidate::exact));
        } else if let Some(root) = spec.strip_prefix('/') {
            out.extend(join("", root).map(Candidate::exact));
        } else {
            let spec = spec.strip_prefix("@/").or_else(|| spec.strip_prefix("~/")).map(|rest| format!("src/{rest}")).unwrap_or_else(|| spec.to_string());
            out.extend(join(dir, &spec).map(Candidate::exact));
            out.extend(join("", &spec).map(Candidate::exact));
        }
    }
    out
}

/// The texts between matching quotes.
fn quoted(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find(['"', '\'', '`']) {
        let quote = rest[start..].chars().next().unwrap_or('"');
        let after = &rest[start + 1..];
        let Some(end) = after.find(quote) else { break };
        out.push(&after[..end]);
        rest = &after[end + 1..];
    }
    out
}

/// `from .a.b import c` → `.a.b`; `import a.b` → `a.b` (Python only: no quotes, no braces).
fn python_module(trimmed: &str) -> Option<&str> {
    if trimmed.contains(['"', '\'', '{', '(', ';', '`']) {
        return None;
    }
    let module = if let Some(rest) = trimmed.strip_prefix("from ") {
        rest.split_once(" import ")?.0.trim()
    } else {
        let rest = trimmed.strip_prefix("import ")?;
        rest.split([',', ' ']).next()?.trim()
    };
    (!module.is_empty() && module.split('.').all(|part| part.is_empty() || is_identifier(part))).then_some(module)
}

fn python_candidates(module: &str, dir: &str) -> Vec<Candidate> {
    let dots = module.chars().take_while(|c| *c == '.').count();
    let path = module[dots..].replace('.', "/");
    if dots > 0 {
        let mut base = dir.to_string();
        for _ in 1..dots {
            base = dir_of(&base).to_string();
        }
        return if path.is_empty() { Vec::new() } else { join(&base, &path).map(Candidate::exact).into_iter().collect() };
    }
    let mut out: Vec<Candidate> = [join(dir, &path), join("", &path)].into_iter().flatten().map(Candidate::exact).collect();
    if path.contains('/') {
        out.push(Candidate { path, suffix: true });
    }
    out
}

/// The source files a test file tests, or `None` when it is no test file.
pub(crate) fn tested_sources(path: &str) -> Option<Vec<Candidate>> {
    let dir = dir_of(path);
    let name = file_name(path);
    let stem = strip_extension(name);
    let parent = dir_of(dir);
    let in_test_dir = matches!(file_name(dir), "__tests__" | "tests" | "test");
    let mut base: Option<&str> = None;
    for marker in [".test", ".spec", "_test", "_tests", "_spec"] {
        if let Some(rest) = stem.strip_suffix(marker) {
            base = Some(rest);
            break;
        }
    }
    if base.is_none() {
        base = stem.strip_prefix("test_");
    }
    let mut java: Option<String> = None;
    if base.is_none() && (name.ends_with(".java") || name.ends_with(".kt")) {
        if let Some(rest) = stem.strip_suffix("Test").or_else(|| stem.strip_suffix("Tests")) {
            base = Some(rest);
            java = dir.contains("/test/").then(|| dir.replacen("/test/", "/main/", 1)).or_else(|| dir.strip_prefix("test/").map(|rest| format!("main/{rest}")));
        }
    }
    if base.is_none() && dir_of(path).split('/').any(|part| part == "__tests__") {
        base = Some(stem);
    }
    let base = base.filter(|base| !base.is_empty())?;
    let mut out: Vec<Candidate> = join(dir, base).map(Candidate::exact).into_iter().collect();
    if in_test_dir {
        out.extend(join(parent, base).map(Candidate::exact));
        out.extend(join(parent, &format!("src/{base}")).map(Candidate::exact));
    }
    if let Some(main) = java {
        out.extend(join(&main, base).map(Candidate::exact));
    }
    Some(out)
}

// ---------------------------------------------------------------------------------------------
// Names

fn is_identifier_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$') && chars.all(is_identifier_char)
}

/// `name` as a whole word in `line`.
pub(crate) fn contains_word(line: &str, name: &str) -> bool {
    let mut from = 0;
    while let Some(found) = line[from..].find(name) {
        let start = from + found;
        let end = start + name.len();
        let before = line[..start].chars().next_back();
        let after = line[end..].chars().next();
        if !before.is_some_and(is_identifier_char) && !after.is_some_and(is_identifier_char) {
            return true;
        }
        from = end;
    }
    false
}

const MODIFIERS: [&str; 13] = ["export ", "default ", "pub(crate) ", "pub(super) ", "pub ", "async ", "declare ", "abstract ", "unsafe ", "extern ", "static ", "final ", "public "];
const KEYWORDS: [&str; 17] = ["function* ", "function ", "class ", "interface ", "type ", "enum ", "const ", "let ", "var ", "fn ", "struct ", "trait ", "def ", "func ", "macro_rules! ", "union ", "record "];

/// The name a top-level added line defines, if any.
pub(crate) fn defined_name(line: &str) -> Option<&str> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let mut rest = line;
    loop {
        let before = rest;
        for modifier in MODIFIERS {
            if let Some(after) = rest.strip_prefix(modifier) {
                rest = after;
            }
        }
        if rest == before {
            break;
        }
    }
    let after = KEYWORDS.iter().find_map(|keyword| rest.strip_prefix(keyword))?;
    let end = after.find(|c: char| !is_identifier_char(c)).unwrap_or(after.len());
    let name = &after[..end];
    (is_identifier(name) && name.chars().count() >= MIN_SYMBOL_CHARS).then_some(name)
}

/// New-looking name → the one unit defining it; names defined by several units are dropped.
fn definitions(units: &[UnitText]) -> BTreeMap<String, usize> {
    let mut found: BTreeMap<String, Option<usize>> = BTreeMap::new();
    for (index, unit) in units.iter().enumerate() {
        for line in &unit.added {
            if let Some(name) = defined_name(line) {
                let entry = found.entry(name.to_string()).or_insert(Some(index));
                if *entry != Some(index) {
                    *entry = None;
                }
            }
        }
    }
    found.into_iter().filter_map(|(name, unit)| unit.map(|unit| (name, unit))).collect()
}
