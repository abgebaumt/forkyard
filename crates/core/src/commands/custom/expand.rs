//! Placeholders → arguments. The template is split first, then every placeholder is replaced
//! inside its token – so a value is always part of exactly one argument, whatever it contains.
//! `url` values are percent-encoded. With `shell: true` the line only names environment
//! variables; the values themselves are never part of it.

use std::collections::BTreeMap;

use super::definition::{self, Piece, Placeholder};
use crate::commands::external::split_command_line;
use crate::error::{CoreError, CoreResult};
use crate::model::CustomCommandDef;

/// Value of an input. `from_definition`: it is one of the definition's own options (`choice`,
/// `checkbox`), as trusted as the template itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputValue {
    pub value: String,
    pub from_definition: bool,
}

/// Everything a placeholder can stand for, already checked (`custom::resolve`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Values {
    pub repo: String,
    pub sha: Option<String>,
    pub branch: Option<String>,
    pub file: Option<String>,
    pub remote: Option<String>,
    pub inputs: BTreeMap<String, InputValue>,
}

impl Values {
    /// The value and whether it comes from the definition.
    fn lookup(&self, placeholder: &Placeholder) -> CoreResult<(&str, bool)> {
        let missing = |what: &str| CoreError::not_allowed(format!("This command needs {what}, and there is none here."));
        match placeholder {
            Placeholder::Repo => Ok((self.repo.as_str(), false)),
            Placeholder::Sha => self.sha.as_deref().map(|v| (v, false)).ok_or_else(|| missing("a commit")),
            Placeholder::Branch => self.branch.as_deref().map(|v| (v, false)).ok_or_else(|| missing("a branch")),
            Placeholder::File => self.file.as_deref().map(|v| (v, false)).ok_or_else(|| missing("a file")),
            Placeholder::Remote => self.remote.as_deref().map(|v| (v, false)).ok_or_else(|| missing("a remote")),
            Placeholder::Input(id) => self
                .inputs
                .get(id)
                .map(|input| (input.value.as_str(), input.from_definition))
                .ok_or_else(|| CoreError::not_allowed(format!("The value for the input “{id}” is missing."))),
        }
    }
}

fn parts(text: &str) -> CoreResult<Vec<Piece<'_>>> {
    definition::pieces(text).map_err(CoreError::not_allowed)
}

/// One argument per token of the template. A token that is exactly one placeholder with an empty
/// value is left out (an unticked checkbox). The flag says whether the argument starts with a
/// value that does not come from the definition.
fn expand_tokens(template: &str, values: &Values) -> CoreResult<Vec<(String, bool)>> {
    let mut out = Vec::new();
    for token in split_command_line(template, !cfg!(windows))? {
        let pieces = parts(&token)?;
        let only_placeholder = matches!(pieces.as_slice(), [Piece::Var(_)]);
        let mut text = String::new();
        let mut leading_value = false;
        for (index, piece) in pieces.iter().enumerate() {
            match piece {
                Piece::Text(literal) => text.push_str(literal),
                Piece::Var(placeholder) => {
                    let (value, from_definition) = values.lookup(placeholder)?;
                    if index == 0 && !from_definition {
                        leading_value = true;
                    }
                    text.push_str(value);
                }
            }
        }
        if only_placeholder && text.is_empty() {
            continue;
        }
        out.push((text, leading_value));
    }
    Ok(out)
}

/// `shell` without a shell: program and arguments.
pub fn shell_args(def: &CustomCommandDef, values: &Values) -> CoreResult<(String, Vec<String>)> {
    let mut tokens = expand_tokens(&def.run, values)?.into_iter().map(|(token, _)| token);
    let program = tokens.next().filter(|program| !program.trim().is_empty()).ok_or_else(|| CoreError::not_allowed("The command is empty."))?;
    Ok((program, tokens.collect()))
}

fn env_name(placeholder: &Placeholder) -> String {
    match placeholder {
        Placeholder::Repo => "FORKYARD_REPO".into(),
        Placeholder::Sha => "FORKYARD_SHA".into(),
        Placeholder::Branch => "FORKYARD_BRANCH".into(),
        Placeholder::File => "FORKYARD_FILE".into(),
        Placeholder::Remote => "FORKYARD_REMOTE".into(),
        Placeholder::Input(id) => format!("FORKYARD_INPUT_{}", id.to_ascii_uppercase()),
    }
}

/// `shell: true`: the line for `sh -c` (Unix) or PowerShell (Windows), in which every placeholder
/// is a reference to its environment variable – one argument, whether the template quotes it or
/// not; the values themselves are never part of it.
/// Missing values are reported as for `shell_args`.
pub fn shell_line(def: &CustomCommandDef, values: &Values, windows: bool) -> CoreResult<(String, Vec<String>)> {
    let pieces = parts(&def.run)?;
    for piece in &pieces {
        if let Piece::Var(placeholder) = piece {
            values.lookup(placeholder)?;
        }
    }
    Ok(if windows {
        ("powershell.exe".to_string(), vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), powershell_line(&pieces)])
    } else {
        ("sh".to_string(), vec!["-c".into(), posix_line(&pieces)])
    })
}

/// The `sh` line, aware of the template's own quotes: unquoted a reference becomes `"$X"`; inside
/// a double-quoted string the braced `${X}` (already one word there); inside a single-quoted string,
/// where nothing expands, the string is closed around `"$X"` and reopened. A backslash right before
/// a placeholder would only escape the quote or `$`; the reference wins.
fn posix_line(pieces: &[Piece<'_>]) -> String {
    #[derive(Clone, Copy, PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }
    let mut line = String::new();
    let mut quote = Quote::None;
    let mut escaped = false;
    for piece in pieces {
        match piece {
            Piece::Text(literal) => {
                for c in literal.chars() {
                    if escaped {
                        escaped = false;
                    } else {
                        match (quote, c) {
                            (Quote::None | Quote::Double, '\\') => escaped = true,
                            (Quote::None, '\'') => quote = Quote::Single,
                            (Quote::None, '"') => quote = Quote::Double,
                            (Quote::Single, '\'') | (Quote::Double, '"') => quote = Quote::None,
                            _ => {}
                        }
                    }
                    line.push(c);
                }
            }
            Piece::Var(placeholder) => {
                if escaped {
                    line.pop();
                    escaped = false;
                }
                let name = env_name(placeholder);
                match quote {
                    Quote::None => line.push_str(&format!("\"${name}\"")),
                    Quote::Double => line.push_str(&format!("${{{name}}}")),
                    Quote::Single => line.push_str(&format!("'\"${name}\"'")),
                }
            }
        }
    }
    line
}

/// One character of the template or one placeholder, as PowerShell sees it.
enum PsItem {
    /// `word`: unquoted, unescaped and no operator or separator – text that can sit inside a string.
    Char { c: char, word: bool },
    /// `unquoted`: not already inside a string of the template.
    Var { name: String, unquoted: bool },
}

/// Characters that PowerShell reads as plain text in argument mode and that mean the same inside
/// a double-quoted string. Everything else (whitespace, `;|&(){},<>'"`$#@`) ends the word.
fn ps_word_char(c: char) -> bool {
    c.is_alphanumeric() || "._-:/\\[]=+~%!?*^".contains(c)
}

/// The PowerShell line. Unquoted, `${env:X}.bak` is member access and `${env:X}[0]` indexing,
/// both of which yield nothing. So a reference and the text around it in the same word become one
/// expandable string: `"${env:FORKYARD_FILE}.bak"`. A leading `-Name:` stays outside the string,
/// so it is still a named parameter. Inside a string of the template the bare reference is enough.
/// A variable of the template right before (`$HOME/${file}`) joins the string; such a string at the
/// start of a statement is called with `&` (`& "${env:FORKYARD_FILE}" --help`).
fn powershell_line(pieces: &[Piece<'_>]) -> String {
    #[derive(Clone, Copy, PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }
    let mut items = Vec::new();
    let mut quote = Quote::None;
    let mut escaped = false;
    for piece in pieces {
        match piece {
            Piece::Text(literal) => {
                let chars: Vec<char> = literal.chars().collect();
                for (at, &c) in chars.iter().enumerate() {
                    // `$HOME`, `$env:TEMP`: a variable of the template expands inside the string as well.
                    let variable = c == '$' && chars.get(at + 1).is_some_and(|&next| next.is_alphanumeric() || next == '_');
                    let word = quote == Quote::None && !escaped && (ps_word_char(c) || variable);
                    if escaped {
                        escaped = false;
                    } else {
                        match (quote, c) {
                            (Quote::None | Quote::Double, '`') => escaped = true,
                            (Quote::None, '\'') => quote = Quote::Single,
                            (Quote::None, '"') => quote = Quote::Double,
                            (Quote::Single, '\'') | (Quote::Double, '"') => quote = Quote::None,
                            _ => {}
                        }
                    }
                    items.push(PsItem::Char { c, word });
                }
            }
            Piece::Var(placeholder) => {
                // A backtick right before `${…}` would only escape the `$`; the reference wins.
                escaped = false;
                items.push(PsItem::Var { name: env_name(placeholder), unquoted: quote == Quote::None });
            }
        }
    }

    let in_word = |item: &PsItem| matches!(item, PsItem::Char { word: true, .. } | PsItem::Var { unquoted: true, .. });
    let push = |line: &mut String, item: &PsItem| match item {
        PsItem::Char { c, .. } => line.push(*c),
        PsItem::Var { name, .. } => line.push_str(&format!("${{env:{name}}}")),
    };
    let mut line = String::new();
    let mut index = 0;
    // At the start of a statement (line start, after `;`, `|`, `&&`, a line break): a quoted string
    // there is a value, so it gets the call operator `&`.
    let mut command_position = true;
    let mut previous = ' ';
    while index < items.len() {
        if !in_word(&items[index]) {
            if let PsItem::Char { c, .. } = items[index] {
                if !c.is_whitespace() {
                    command_position = matches!(c, ';' | '|' | '\n' | '\r') || (c == '&' && previous == '&');
                    previous = c;
                }
            }
            push(&mut line, &items[index]);
            index += 1;
            continue;
        }
        let end = items[index..].iter().position(|item| !in_word(item)).map_or(items.len(), |len| index + len);
        let word = &items[index..end];
        match word.iter().position(|item| matches!(item, PsItem::Var { .. })) {
            None => word.iter().for_each(|item| push(&mut line, item)),
            Some(first_var) => {
                let mut start = 0;
                if matches!(word[0], PsItem::Char { c: '-', .. }) {
                    if let Some(colon) = word[..first_var].iter().position(|item| matches!(item, PsItem::Char { c: ':', .. })) {
                        start = colon + 1;
                    }
                }
                if start == 0 && command_position {
                    line.push_str("& ");
                }
                word[..start].iter().for_each(|item| push(&mut line, item));
                line.push('"');
                word[start..].iter().for_each(|item| push(&mut line, item));
                line.push('"');
            }
        }
        command_position = false;
        previous = 'a';
        index = end;
    }
    line
}

/// `git`: Git's arguments. No value from the context or a text field may become an option.
pub fn git_args(def: &CustomCommandDef, values: &Values) -> CoreResult<Vec<String>> {
    let tokens = expand_tokens(&def.run, values)?;
    if let Some((arg, _)) = tokens.iter().find(|(arg, leading_value)| *leading_value && arg.starts_with('-')) {
        return Err(CoreError::not_allowed(format!("“{arg}” starts with “-”: a value can’t become an option of Git.")));
    }
    let args: Vec<String> = tokens.into_iter().map(|(arg, _)| arg).collect();
    definition::check_git_args(&args).map_err(CoreError::not_allowed)?;
    Ok(args)
}

/// `url`: the address with percent-encoded values.
pub fn url(def: &CustomCommandDef, values: &Values) -> CoreResult<String> {
    let mut out = String::new();
    for piece in parts(&def.run)? {
        match piece {
            Piece::Text(literal) => out.push_str(literal),
            Piece::Var(placeholder) => out.push_str(&crate::http::encode(values.lookup(&placeholder)?.0)),
        }
    }
    definition::check_url_template(&out).map_err(CoreError::not_allowed)?;
    Ok(out)
}

/// The known values as `FORKYARD_*` environment variables (every `shell` run gets them).
pub fn environment(values: &Values) -> Vec<(String, String)> {
    let mut env = vec![(env_name(&Placeholder::Repo), values.repo.clone())];
    for (placeholder, value) in [(Placeholder::Sha, &values.sha), (Placeholder::Branch, &values.branch), (Placeholder::File, &values.file), (Placeholder::Remote, &values.remote)] {
        if let Some(value) = value {
            env.push((env_name(&placeholder), value.clone()));
        }
    }
    for (id, input) in &values.inputs {
        env.push((env_name(&Placeholder::Input(id.clone())), input.value.clone()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::model::{CustomCommandCwd, CustomCommandKind, CustomCommandScope};
    use CustomCommandKind::{Git, Shell, Url};

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

    fn values() -> Values {
        let mut inputs = BTreeMap::new();
        inputs.insert("text".to_string(), InputValue { value: "a b; $(touch x)".into(), from_definition: false });
        inputs.insert("leer".to_string(), InputValue { value: String::new(), from_definition: true });
        inputs.insert("flag".to_string(), InputValue { value: "--oneline".into(), from_definition: true });
        inputs.insert("dash".to_string(), InputValue { value: "--upload-pack=evil".into(), from_definition: false });
        Values {
            repo: "/home/anna/mein repo".into(),
            sha: Some("abc1234".into()),
            branch: Some("feature/äpfel+birnen".into()),
            file: Some("docs/read me.md".into()),
            remote: None,
            inputs,
        }
    }

    #[test]
    fn every_value_becomes_exactly_one_argument() {
        let (program, args) = shell_args(&def(Shell, "git rev-parse --sq-quote ${input:text} --msg=${branch} ${input:leer} ${file}"), &values()).unwrap();
        assert_eq!(program, "git");
        assert_eq!(args, ["rev-parse", "--sq-quote", "a b; $(touch x)", "--msg=feature/äpfel+birnen", "docs/read me.md"]);
    }

    #[test]
    fn missing_context_is_named() {
        let error = shell_args(&def(Shell, "echo ${remote}"), &values()).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed);
        assert!(error.message.contains("remote"), "{}", error.message);
    }

    #[test]
    fn values_never_become_git_options() {
        assert_eq!(git_args(&def(Git, "log ${input:flag} -1 ${sha}"), &values()).unwrap(), ["log", "--oneline", "-1", "abc1234"]);
        let error = git_args(&def(Git, "fetch ${input:dash}"), &values()).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed);
        assert!(error.message.contains("--upload-pack=evil"), "{}", error.message);
        // Inside an argument a value is harmless: it stays part of that argument.
        assert_eq!(git_args(&def(Git, "commit --message=${input:dash}"), &values()).unwrap(), ["commit", "--message=--upload-pack=evil"]);
        let mut forced = values();
        forced.inputs.insert("flag".into(), InputValue { value: "--force".into(), from_definition: true });
        assert!(git_args(&def(Git, "push ${input:flag}"), &forced).unwrap_err().message.contains("--force-with-lease"));
    }

    #[test]
    fn url_values_are_encoded() {
        let url = url(&def(Url, "https://ci.example.com/b/${branch}?q=${input:text}&f=${file}"), &values()).unwrap();
        assert_eq!(url, "https://ci.example.com/b/feature%2F%C3%A4pfel%2Bbirnen?q=a%20b%3B%20%24%28touch%20x%29&f=docs%2Fread%20me.md");
    }

    #[test]
    fn with_a_shell_the_line_only_names_environment_variables() {
        let mut d = def(Shell, "echo ${input:text} | tee ${file}");
        d.shell = true;
        let (program, args) = shell_line(&d, &values(), false).unwrap();
        assert_eq!(program, "sh");
        assert_eq!(args, ["-c".to_string(), "echo \"$FORKYARD_INPUT_TEXT\" | tee \"$FORKYARD_FILE\"".to_string()]);
        let (program, args) = shell_line(&d, &values(), true).unwrap();
        assert_eq!(program, "powershell.exe");
        assert_eq!(args.last().unwrap(), "echo \"${env:FORKYARD_INPUT_TEXT}\" | tee \"${env:FORKYARD_FILE}\"");
        assert!(!args.iter().any(|a| a.contains("touch")), "no value is part of the line");
        let env = environment(&values());
        assert!(env.contains(&("FORKYARD_INPUT_TEXT".to_string(), "a b; $(touch x)".to_string())));
        assert!(env.contains(&("FORKYARD_SHA".to_string(), "abc1234".to_string())));
        assert!(env.contains(&("FORKYARD_REPO".to_string(), "/home/anna/mein repo".to_string())));
        assert!(!env.iter().any(|(key, _)| key == "FORKYARD_REMOTE"), "only what is known");
    }

    fn posix_line(run: &str) -> String {
        let mut d = def(Shell, run);
        d.shell = true;
        shell_line(&d, &values(), false).unwrap().1.pop().unwrap()
    }

    #[test]
    fn posix_placeholders_already_in_quotes_stay_one_argument() {
        // Inside double quotes the bare reference (braced, so text after it is not part of the name).
        assert_eq!(posix_line("cat \"${file}\""), "cat \"${FORKYARD_FILE}\"");
        assert_eq!(posix_line("cp \"${file}\" \"${file}_bak\""), "cp \"${FORKYARD_FILE}\" \"${FORKYARD_FILE}_bak\"");
        assert_eq!(posix_line("echo \"a \\\" ${sha} b\""), "echo \"a \\\" ${FORKYARD_SHA} b\"");
        // Inside single quotes nothing expands: the string is closed around the reference.
        assert_eq!(posix_line("echo '${file}'"), "echo ''\"$FORKYARD_FILE\"''");
        assert_eq!(posix_line("echo 'x ${sha} y'"), "echo 'x '\"$FORKYARD_SHA\"' y'");
        // Unquoted as before; an escaped quote does not open a string.
        assert_eq!(posix_line("echo \\' ${file}"), "echo \\' \"$FORKYARD_FILE\"");
        assert_eq!(posix_line("echo ${file}.bak"), "echo \"$FORKYARD_FILE\".bak");
    }

    fn windows_line(run: &str) -> String {
        let mut d = def(Shell, run);
        d.shell = true;
        shell_line(&d, &values(), true).unwrap().1.pop().unwrap()
    }

    #[test]
    fn powershell_reads_a_placeholder_and_its_neighbours_as_one_string() {
        // Unquoted, `${env:X}.bak` is member access and `${env:X}[0]` indexing: both yield nothing.
        // As one expandable string the text next to the reference stays text.
        assert_eq!(
            windows_line("copy ${file} ${file}.bak; echo ${input:text}_old ${repo}:x ${sha}[0]"),
            "copy \"${env:FORKYARD_FILE}\" \"${env:FORKYARD_FILE}.bak\"; echo \"${env:FORKYARD_INPUT_TEXT}_old\" \"${env:FORKYARD_REPO}:x\" \"${env:FORKYARD_SHA}[0]\""
        );
        // Text before the reference joins the string; operators and separators stay outside.
        assert_eq!(windows_line("echo pre_${sha}.x,(${branch})|out"), "echo \"pre_${env:FORKYARD_SHA}.x\",(\"${env:FORKYARD_BRANCH}\")|out");
        // A named parameter keeps its `-Name:` outside the string.
        assert_eq!(windows_line("Copy-Item -Destination:${file}.bak"), "Copy-Item -Destination:\"${env:FORKYARD_FILE}.bak\"");
        // Already inside a string the reference needs no quotes of its own.
        assert_eq!(windows_line("echo \"x ${file}.bak\" 'y'"), "echo \"x ${env:FORKYARD_FILE}.bak\" 'y'");
    }

    #[test]
    fn powershell_keeps_a_variable_of_the_template_next_to_a_placeholder() {
        // Inside an expandable string `$HOME` and `$env:TEMP` expand as they do unquoted.
        assert_eq!(windows_line("copy x $HOME/${file}"), "copy x \"$HOME/${env:FORKYARD_FILE}\"");
        assert_eq!(windows_line("copy x $env:TEMP\\${file}"), "copy x \"$env:TEMP\\${env:FORKYARD_FILE}\"");
        // Without a placeholder in the word nothing changes.
        assert_eq!(windows_line("echo $HOME ${file}"), "echo $HOME \"${env:FORKYARD_FILE}\"");
        // A `$` that starts no variable stays outside.
        assert_eq!(windows_line("echo $(${file})"), "echo $(\"${env:FORKYARD_FILE}\")");
    }

    #[test]
    fn powershell_calls_a_placeholder_in_command_position() {
        // A quoted string at the start of a statement is a value, not a call: `&` makes it one.
        assert_eq!(windows_line("${file} --help"), "& \"${env:FORKYARD_FILE}\" --help");
        assert_eq!(windows_line("cd x; ${file}.exe -v | ${file}"), "cd x; & \"${env:FORKYARD_FILE}.exe\" -v | & \"${env:FORKYARD_FILE}\"");
        // Arguments, a call already written out and expressions stay as they are.
        assert_eq!(windows_line("& ${file} -v"), "& \"${env:FORKYARD_FILE}\" -v");
        assert_eq!(windows_line("echo (${file})"), "echo (\"${env:FORKYARD_FILE}\")");
    }

    /// Prints its arguments joined with `|`.
    const ECHO_ARGS: &str = "& { [Console]::Out.Write(($args -join '|')) } ${file}.bak ${sha}[0] ${input:text}_old ${repo}:x \"q ${branch}.y\"";

    #[test]
    fn the_powershell_probe_line_is_what_windows_runs() {
        assert_eq!(
            windows_line(ECHO_ARGS),
            "& { [Console]::Out.Write(($args -join '|')) } \"${env:FORKYARD_FILE}.bak\" \"${env:FORKYARD_SHA}[0]\" \"${env:FORKYARD_INPUT_TEXT}_old\" \"${env:FORKYARD_REPO}:x\" \"q ${env:FORKYARD_BRANCH}.y\""
        );
    }

    /// Runs the generated line in the real PowerShell and reads the arguments back.
    #[cfg(windows)]
    #[test]
    fn powershell_receives_the_values_with_their_neighbours() {
        let mut d = def(Shell, ECHO_ARGS);
        d.shell = true;
        // ASCII only: powershell.exe writes its output in the console code page.
        let mut v = values();
        v.branch = Some("feature/apples+pears".into());
        v.repo = "C:\\Users\\anna\\my repo".into();
        let (program, args) = shell_line(&d, &v, true).unwrap();
        let output = std::process::Command::new(program).args(args).envs(environment(&v)).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "docs/read me.md.bak|abc1234[0]|a b; $(touch x)_old|C:\\Users\\anna\\my repo:x|q feature/apples+pears.y"
        );
    }

    /// A variable of the template next to a placeholder, in the real PowerShell.
    #[cfg(windows)]
    #[test]
    fn powershell_expands_a_template_variable_next_to_a_placeholder() {
        let mut d = def(Shell, "& { [Console]::Out.Write(($args -join '|')) } $env:FORKYARD_SHA/${file} x$env:FORKYARD_SHA");
        d.shell = true;
        let v = values();
        let (program, args) = shell_line(&d, &v, true).unwrap();
        let output = std::process::Command::new(program).args(args).envs(environment(&v)).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(String::from_utf8_lossy(&output.stdout), "abc1234/docs/read me.md|xabc1234");
    }
}
