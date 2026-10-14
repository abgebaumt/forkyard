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
/// is a reference to its environment variable (braced on Windows, `${env:NAME}`, so PowerShell
/// never merges the name with the text that follows). Missing values are reported as for `shell_args`.
pub fn shell_line(def: &CustomCommandDef, values: &Values, windows: bool) -> CoreResult<(String, Vec<String>)> {
    let mut line = String::new();
    for piece in parts(&def.run)? {
        match piece {
            Piece::Text(literal) => line.push_str(literal),
            Piece::Var(placeholder) => {
                values.lookup(&placeholder)?;
                let name = env_name(&placeholder);
                line.push_str(&if windows { format!("${{env:{name}}}") } else { format!("\"${name}\"") });
            }
        }
    }
    Ok(if windows {
        ("powershell.exe".to_string(), vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), line])
    } else {
        ("sh".to_string(), vec!["-c".into(), line])
    })
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
        assert_eq!(args.last().unwrap(), "echo ${env:FORKYARD_INPUT_TEXT} | tee ${env:FORKYARD_FILE}");
        // Braced, so PowerShell never merges the name with what follows (`.bak`, `_old`, `:x`).
        let mut d = def(Shell, "copy ${file} ${file}.bak; echo ${input:text}_old ${repo}:x");
        d.shell = true;
        let (_, args) = shell_line(&d, &values(), true).unwrap();
        assert_eq!(
            args.last().unwrap(),
            "copy ${env:FORKYARD_FILE} ${env:FORKYARD_FILE}.bak; echo ${env:FORKYARD_INPUT_TEXT}_old ${env:FORKYARD_REPO}:x"
        );
        assert!(!args.iter().any(|a| a.contains("touch")), "no value is part of the line");
        let env = environment(&values());
        assert!(env.contains(&("FORKYARD_INPUT_TEXT".to_string(), "a b; $(touch x)".to_string())));
        assert!(env.contains(&("FORKYARD_SHA".to_string(), "abc1234".to_string())));
        assert!(env.contains(&("FORKYARD_REPO".to_string(), "/home/anna/mein repo".to_string())));
        assert!(!env.iter().any(|(key, _)| key == "FORKYARD_REMOTE"), "only what is known");
    }
}
