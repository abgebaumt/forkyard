//! The allow list of "Git in plain language" (spec Paket 5): which Forkyard commands a plan may
//! contain, their class, their arguments (in the schema dialect of `ai::schema`) and – further
//! down – the typed action each checked step becomes and the existing core command it calls.
//! Everything else (settings, repository trust, custom commands, terminal, cockpit, cleanup,
//! `gc`/`prune`, force push without lease) has no entry and therefore cannot be in a plan;
//! extending the list is work per command.

use serde_json::{json, Map, Value};

use crate::ai::schema;
use crate::model::PlanArgKind::{Boolean, Choice, List, OptionalChoice, OptionalText, Text};
use crate::model::{PlanArgField, PlanArgKind, PlanClass, PlanCommand};
use crate::undo;

/// One argument of a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Field {
    pub name: &'static str,
    pub kind: PlanArgKind,
    pub choices: &'static [&'static str],
}

const fn field(name: &'static str, kind: PlanArgKind) -> Field {
    Field { name, kind, choices: &[] }
}

const fn choice(name: &'static str, kind: PlanArgKind, choices: &'static [&'static str]) -> Field {
    Field { name, kind, choices }
}

/// `ResetMode`, `MergeMode`, `PullMode` in their wire names.
pub const RESET_MODES: [&str; 3] = ["soft", "mixed", "hard"];
pub const MERGE_MODES: [&str; 4] = ["default", "ff_only", "no_ff", "squash"];
pub const PULL_MODES: [&str; 3] = ["ff", "ff_only", "rebase"];

const BRANCH_CREATE: &[Field] = &[field("name", Text), field("start", OptionalText), field("checkout", Boolean)];
const BRANCH_CHECKOUT: &[Field] = &[field("target", Text)];
const BRANCH_RENAME: &[Field] = &[field("name", Text), field("newName", Text)];
const BRANCH_DELETE: &[Field] = &[field("name", Text), field("force", Boolean)];
const RESET_BRANCH: &[Field] = &[field("target", Text), choice("resetMode", Choice, &RESET_MODES)];
const REBASE_START: &[Field] = &[field("onto", Text), field("branch", OptionalText)];
const CHERRY_PICK: &[Field] = &[field("commits", List)];
const REVERT_COMMIT: &[Field] = &[field("commit", Text)];
const MERGE_START: &[Field] = &[field("source", Text), choice("mergeMode", Choice, &MERGE_MODES)];
const STASH_CREATE: &[Field] = &[field("message", OptionalText), field("includeUntracked", Boolean), field("paths", List)];
const TAG_CREATE: &[Field] = &[field("name", Text), field("commit", OptionalText), field("message", OptionalText)];
const COMMIT_REWORD: &[Field] = &[field("commit", OptionalText), field("summary", Text), field("description", Text)];
const FETCH: &[Field] = &[field("remote", OptionalText), field("prune", Boolean)];
const PULL: &[Field] = &[choice("pullMode", OptionalChoice, &PULL_MODES)];
const PUSH: &[Field] = &[field("branch", OptionalText), field("remote", OptionalText), field("force", Boolean)];
const BRANCH_DELETE_REMOTE: &[Field] = &[field("remote", Text), field("name", Text)];
const TAG_PUSH: &[Field] = &[field("name", Text), field("remote", Text)];

impl PlanCommand {
    pub const ALL: [PlanCommand; 17] = [
        PlanCommand::BranchCreate,
        PlanCommand::BranchCheckout,
        PlanCommand::BranchRename,
        PlanCommand::BranchDelete,
        PlanCommand::ResetBranch,
        PlanCommand::RebaseStart,
        PlanCommand::CherryPick,
        PlanCommand::RevertCommit,
        PlanCommand::MergeStart,
        PlanCommand::StashCreate,
        PlanCommand::TagCreate,
        PlanCommand::CommitReword,
        PlanCommand::Fetch,
        PlanCommand::Pull,
        PlanCommand::Push,
        PlanCommand::BranchDeleteRemote,
        PlanCommand::TagPush,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PlanCommand::BranchCreate => "branchCreate",
            PlanCommand::BranchCheckout => "branchCheckout",
            PlanCommand::BranchRename => "branchRename",
            PlanCommand::BranchDelete => "branchDelete",
            PlanCommand::ResetBranch => "resetBranch",
            PlanCommand::RebaseStart => "rebaseStart",
            PlanCommand::CherryPick => "cherryPick",
            PlanCommand::RevertCommit => "revertCommit",
            PlanCommand::MergeStart => "mergeStart",
            PlanCommand::StashCreate => "stashCreate",
            PlanCommand::TagCreate => "tagCreate",
            PlanCommand::CommitReword => "commitReword",
            PlanCommand::Fetch => "fetch",
            PlanCommand::Pull => "pull",
            PlanCommand::Push => "push",
            PlanCommand::BranchDeleteRemote => "branchDeleteRemote",
            PlanCommand::TagPush => "tagPush",
        }
    }

    /// Steps that reach a remote are confirmed one by one and cannot be undone (spec Paket 5).
    pub fn class(self) -> PlanClass {
        match self {
            PlanCommand::Push | PlanCommand::BranchDeleteRemote | PlanCommand::TagPush => PlanClass::Outward,
            _ => PlanClass::Local,
        }
    }

    pub fn fields(self) -> &'static [Field] {
        match self {
            PlanCommand::BranchCreate => BRANCH_CREATE,
            PlanCommand::BranchCheckout => BRANCH_CHECKOUT,
            PlanCommand::BranchRename => BRANCH_RENAME,
            PlanCommand::BranchDelete => BRANCH_DELETE,
            PlanCommand::ResetBranch => RESET_BRANCH,
            PlanCommand::RebaseStart => REBASE_START,
            PlanCommand::CherryPick => CHERRY_PICK,
            PlanCommand::RevertCommit => REVERT_COMMIT,
            PlanCommand::MergeStart => MERGE_START,
            PlanCommand::StashCreate => STASH_CREATE,
            PlanCommand::TagCreate => TAG_CREATE,
            PlanCommand::CommitReword => COMMIT_REWORD,
            PlanCommand::Fetch => FETCH,
            PlanCommand::Pull => PULL,
            PlanCommand::Push => PUSH,
            PlanCommand::BranchDeleteRemote => BRANCH_DELETE_REMOTE,
            PlanCommand::TagPush => TAG_PUSH,
        }
    }

    /// What the command does, for the model (English, one sentence).
    pub fn help(self) -> &'static str {
        match self {
            PlanCommand::BranchCreate => "creates a local branch at start (null: HEAD); checkout switches to it.",
            PlanCommand::BranchCheckout => "switches to a local branch, a remote branch (creates the local one) or a commit.",
            PlanCommand::BranchRename => "renames a local branch.",
            PlanCommand::BranchDelete => "deletes a local branch; force also when it is not merged.",
            PlanCommand::ResetBranch => "moves the current branch to target; hard also discards the changes in the working directory.",
            PlanCommand::RebaseStart => "rebases branch (null: the current branch) onto onto.",
            PlanCommand::CherryPick => "applies the commits onto the current branch, in this order.",
            PlanCommand::RevertCommit => "creates a commit that takes commit back.",
            PlanCommand::MergeStart => "merges source into the current branch.",
            PlanCommand::StashCreate => "stashes the changes; paths limits it to these files (empty list: all changes).",
            PlanCommand::TagCreate => "creates a tag at commit (null: HEAD); a message makes it an annotated tag.",
            PlanCommand::CommitReword => "changes the message of commit (null: HEAD).",
            PlanCommand::Fetch => "fetches from remote (null: all remotes); prune removes remote branches deleted there.",
            PlanCommand::Pull => "pulls the upstream into the current branch (pullMode null: the repository's own setting).",
            PlanCommand::Push => "pushes branch (null: the current branch) to remote (null: its upstream); force only ever with a lease.",
            PlanCommand::BranchDeleteRemote => "deletes the branch name on remote.",
            PlanCommand::TagPush => "pushes the tag name to remote.",
        }
    }
}

/// Schema node of one argument; `nullable` for the union object of the answer schema.
fn node(field: &Field, union: bool) -> Value {
    let base = match field.kind {
        Text | OptionalText | Choice | OptionalChoice => "string",
        Boolean => "boolean",
        List => "array",
    };
    let nullable = union || matches!(field.kind, OptionalText | OptionalChoice);
    let mut node = Map::new();
    node.insert("type".into(), if nullable { json!([base, "null"]) } else { json!(base) });
    if field.kind == List {
        node.insert("items".into(), json!({"type": "string"}));
    }
    // In the union object the modes stay open text: strict providers would refuse `null` outside
    // the enum. `arg_schema` checks the values afterwards.
    if !union && !field.choices.is_empty() {
        node.insert("enum".into(), json!(field.choices));
    }
    Value::Object(node)
}

fn object(properties: Vec<(String, Value)>) -> Value {
    let required: Vec<Value> = properties.iter().map(|(name, _)| json!(name)).collect();
    let properties: Map<String, Value> = properties.into_iter().collect();
    json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false})
}

/// The command's own arguments in the dialect of `ai::schema` (with the allowed modes).
pub fn arg_schema(command: PlanCommand) -> Value {
    object(command.fields().iter().map(|f| (f.name.to_string(), node(f, false))).collect())
}

/// Every argument name of the allow list, in the order of first use.
pub fn union_fields() -> Vec<Field> {
    let mut out: Vec<Field> = Vec::new();
    for command in PlanCommand::ALL {
        for field in command.fields() {
            if !out.iter().any(|known| known.name == field.name) {
                out.push(*field);
            }
        }
    }
    out
}

/// What the model must answer: the steps (each with every argument, unused ones `null`) and a note.
pub fn answer_schema() -> Value {
    let args = object(union_fields().iter().map(|f| (f.name.to_string(), node(f, true))).collect());
    let names: Vec<&str> = PlanCommand::ALL.iter().map(|c| c.as_str()).collect();
    let step = object(vec![
        ("command".into(), json!({"type": "string", "enum": names})),
        ("args".into(), args),
        ("why".into(), json!({"type": "string"})),
    ]);
    object(vec![("steps".into(), json!({"type": "array", "items": step})), ("note".into(), json!({"type": ["string", "null"]}))])
}

/// The command's own arguments out of `args`, checked against `arg_schema`. An argument of another
/// command that is not `null` is refused ("unknown argument").
pub fn project(command: PlanCommand, args: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let own = command.fields();
    if let Some((name, _)) = args.iter().find(|(name, value)| !value.is_null() && !own.iter().any(|f| f.name == name.as_str())) {
        return Err(format!("“{}” is not an argument of {}.", undo::shorten(name, 40), command.as_str()));
    }
    let mut out = Map::new();
    for field in own {
        out.insert(field.name.to_string(), args.get(field.name).cloned().unwrap_or(Value::Null));
    }
    schema::validate(&arg_schema(command), &Value::Object(out.clone())).map_err(|reason| format!("{}: {reason}", command.as_str()))?;
    Ok(out)
}

pub fn fields_view(command: PlanCommand) -> Vec<PlanArgField> {
    command
        .fields()
        .iter()
        .map(|f| PlanArgField { name: f.name.to_string(), kind: f.kind, choices: f.choices.iter().map(|c| c.to_string()).collect() })
        .collect()
}

/// Deletes a branch or discards changes – marked "destructive" next to its class.
pub fn destructive(command: PlanCommand, args: &Map<String, Value>) -> bool {
    match command {
        PlanCommand::BranchDelete => true,
        PlanCommand::ResetBranch => args.get("resetMode").and_then(Value::as_str) == Some("hard"),
        _ => false,
    }
}

fn kind_word(field: &Field) -> String {
    match field.kind {
        Text => "text".to_string(),
        OptionalText => "text or null".to_string(),
        Boolean => "true/false".to_string(),
        List => "list of text".to_string(),
        Choice => format!("one of {}", field.choices.join("|")),
        OptionalChoice => format!("one of {} or null", field.choices.join("|")),
    }
}

/// The allow list for the model: one line per command with its arguments.
pub fn prompt_reference() -> String {
    PlanCommand::ALL
        .iter()
        .map(|command| {
            let args: Vec<String> = command.fields().iter().map(|f| format!("{} {}", f.name, kind_word(f))).collect();
            format!("- {}({}): {}", command.as_str(), args.join(", "), command.help())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every union argument, `null` unless `partial` sets it – how a model answers.
#[cfg(test)]
pub(crate) fn full_args(partial: Value) -> Value {
    let mut map = Map::new();
    for field in union_fields() {
        map.insert(field.name.to_string(), Value::Null);
    }
    if let Value::Object(given) = partial {
        for (name, value) in given {
            map.insert(name, value);
        }
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::schema::{check_dialect, validate};
    use crate::model::{PlanCheck, PlanStepView};
    use serde_json::json;

    #[test]
    fn the_allow_list_is_exactly_the_spec_list() {
        let names: Vec<&str> = PlanCommand::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            names,
            [
                "branchCreate", "branchCheckout", "branchRename", "branchDelete", "resetBranch", "rebaseStart", "cherryPick", "revertCommit",
                "mergeStart", "stashCreate", "tagCreate", "commitReword", "fetch", "pull", "push", "branchDeleteRemote", "tagPush",
            ]
        );
        let outward: Vec<&str> = PlanCommand::ALL.iter().filter(|c| c.class() == PlanClass::Outward).map(|c| c.as_str()).collect();
        assert_eq!(outward, ["push", "branchDeleteRemote", "tagPush"]);
        for command in PlanCommand::ALL {
            assert_eq!(serde_json::to_value(command).unwrap(), json!(command.as_str()), "wire name of {command:?}");
            assert!(!command.help().is_empty());
        }
        let schema = answer_schema();
        let listed = schema["properties"]["steps"]["items"]["properties"]["command"]["enum"].as_array().unwrap().clone();
        assert_eq!(listed.len(), 17);
        for forbidden in ["settingsSet", "repoTrustSet", "customCommandRun", "terminalOpen", "agentStart", "repoCleanupRun", "gc", "prune", "pushForce"] {
            assert!(serde_json::from_value::<PlanCommand>(json!(forbidden)).is_err(), "{forbidden} is no plan command");
            assert!(!listed.contains(&json!(forbidden)), "{forbidden} is not offered to the model");
        }
    }

    #[test]
    fn every_schema_is_in_the_dialect_and_a_full_answer_validates() {
        check_dialect(&answer_schema()).unwrap();
        for command in PlanCommand::ALL {
            check_dialect(&arg_schema(command)).unwrap_or_else(|e| panic!("{}: {e}", command.as_str()));
        }
        let answer = json!({
            "steps": [
                {"command": "branchCreate", "args": full_args(json!({"name": "hotfix/größe", "checkout": true})), "why": "Neuer Branch."},
                {"command": "push", "args": full_args(json!({"branch": "hotfix/größe", "remote": "origin", "force": false})), "why": "Hochladen."}
            ],
            "note": null
        });
        validate(&answer_schema(), &answer).unwrap();
        let bad = json!({"steps": [{"command": "settingsSet", "args": full_args(json!({})), "why": "x"}], "note": null});
        assert!(validate(&answer_schema(), &bad).unwrap_err().contains("command"), "a name outside the list fails the schema");
    }

    #[test]
    fn every_argument_name_has_one_type() {
        let names: Vec<&str> = union_fields().iter().map(|f| f.name).collect();
        assert_eq!(
            names,
            [
                "name", "start", "checkout", "target", "newName", "force", "resetMode", "onto", "branch", "commits", "commit", "source",
                "mergeMode", "message", "includeUntracked", "paths", "summary", "description", "remote", "prune", "pullMode",
            ]
        );
        let base = |kind: PlanArgKind| match kind {
            PlanArgKind::Text | PlanArgKind::OptionalText => "string",
            PlanArgKind::Choice | PlanArgKind::OptionalChoice => "choice",
            PlanArgKind::Boolean => "boolean",
            PlanArgKind::List => "list",
        };
        for command in PlanCommand::ALL {
            for field in command.fields() {
                let union = union_fields().into_iter().find(|u| u.name == field.name).unwrap();
                assert_eq!(base(union.kind), base(field.kind), "{} in {}", field.name, command.as_str());
            }
        }
        // In the answer schema the modes are open text: strict providers reject `null` outside an enum.
        assert_eq!(answer_schema()["properties"]["steps"]["items"]["properties"]["args"]["properties"]["resetMode"], json!({"type": ["string", "null"]}));
        assert_eq!(arg_schema(PlanCommand::ResetBranch)["properties"]["resetMode"], json!({"type": "string", "enum": ["soft", "mixed", "hard"]}));
    }

    #[test]
    fn projection_keeps_own_arguments_and_refuses_foreign_ones() {
        let all = full_args(json!({"name": "neu", "checkout": false}));
        let own = project(PlanCommand::BranchCreate, all.as_object().unwrap()).unwrap();
        assert_eq!(Value::Object(own), json!({"name": "neu", "start": null, "checkout": false}));

        let foreign = json!({"name": "neu", "start": null, "checkout": false, "force": true});
        let err = project(PlanCommand::BranchCreate, foreign.as_object().unwrap()).unwrap_err();
        assert!(err.contains("“force” is not an argument of branchCreate"), "{err}");

        let missing = json!({"name": "neu", "start": null});
        assert!(project(PlanCommand::BranchCreate, missing.as_object().unwrap()).unwrap_err().contains("checkout"), "a missing flag is not false");
        let wrong = json!({"target": "HEAD", "resetMode": "weich"});
        assert!(project(PlanCommand::ResetBranch, wrong.as_object().unwrap()).unwrap_err().contains("resetMode"));
        let typed = json!({"commits": "abc123"});
        assert!(project(PlanCommand::CherryPick, typed.as_object().unwrap()).unwrap_err().contains("commits"));
        let pull = json!({"pullMode": null});
        assert!(project(PlanCommand::Pull, pull.as_object().unwrap()).is_ok(), "the repository's own pull mode");
    }

    #[test]
    fn destructive_steps_and_the_editor_fields() {
        let args = |v: Value| v.as_object().unwrap().clone();
        assert!(destructive(PlanCommand::BranchDelete, &args(json!({"name": "x", "force": false}))));
        assert!(destructive(PlanCommand::ResetBranch, &args(json!({"target": "HEAD~1", "resetMode": "hard"}))));
        assert!(!destructive(PlanCommand::ResetBranch, &args(json!({"target": "HEAD~1", "resetMode": "soft"}))));
        assert!(!destructive(PlanCommand::Push, &args(json!({"branch": null, "remote": null, "force": true}))), "outward is its own class");
        let fields = fields_view(PlanCommand::MergeStart);
        assert_eq!(serde_json::to_value(&fields).unwrap(), json!([
            {"name": "source", "kind": "text", "choices": []},
            {"name": "mergeMode", "kind": "choice", "choices": ["default", "ff_only", "no_ff", "squash"]}
        ]));
        assert!(prompt_reference().contains("- pull(pullMode one of ff|ff_only|rebase or null): "), "{}", prompt_reference());
    }

    #[test]
    fn the_wire_format_of_the_plan_types() {
        assert_eq!(serde_json::to_value(PlanCheck::Conflicts { files: vec!["f.txt".into()] }).unwrap(), json!({"status": "conflicts", "files": ["f.txt"]}));
        assert_eq!(serde_json::to_value(PlanCheck::NotNeeded).unwrap(), json!({"status": "not_needed"}));
        let view = PlanStepView {
            command: PlanCommand::TagPush,
            args: Map::new(),
            why: String::new(),
            class: PlanClass::Outward,
            destructive: false,
            fields: Vec::new(),
            check: PlanCheck::Clean,
        };
        let keys: Vec<String> = serde_json::to_value(&view).unwrap().as_object().unwrap().keys().cloned().collect();
        for key in ["command", "args", "why", "class", "destructive", "fields", "check"] {
            assert!(keys.contains(&key.to_string()), "{key} in {keys:?}");
        }
        assert_eq!(serde_json::to_value(crate::model::PlanStepStatus::NotRun).unwrap(), json!("not_run"));
    }
}
