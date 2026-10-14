//! The definition of a custom command: the JSON format (`version: 1`), its checks, the
//! placeholders, the hash of the repository file and what changed since an approval. Pure
//! functions – nothing here starts a program.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;

use crate::commands::external::split_command_line;
use crate::model::{CustomCommandChange, CustomCommandChangeKind, CustomCommandDef, CustomCommandInput, CustomCommandKind, CustomCommandSource, CustomInputType};

/// Version of the file format.
pub const FORMAT_VERSION: u32 = 1;
/// The repository file, relative to the working directory.
pub const REPO_FILE: &str = ".forkyard/commands.json";
/// Larger files are not read.
pub const MAX_FILE_BYTES: usize = 256 * 1024;
/// At most this many commands per source.
pub const MAX_COMMANDS: usize = 200;
const MAX_TITLE_CHARS: usize = 80;
const MAX_RUN_CHARS: usize = 2000;
const MAX_INPUTS: usize = 10;

/// A placeholder in `run`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placeholder {
    Repo,
    Sha,
    Branch,
    File,
    Remote,
    Input(String),
}

/// `run` cut into literal text and placeholders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece<'a> {
    Text(&'a str),
    Var(Placeholder),
}

/// What a file yields: the valid commands and one sentence per rejected one.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub commands: Vec<CustomCommandDef>,
    pub problems: Vec<String>,
}

#[derive(Deserialize)]
struct RawFile {
    version: u32,
    #[serde(default)]
    commands: Vec<Value>,
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn valid_input_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase()) && id.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn placeholder(name: &str) -> Result<Placeholder, String> {
    match name {
        "repo" => Ok(Placeholder::Repo),
        "sha" => Ok(Placeholder::Sha),
        "branch" => Ok(Placeholder::Branch),
        "file" => Ok(Placeholder::File),
        "remote" => Ok(Placeholder::Remote),
        _ => match name.strip_prefix("input:") {
            Some(id) if valid_input_id(id) => Ok(Placeholder::Input(id.to_string())),
            _ => Err(format!(
                "Unknown placeholder “${{{name}}}”. Known are ${{repo}}, ${{sha}}, ${{branch}}, ${{file}}, ${{remote}} and ${{input:<id>}}."
            )),
        },
    }
}

/// Splits `text` into literal pieces and placeholders (`${sha}`, `${input:ziel}`).
pub fn pieces(text: &str) -> Result<Vec<Piece<'_>>, String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        if start > 0 {
            out.push(Piece::Text(&rest[..start]));
        }
        let after = &rest[start + 2..];
        let end = after.find('}').ok_or_else(|| format!("A placeholder in “{text}” is not closed with “}}”."))?;
        out.push(Piece::Var(placeholder(&after[..end])?));
        rest = &after[end + 1..];
    }
    if !rest.is_empty() {
        out.push(Piece::Text(rest));
    }
    Ok(out)
}

/// Reads a file in the format `{ "version": 1, "commands": [...] }`. One broken command does not
/// spoil the others; it is named in `problems`.
pub fn parse_file(bytes: &[u8], source: CustomCommandSource) -> Parsed {
    let fail = |problem: String| Parsed { commands: Vec::new(), problems: vec![problem] };
    if bytes.len() > MAX_FILE_BYTES {
        return fail(format!("The file is larger than {} KiB.", MAX_FILE_BYTES / 1024));
    }
    // Editors on Windows like to put a byte order mark in front.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let raw: RawFile = match serde_json::from_slice(bytes) {
        Ok(raw) => raw,
        Err(e) => return fail(format!("The file is not valid JSON: {e}")),
    };
    if raw.version != FORMAT_VERSION {
        return fail(format!("Unknown format version {} (expected {FORMAT_VERSION}).", raw.version));
    }
    let mut parsed = Parsed::default();
    if raw.commands.len() > MAX_COMMANDS {
        parsed.problems.push(format!("Only the first {MAX_COMMANDS} commands are read."));
    }
    let mut ids = HashSet::new();
    for (index, value) in raw.commands.into_iter().take(MAX_COMMANDS).enumerate() {
        let label = value.get("id").and_then(Value::as_str).map(|id| format!("“{id}”")).unwrap_or_else(|| format!("#{}", index + 1));
        let def: CustomCommandDef = match serde_json::from_value(value) {
            Ok(def) => def,
            Err(e) => {
                parsed.problems.push(format!("Command {label}: {e}"));
                continue;
            }
        };
        match validate(&def, source) {
            Ok(()) if !ids.insert(def.id.clone()) => parsed.problems.push(format!("Command {label}: the ID is used twice.")),
            Ok(()) => parsed.commands.push(def),
            Err(reason) => parsed.problems.push(format!("Command {label}: {reason}")),
        }
    }
    parsed
}

fn validate_inputs(inputs: &[CustomCommandInput]) -> Result<(), String> {
    if inputs.len() > MAX_INPUTS {
        return Err(format!("A command can have at most {MAX_INPUTS} inputs."));
    }
    let mut seen = HashSet::new();
    for input in inputs {
        if !valid_input_id(&input.id) {
            return Err(format!("The input ID “{}” may only contain lowercase letters, digits and “_”, starting with a letter.", input.id));
        }
        if !seen.insert(input.id.as_str()) {
            return Err(format!("The input ID “{}” is used twice.", input.id));
        }
        if input.label.trim().is_empty() {
            return Err(format!("The input “{}” has no label.", input.id));
        }
        match input.input_type {
            CustomInputType::Choice => {
                if input.options.is_empty() || input.options.iter().any(String::is_empty) {
                    return Err(format!("The choice “{}” needs options, none of them empty.", input.id));
                }
                if input.default.as_ref().is_some_and(|default| !input.options.contains(default)) {
                    return Err(format!("The default of “{}” is not one of its options.", input.id));
                }
            }
            CustomInputType::Checkbox => {
                if input.options.len() > 1 {
                    return Err(format!("The checkbox “{}” takes at most one option: the value when ticked.", input.id));
                }
                if input.default.as_deref().is_some_and(|default| default != "true" && default != "false") {
                    return Err(format!("The default of the checkbox “{}” must be “true” or “false”.", input.id));
                }
            }
            CustomInputType::Text | CustomInputType::File => {}
        }
    }
    Ok(())
}

/// Whether a placeholder sits in the argument that the program runs as code: the script after `-c`
/// of a POSIX shell (also combined, `-lc`), everything after `/c` or `/k` of `cmd`, everything after
/// `-Command`/`-c` of PowerShell. Arguments after a shell's script are plain positional values.
fn placeholder_in_code(tokens: &[String]) -> bool {
    let Some(program) = tokens.first() else { return false };
    let base = program.rsplit(['/', '\\']).next().unwrap_or(program).to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    let rest = &tokens[1..];
    let code: &[String] = match base {
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "fish" => {
            match rest.iter().position(|t| t.len() > 1 && t.starts_with('-') && !t.starts_with("--") && t[1..].contains('c')) {
                Some(i) => &rest[i + 1..(i + 2).min(rest.len())],
                None => &[],
            }
        }
        "cmd" => match rest.iter().position(|t| t.eq_ignore_ascii_case("/c") || t.eq_ignore_ascii_case("/k")) {
            Some(i) => &rest[i + 1..],
            None => &[],
        },
        "powershell" | "pwsh" => match rest.iter().position(|t| matches!(t.to_ascii_lowercase().as_str(), "-c" | "-command" | "-ec" | "-encodedcommand")) {
            Some(i) => &rest[i + 1..],
            None => &[],
        },
        _ => &[],
    };
    code.iter().any(|token| token.contains("${"))
}

/// Checks Git's arguments (template tokens or the expanded ones): a plain subcommand first, no
/// forced push except `--force-with-lease`.
pub fn check_git_args(args: &[String]) -> Result<(), String> {
    let Some(sub) = args.first() else { return Err("The command is empty.".into()) };
    if sub == "git" {
        return Err("Leave out “git” at the start: the command lists only Git's arguments, e.g. “log --oneline”.".into());
    }
    let plain = sub.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && sub.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !plain {
        return Err(format!("“{sub}” is not a Git command; the command must start with one (e.g. “log”, “tag”)."));
    }
    if sub == "push" && args.iter().any(|arg| arg == "--force" || arg == "-f" || arg.starts_with('+')) {
        return Err("Force push only as “--force-with-lease”.".into());
    }
    Ok(())
}

/// Checks a web address (the template or the finished address): http(s), a host without placeholders.
pub fn check_url_template(run: &str) -> Result<(), String> {
    let run = run.trim();
    let lower = run.to_ascii_lowercase();
    let scheme_end = if lower.starts_with("https://") {
        8
    } else if lower.starts_with("http://") {
        7
    } else {
        return Err("A web address must start with http:// or https://.".into());
    };
    let rest = &run[scheme_end..];
    let host = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if host.contains("${") {
        return Err("The host of the web address can’t contain a placeholder – only its path and query can.".into());
    }
    if host.is_empty() {
        return Err("The web address has no host.".into());
    }
    if run.chars().any(char::is_whitespace) {
        return Err("A web address can’t contain spaces; placeholders are encoded on their own.".into());
    }
    Ok(())
}

/// Whether a definition may be stored (global) or used (repository file). Returns the reason as
/// one sentence.
pub fn validate(def: &CustomCommandDef, source: CustomCommandSource) -> Result<(), String> {
    if !valid_id(&def.id) {
        return Err("The ID may only contain lowercase letters, digits, “.”, “_” and “-” (at most 64, starting with a letter or digit).".into());
    }
    let title = def.title.trim();
    if title.is_empty() {
        return Err("The title is empty.".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("The title is longer than {MAX_TITLE_CHARS} characters."));
    }
    if def.run.trim().is_empty() {
        return Err("The command is empty.".into());
    }
    if def.run.chars().count() > MAX_RUN_CHARS {
        return Err(format!("The command is longer than {MAX_RUN_CHARS} characters."));
    }
    if def.run.chars().any(char::is_control) {
        return Err("The command must be one line without control characters.".into());
    }
    if def.scope.is_empty() {
        return Err("Choose at least one place where the command appears (scope).".into());
    }
    if def.shell && source == CustomCommandSource::Repo {
        return Err("“shell: true” is only allowed for your own global commands, not in a repository file.".into());
    }
    if def.shell && def.kind != CustomCommandKind::Shell {
        return Err("“shell: true” only applies to commands of kind “shell”.".into());
    }
    validate_inputs(&def.inputs)?;
    for piece in pieces(&def.run)? {
        if let Piece::Var(Placeholder::Input(id)) = piece {
            if !def.inputs.iter().any(|input| input.id == id) {
                return Err(format!("The placeholder “${{input:{id}}}” has no input with this ID."));
            }
        }
    }
    match def.kind {
        CustomCommandKind::Shell if def.shell => Ok(()),
        CustomCommandKind::Shell => {
            let tokens = split_command_line(&def.run, !cfg!(windows)).map_err(|e| e.message)?;
            let program = tokens.first().ok_or_else(|| "The command is empty.".to_string())?;
            if program.contains("${") {
                return Err("The program must be written out; a placeholder can only be an argument.".into());
            }
            if placeholder_in_code(&tokens) {
                return Err(format!(
                    "“{program}” runs one of its arguments as code, and a placeholder there would turn a value into commands. Pass values as arguments of their own, or use “shell: true” (your own commands only)."
                ));
            }
            Ok(())
        }
        CustomCommandKind::Git => check_git_args(&split_command_line(&def.run, !cfg!(windows)).map_err(|e| e.message)?),
        CustomCommandKind::Url => check_url_template(&def.run),
    }
}

/// SHA-256 of the file's bytes as lowercase hex – what an approval is bound to.
pub fn file_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What changed between the approved and the current commands: changed and added ones in the
/// order of `after`, then the removed ones.
pub fn changes(before: &[CustomCommandDef], after: &[CustomCommandDef]) -> Vec<CustomCommandChange> {
    let mut out = Vec::new();
    for new in after {
        match before.iter().find(|old| old.id == new.id) {
            None => out.push(CustomCommandChange { id: new.id.clone(), title: new.title.clone(), change: CustomCommandChangeKind::Added, before: None, after: Some(new.run.clone()) }),
            Some(old) if old != new => out.push(CustomCommandChange {
                id: new.id.clone(),
                title: new.title.clone(),
                change: CustomCommandChangeKind::Changed,
                before: Some(old.run.clone()),
                after: Some(new.run.clone()),
            }),
            Some(_) => {}
        }
    }
    for old in before {
        if !after.iter().any(|new| new.id == old.id) {
            out.push(CustomCommandChange { id: old.id.clone(), title: old.title.clone(), change: CustomCommandChangeKind::Removed, before: Some(old.run.clone()), after: None });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CustomCommandCwd, CustomCommandScope};
    use CustomCommandKind::{Git, Shell, Url};
    use CustomCommandSource::{Global, Repo};

    fn def(kind: CustomCommandKind, run: &str) -> CustomCommandDef {
        CustomCommandDef {
            id: "befehl".into(),
            title: "Befehl".into(),
            kind,
            run: run.into(),
            cwd: CustomCommandCwd::Worktree,
            confirm: false,
            shell: false,
            inputs: vec![],
            scope: vec![CustomCommandScope::Repo],
        }
    }

    fn text(id: &str) -> CustomCommandInput {
        CustomCommandInput { id: id.into(), label: id.to_uppercase(), input_type: CustomInputType::Text, default: None, options: vec![] }
    }

    fn choice(id: &str, options: &[&str], default: Option<&str>) -> CustomCommandInput {
        CustomCommandInput {
            id: id.into(),
            label: "Wahl".into(),
            input_type: CustomInputType::Choice,
            default: default.map(str::to_string),
            options: options.iter().map(|o| o.to_string()).collect(),
        }
    }

    fn reason(def: &CustomCommandDef) -> String {
        validate(def, Global).unwrap_err()
    }

    #[test]
    fn placeholders_are_split_out_and_unknown_ones_named() {
        assert_eq!(
            pieces("a ${sha} b${input:ziel}").unwrap(),
            vec![Piece::Text("a "), Piece::Var(Placeholder::Sha), Piece::Text(" b"), Piece::Var(Placeholder::Input("ziel".into()))]
        );
        assert_eq!(pieces("ohne").unwrap(), vec![Piece::Text("ohne")]);
        assert_eq!(pieces("$sha {sha} $").unwrap(), vec![Piece::Text("$sha {sha} $")]);
        assert!(pieces("${user}").unwrap_err().contains("${user}"));
        assert!(pieces("${sha").unwrap_err().contains("not closed"));
        assert!(pieces("${input:Groß}").is_err());
    }

    #[test]
    fn valid_definitions_pass() {
        let mut shell = def(Shell, "make ${input:ziel} BRANCH=${branch}");
        shell.inputs = vec![choice("ziel", &["all", "test"], Some("test"))];
        assert_eq!(validate(&shell, Repo), Ok(()));
        assert_eq!(validate(&def(Git, "log --oneline -5 ${sha}"), Repo), Ok(()));
        assert_eq!(validate(&def(Url, "https://ci.example.com/${branch}?sha=${sha}"), Repo), Ok(()));
        let mut piped = def(Shell, "git log --oneline | head -n 5");
        piped.shell = true;
        assert_eq!(validate(&piped, Global), Ok(()));
    }

    #[test]
    fn invalid_definitions_are_rejected_with_a_reason() {
        let mut bad_id = def(Shell, "make");
        bad_id.id = "Groß".into();
        assert!(reason(&bad_id).contains("ID"));
        let mut no_title = def(Shell, "make");
        no_title.title = "  ".into();
        assert!(reason(&no_title).contains("title"));
        assert!(reason(&def(Shell, "  ")).contains("empty"));
        assert!(reason(&def(Shell, "make\nrm -rf /")).contains("one line"));
        let mut no_scope = def(Shell, "make");
        no_scope.scope.clear();
        assert!(reason(&no_scope).contains("scope"));
        let mut program = def(Shell, "${input:prog} --flag");
        program.inputs = vec![text("prog")];
        assert!(reason(&program).contains("program"));
        assert!(reason(&def(Shell, "make ${input:fehlt}")).contains("no input"));
        // A placeholder in code that a program interprets would turn a value into commands.
        for line in ["sh -c ${branch}", "bash -lc \"echo ${branch}\"", "/bin/sh -c x${sha}", "cmd /C echo ${branch}", "powershell -NoProfile -Command Write-Output ${branch}"] {
            assert!(reason(&def(Shell, line)).contains("shell: true"), "{line}");
        }
        // Positional arguments after a shell's script and scripts run by file name are plain values.
        assert_eq!(validate(&def(Shell, "sh -c make ${branch}"), Repo), Ok(()));
        assert_eq!(validate(&def(Shell, "bash ./build.sh ${branch}"), Repo), Ok(()));
        assert!(reason(&def(Git, "git log")).contains("Leave out"));
        assert!(reason(&def(Git, "-c core.hooksPath=x log")).contains("not a Git command"));
        assert!(reason(&def(Git, "${branch} log")).contains("not a Git command"));
        assert!(reason(&def(Git, "push --force origin main")).contains("--force-with-lease"));
        assert!(reason(&def(Git, "push -f")).contains("--force-with-lease"));
        assert!(reason(&def(Git, "push origin +${branch}")).contains("--force-with-lease"));
        assert!(reason(&def(Url, "file:///etc/passwd")).contains("http"));
        assert!(reason(&def(Url, "javascript:alert(1)")).contains("http"));
        assert!(reason(&def(Url, "https://${branch}.example.com/")).contains("address"));
        let mut git_shell = def(Git, "log");
        git_shell.shell = true;
        assert!(reason(&git_shell).contains("shell"));
        let mut repo_shell = def(Shell, "make | tee x");
        repo_shell.shell = true;
        assert!(validate(&repo_shell, Repo).unwrap_err().contains("repository file"));
    }

    #[test]
    fn inputs_are_checked() {
        let with = |inputs: Vec<CustomCommandInput>| {
            let mut d = def(Shell, "make");
            d.inputs = inputs;
            reason(&d)
        };
        assert!(with(vec![text("Groß")]).contains("input ID"));
        assert!(with(vec![text("a"), text("a")]).contains("twice"));
        let mut unlabeled = text("a");
        unlabeled.label = " ".into();
        assert!(with(vec![unlabeled]).contains("label"));
        assert!(with(vec![choice("c", &[], None)]).contains("options"));
        assert!(with(vec![choice("c", &["a"], Some("b"))]).contains("default"));
        let mut checkbox = CustomCommandInput { id: "k".into(), label: "K".into(), input_type: CustomInputType::Checkbox, default: Some("ja".into()), options: vec![] };
        assert!(with(vec![checkbox.clone()]).contains("true"));
        checkbox.default = None;
        checkbox.options = vec!["--a".into(), "--b".into()];
        assert!(with(vec![checkbox]).contains("at most one"));
    }

    #[test]
    fn files_are_read_command_by_command() {
        let file = br#"{"version":1,"commands":[
            {"id":"gut","title":"Gut","kind":"git","run":"log -1"},
            {"id":"gut","title":"Doppelt","kind":"git","run":"log -2"},
            {"id":"kaputt","title":"Kaputt","kind":"nirgendwo","run":"x"},
            {"id":"leer","title":"","kind":"git","run":"log"}
        ],"zukunft":true}"#;
        let parsed = parse_file(file, Repo);
        assert_eq!(parsed.commands.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["gut"]);
        assert_eq!(parsed.commands[0].scope, vec![CustomCommandScope::Repo], "scope defaults to the repository");
        assert_eq!(parsed.problems.len(), 3, "{:?}", parsed.problems);
        assert!(parsed.problems[0].contains("“gut”") && parsed.problems[0].contains("twice"), "{:?}", parsed.problems);
        assert!(parsed.problems[1].contains("“kaputt”"), "{:?}", parsed.problems);
        let with_bom = [b"\xEF\xBB\xBF".as_slice(), br#"{"version":1,"commands":[]}"#.as_slice()].concat();
        assert_eq!(parse_file(&with_bom, Repo), Parsed::default());
        assert!(parse_file(br#"{"version":2,"commands":[]}"#, Repo).problems[0].contains("version 2"));
        assert!(parse_file(b"nicht json", Repo).problems[0].contains("JSON"));
        assert!(parse_file(&vec![b' '; MAX_FILE_BYTES + 1], Repo).problems[0].contains("KiB"));
    }

    #[test]
    fn the_hash_is_sha256_of_the_bytes() {
        assert_eq!(file_hash(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_ne!(file_hash(b"abc\n"), file_hash(b"abc"));
    }

    #[test]
    fn changes_name_added_removed_and_changed_commands() {
        let a = def(Git, "log -1");
        let mut a2 = a.clone();
        a2.run = "log -2".into();
        let mut b = def(Git, "status");
        b.id = "b".into();
        let mut c = def(Git, "tag");
        c.id = "c".into();
        let found = changes(&[a.clone(), b], &[a2, c]);
        assert_eq!(
            found.iter().map(|x| (x.id.as_str(), x.change)).collect::<Vec<_>>(),
            [("befehl", CustomCommandChangeKind::Changed), ("c", CustomCommandChangeKind::Added), ("b", CustomCommandChangeKind::Removed)]
        );
        assert_eq!((found[0].before.as_deref(), found[0].after.as_deref()), (Some("log -1"), Some("log -2")));
        let same = [a];
        assert!(changes(&same, &same).is_empty());
    }
}
