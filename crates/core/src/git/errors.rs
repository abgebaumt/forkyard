//! Mapping of typical Git error output to `ErrorCode`.
//!
//! To extend: add a line to `RULES`. The first matching rule wins, so more specific rules
//! belong at the top. Matching is case-insensitive against stderr and stdout (Git runs with
//! `LC_ALL=C`, so the texts are English and stable enough). Anyone who needs to distinguish
//! more precisely for a single command uses `GitCmd::check(false)` and evaluates the result
//! themselves.

use crate::error::{CoreError, ErrorCode};
use crate::git::redact;

/// A rule: matches if one of the texts in `any` occurs
/// and – if set – additionally one from `and_any`.
pub struct Rule {
    pub any: &'static [&'static str],
    pub and_any: &'static [&'static str],
    pub code: ErrorCode,
    pub message: &'static str,
}

const fn rule(any: &'static [&'static str], code: ErrorCode, message: &'static str) -> Rule {
    Rule { any, and_any: &[], code, message }
}

const fn rule2(
    any: &'static [&'static str],
    and_any: &'static [&'static str],
    code: ErrorCode,
    message: &'static str,
) -> Rule {
    Rule { any, and_any, code, message }
}

/// The rules, most specific at the top.
pub static RULES: &[Rule] = &[
    rule2(
        &["index.lock", ".lock': file exists", "unable to create '"],
        &["file exists", "another git process"],
        ErrorCode::Locked,
        LOCKED_MESSAGE,
    ),
    rule(
        &["detected dubious ownership", "safe.directory"],
        ErrorCode::NotAllowed,
        "Git doesn’t trust this folder because it belongs to another user (safe.directory).",
    ),
    rule(
        &["not a git repository", "must be run in a work tree", "this operation must be run in a work tree"],
        ErrorCode::NotARepo,
        "The folder is not a Git repository.",
    ),
    rule(
        &["please tell me who you are", "empty ident name", "unable to auto-detect email address", "no name was given"],
        ErrorCode::IdentityMissing,
        "Name and email for commits are not set.",
    ),
    rule(
        &["aborting commit due to empty commit message", "empty commit message"],
        ErrorCode::EmptyMessage,
        "The commit message is empty.",
    ),
    rule(
        &["nothing to commit", "no changes added to commit", "nothing added to commit"],
        ErrorCode::NothingToCommit,
        "There is nothing to commit.",
    ),
    rule(
        &["host key verification failed", "remote host identification has changed", "no matching host key"],
        ErrorCode::HostKeyUnknown,
        "The server’s host key is unknown or has changed.",
    ),
    rule(
        &[
            "authentication failed",
            "could not read username",
            "could not read password",
            "permission denied (publickey",
            "terminal prompts disabled",
            "invalid username or password",
            "the requested url returned error: 401",
            "the requested url returned error: 403",
            "access denied",
            "invalid credentials",
        ],
        ErrorCode::AuthFailed,
        "Signing in to the server failed.",
    ),
    // SSH with password or one-time code, and an askpass without an answer.
    rule(
        &[
            "permission denied (password",
            "permission denied (keyboard-interactive",
            "permission denied, please try again",
            "too many authentication failures",
            "unable to read askpass response",
        ],
        ErrorCode::AuthFailed,
        "Signing in to the server failed.",
    ),
    // With `credential.interactive=false` (auto-fetch) Git doesn't prompt and reports it like this.
    rule(
        &["unable to get password from user", "unable to get username from user"],
        ErrorCode::AuthFailed,
        "Signing in to the server failed.",
    ),
    rule(
        &[
            "could not resolve host",
            "could not resolve hostname",
            "failed to connect to",
            "network is unreachable",
            "connection timed out",
            "connection refused",
            "temporary failure in name resolution",
            "unable to access",
            "operation timed out",
        ],
        ErrorCode::Offline,
        "The server can’t be reached.",
    ),
    // Network cases from clone, fetch, pull, push (sync.rs, clone_init.rs).
    rule(
        &["permission denied (", "password authentication is not available", "support for password authentication was removed", "bad credentials"],
        ErrorCode::AuthFailed,
        "Signing in to the server failed.",
    ),
    rule(
        &["operation too slow", "timeout was reached", "timed out"],
        ErrorCode::Timeout,
        "Timeout: the server took too long to respond.",
    ),
    rule(
        &["repository not found", "not found in upstream", "could not find remote branch"],
        ErrorCode::NotFound,
        "The repository or branch was not found on the server.",
    ),
    rule2(
        &["fatal: repository '"],
        &["' not found"],
        ErrorCode::NotFound,
        "The repository was not found on the server – or you don’t have access to it.",
    ),
    rule2(
        &["[rejected]", "! [remote rejected]", "failed to push some refs"],
        &["non-fast-forward", "fetch first", "stale info", "rejected"],
        ErrorCode::PushRejected,
        "Push rejected: the remote contains commits that are missing locally.",
    ),
    rule(
        &["has no upstream branch", "no upstream configured", "there is no tracking information", "no upstream branch"],
        ErrorCode::NoUpstream,
        "No upstream is set for this branch.",
    ),
    rule(
        &[
            "does not appear to be a git repository",
            "no such remote",
            "no configured push destination",
            "no remote repository specified",
        ],
        ErrorCode::NoRemote,
        "The remote doesn’t exist or can’t be reached.",
    ),
    rule(
        &[
            "you have not concluded your merge",
            "merge_head exists",
            "a cherry-pick or revert is already in progress",
            "cherry-pick is already in progress",
            "revert is already in progress",
            "it seems that there is already a rebase-merge directory",
            "it seems that there is already a rebase-apply directory",
            "you are in the middle of",
            "you need to resolve your current index first",
        ],
        ErrorCode::OperationInProgress,
        "A merge, rebase, cherry-pick or revert is already in progress.",
    ),
    rule(
        &["there is no merge to abort", "no rebase in progress", "no cherry-pick or revert in progress", "no cherry-pick in progress", "no revert in progress"],
        ErrorCode::NoOperation,
        "No operation is in progress that could be continued or aborted.",
    ),
    rule(
        &["conflict (", "automatic merge failed", "could not apply", "after resolving the conflicts", "fix conflicts and then commit"],
        ErrorCode::Conflict,
        "Conflicts occurred.",
    ),
    rule(
        &[
            "would be overwritten by",
            "please commit your changes or stash them",
            "your local changes to the following files",
            "cannot rebase: you have unstaged changes",
            "your index contains uncommitted changes",
            "the following untracked working tree files would be",
        ],
        ErrorCode::DirtyWorktree,
        "Uncommitted changes prevent this action.",
    ),
    // `git apply` (staging, unstaging, discarding hunks and lines): the file has changed since the diff.
    rule(
        &["patch does not apply", "patch failed:", "does not match index", "does not exist in index", "already exists in index", "already exists in working directory"],
        ErrorCode::StaleState,
        "The file has changed in the meantime. The view is reloading; please make your selection again.",
    ),
    rule(&["did not match any files"], ErrorCode::NotFound, "The specified file was not found."),
    rule(&["is not fully merged"], ErrorCode::NotMerged, "The branch is not merged yet."),
    rule(
        &["refusing to merge unrelated histories"],
        ErrorCode::NotAllowed,
        "The two histories have no common ancestor and can’t be merged.",
    ),
    rule(
        &["cannot do a soft reset in the middle of a merge"],
        ErrorCode::Conflict,
        "A soft reset isn’t possible with unresolved conflicts. Please resolve the conflicts first.",
    ),
    rule2(
        &["destination path"],
        &["already exists"],
        ErrorCode::PathExists,
        "The target folder already exists and is not empty.",
    ),
    rule2(&["cannot lock ref"], &["exists"], ErrorCode::NameExists, "A ref with this name (or a folder of the same name) already exists."),
    rule(&["already exists"], ErrorCode::NameExists, "The name already exists."),
    rule(
        &["is not a valid branch name", "is not a valid tag name", "not a valid ref name", "is not a valid name", "invalid branch name", "invalid tag name"],
        ErrorCode::InvalidName,
        "The name is invalid.",
    ),
    rule(
        &[
            "did not match any file(s) known to git",
            "unknown revision",
            "bad revision",
            "not a valid object name",
            "invalid reference",
            "couldn't find remote ref",
            "not a commit",
            "no such ref",
            "does not exist",
            "no such file or directory",
            "bad object",
        ],
        ErrorCode::NotFound,
        "Not found.",
    ),
    rule(
        &["hook declined", "hook failed", "pre-commit hook", "commit-msg hook", "pre-push hook"],
        ErrorCode::HookFailed,
        "A Git hook rejected the action.",
    ),
    rule(&["unable to create", "cannot lock"], ErrorCode::Locked, "A file in the repository is locked."),
    // At the very end, because these lines are often just the consequence of a more precise error.
    rule(
        &["the remote end hung up unexpectedly", "connection reset", "connection was reset", "early eof", "rpc failed", "could not read from remote repository"],
        ErrorCode::Offline,
        "The connection to the server was lost.",
    ),
];

/// The sentence of the first rule: a lock file is in the way.
///
/// The rules' sentences only say what happened. What to do is appended by the UI per error
/// code (`errorInfo` in src/app/errors.ts) – once and in its own tone. If the advice were here
/// too, the user would read it twice.
const LOCKED_MESSAGE: &str = "Another Git program is currently working in this repository (lock file present).";

/// Sentence for a full disk. Git writes packs atomically, so the repository stays valid; the
/// clean-up recognizes the case by this text (`CleanupFailure.diskFull`).
pub const DISK_FULL_MESSAGE: &str = "There is no space left on the disk. The repository is still valid; free up space and try again.";

/// Process ID from Git's “gc is already running on machine '<host>' pid <n> (use --force if not)”.
pub fn gc_running_pid(text: &str) -> Option<u32> {
    // ASCII lowercase: the byte positions stay those of the original.
    let lower = text.to_ascii_lowercase();
    let start = lower.find("gc is already running on machine '")?;
    let rest = &lower[start..];
    let at = rest.find("' pid ")? + "' pid ".len();
    rest[at..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
}

/// Text between `open` and the next `close` after the first occurrence of `marker`
/// (searched case-insensitively, cut from the original).
fn between<'a>(text: &'a str, lower: &str, marker: &str, close: char) -> Option<&'a str> {
    let start = lower.find(marker)? + marker.len();
    let rest = text.get(start..)?;
    let end = rest.find(close)?;
    Some(rest[..end].trim()).filter(|found| !found.is_empty())
}

/// The rest of the line after `marker`, without a trailing period.
fn rest_of_line<'a>(text: &'a str, lower: &str, marker: &str) -> Option<&'a str> {
    let start = lower.find(marker)? + marker.len();
    let line = text.get(start..)?.lines().next()?.trim().trim_end_matches('.');
    Some(line).filter(|found| !found.is_empty())
}

fn first_sha(text: &str) -> Option<&str> {
    text.split(|c: char| !c.is_ascii_hexdigit()).find(|word| word.len() == 40 || word.len() == 64)
}

/// Git could not sign a commit or tag. Names the key or program when the output does.
fn signing(text: &str, lower: &str) -> Option<CoreError> {
    let has = |needle: &str| lower.contains(needle);
    if let Some(found) = rest_of_line(text, lower, "couldn't load public key ") {
        let found = found.trim_end_matches('?');
        let what = match found.rsplit_once(": ") {
            Some((key, reason)) => format!("the signing key “{key}” can’t be loaded ({reason})"),
            None => format!("the signing key “{found}” can’t be loaded"),
        };
        return Some(CoreError::new(ErrorCode::SigningFailed, format!("Git couldn’t sign: {what}.")));
    }
    let signing_context = has("failed to sign the data")
        || has("unable to sign the tag")
        || has("is needed for ssh signing")
        || (has("needs to be configured") && has("signingkey"))
        || has("failed writing ssh signing key")
        || has("failed to get the ssh fingerprint")
        || has("signing failed");
    if !signing_context {
        return None;
    }
    let program = ["cannot run ", "unable to start "].iter().find_map(|marker| {
        let start = lower.find(marker)? + marker.len();
        let name = text.get(start..)?.split([':', '\n']).next()?.trim();
        Some(name).filter(|name| !name.is_empty())
    });
    let message = match program {
        Some(program) => format!("Git couldn’t sign: the signing program “{program}” can’t be started."),
        None => "Git couldn’t sign: the signing program reported an error.".to_string(),
    };
    Some(CoreError::new(ErrorCode::SigningFailed, message))
}

/// Cases where the output itself names the cause (file, line, object): the message takes it
/// over instead of stopping at "exit code 128" or wrong advice.
/// Runs before the general rules.
fn specific(text: &str) -> Option<CoreError> {
    // ASCII lowercase: the byte positions stay those of the original.
    let lower = text.to_ascii_lowercase();
    let has = |needle: &str| lower.contains(needle);

    // Signing failed (key file gone, program missing). Before everything else: the output often
    // also says "no such file or directory" or "permission denied", which would read as
    // "changed outside the app" or as a locked file.
    if let Some(error) = signing(text, &lower) {
        return Some(error);
    }
    // A full disk – before everything else: the same output often says “unable to create '…'”,
    // which would read as a lock file.
    if has("no space left on device") || has("not enough space on the disk") {
        return Some(CoreError::io(DISK_FULL_MESSAGE));
    }
    // `git gc` while another gc of this repository runs (its gc.pid names a live process).
    if let Some(pid) = gc_running_pid(text) {
        return Some(CoreError::locked(format!("Git is already cleaning up this repository (process {pid}). Try again later.")));
    }
    // Name or path too long for the file system – never a "lock".
    if has("filename too long") || has("file name too long") {
        return Some(CoreError::invalid_name(
            "The name is too long: together with the repository’s path, the file system doesn’t allow it. Please choose a shorter name.",
        ));
    }
    // Access to a file or folder denied (not the SSH sign-in).
    // The Git directory itself is not writable (read-only, foreign owner).
    if has("insufficient permission for adding an object") {
        return Some(CoreError::io(
            "You don’t have write permission for this repository’s Git directory (.git): Git can’t store anything there. Viewing still works; to commit, stage or discard you need write access to the folder.",
        ));
    }
    let local_denied = has("permission denied") && !has("permission denied (") && !has("permission denied, please");
    if local_denied {
        let path = between(text, &lower, "open(\"", '"')
            .or_else(|| between(text, &lower, "could not create work tree dir '", '\''))
            .or_else(|| between(text, &lower, "unable to create file ", ':'))
            .or_else(|| between(text, &lower, "cannot hash ", '\n'))
            .or_else(|| between(text, &lower, "unable to unlink old '", '\''))
            .or_else(|| between(text, &lower, "could not open '", '\''))
            .or_else(|| between(text, &lower, "unable to index file '", '\''));
        let what = match path {
            Some(path) => format!("“{path}” can’t be accessed: access denied."),
            None => "Access denied.".to_string(),
        };
        return Some(CoreError::io(format!(
            "{what} You don’t have permission to read or write there, or another program currently has the file open."
        )));
    }
    // core.safecrlf forbids converting the line endings.
    for (marker, from, to) in [("crlf would be replaced by lf in ", "CRLF", "LF"), ("lf would be replaced by crlf in ", "LF", "CRLF")] {
        if let Some(file) = rest_of_line(text, &lower, marker) {
            return Some(CoreError::not_allowed(format!(
                "“{file}” can’t be staged: Git would convert its line endings from {from} to {to}, and the core.safecrlf setting forbids that. Save the file with consistent line endings – or change core.safecrlf in the Git configuration."
            )));
        }
    }
    // The server's key is a DIFFERENT one from the one confirmed earlier – that is something else
    // than a still unknown server, and it never comes with a prompt.
    if has("remote host identification has changed") {
        let entry = rest_of_line(text, &lower, " key in ").map(|place| format!(" The old entry is in {place}.")).unwrap_or_default();
        return Some(CoreError::new(
            ErrorCode::HostKeyUnknown,
            format!(
                "The server’s host key has changed: it no longer matches the one you confirmed earlier. This may be a newly set up server – or an attack on the connection. Compare the fingerprint with the information from the provider; only if it matches, remove the server’s old entry from the known_hosts file and connect again.{entry}"
            ),
        ));
    }
    if has("could not lock config file") {
        return Some(CoreError::new(ErrorCode::Locked, LOCKED_MESSAGE));
    }
    // Damaged configuration, damaged index, missing objects: name the damage.
    if let Some(found) = rest_of_line(text, &lower, "bad config line ") {
        let (line, file) = found.split_once(" in file ").unwrap_or((found, ".git/config"));
        return Some(CoreError::io(format!(
            "The Git configuration is damaged: line {line} in “{file}” can’t be read. Open the file in an editor and fix or remove the line."
        )));
    }
    if has("index file corrupt") || has("bad index file") || has("index file smaller than expected") || has("bad signature 0x") || has("bad index version") {
        return Some(CoreError::io(
            "The repository’s index (.git/index) is damaged. The history is not affected. To fix it in a terminal: delete the file .git/index and run “git reset” – anything that was staged has to be staged again afterwards.",
        ));
    }
    let object_missing = has("missing object")
        || has("unable to read tree")
        || has("could not read ") && first_sha(text).is_some()
        || has("unable to read ") && first_sha(text).is_some()
        // Not "bad object <sha>": Git answers that for a SHA that never existed, too.
        || (has("loose object") && has("corrupt"))
        || (has("object file") && has("is empty"))
        || has("invalid sha1 pointer")
        || has("unable to find ") && first_sha(text).is_some();
    if object_missing && !has("could not read from remote repository") {
        let which = first_sha(text).map(|sha| format!(" ({})", &sha[..7])).unwrap_or_default();
        return Some(CoreError::io(format!(
            "An object in the repository is missing or damaged{which}. “git fsck” in a terminal shows the extent; a fetch or a fresh clone can bring back missing objects."
        )));
    }
    None
}

/// Maps Git output to an error code if a rule matches.
pub fn match_rule(text: &str) -> Option<&'static Rule> {
    let lower = text.to_lowercase();
    RULES.iter().find(|r| {
        r.any.iter().any(|n| lower.contains(n)) && (r.and_any.is_empty() || r.and_any.iter().any(|n| lower.contains(n)))
    })
}

/// Builds a `CoreError` from a failed Git call.
/// `subcommand` is e.g. "commit", `exit_code` the exit code.
pub fn classify(subcommand: &str, exit_code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> CoreError {
    let err_text = redact::redact_bytes(stderr);
    let out_text = redact::redact_bytes(stdout);
    let combined = if out_text.trim().is_empty() {
        err_text.clone()
    } else if err_text.trim().is_empty() {
        out_text.clone()
    } else {
        format!("{err_text}\n{out_text}")
    };
    let known = specific(&combined).or_else(|| match_rule(&combined).map(|rule| CoreError::new(rule.code, rule.message)));
    let error = match known {
        Some(error) => error,
        None => {
            let code = exit_code.map(|c| c.to_string()).unwrap_or_else(|| "–".into());
            CoreError::unknown(format!("Git command “git {subcommand}” failed (exit code {code})."))
        }
    };
    error.with_git_output(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(stderr: &str) -> ErrorCode {
        classify("x", Some(128), b"", stderr.as_bytes()).code
    }

    #[test]
    fn typical_errors() {
        assert_eq!(code("fatal: not a git repository (or any of the parent directories): .git"), ErrorCode::NotARepo);
        assert_eq!(
            code("fatal: Unable to create 'C:/r/.git/index.lock': File exists.\n\nAnother git process seems to be running"),
            ErrorCode::Locked
        );
        assert_eq!(code("fatal: a branch named 'main' already exists"), ErrorCode::NameExists);
        assert_eq!(code("fatal: 'a..b' is not a valid branch name"), ErrorCode::InvalidName);
        assert_eq!(code("error: the branch 'x' is not fully merged."), ErrorCode::NotMerged);
        assert_eq!(code("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), ErrorCode::AuthFailed);
        assert_eq!(code("fatal: unable to access 'https://x/': Could not resolve host: x"), ErrorCode::Offline);
        assert_eq!(
            code(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'r'"),
            ErrorCode::PushRejected
        );
        assert_eq!(code("fatal: The current branch x has no upstream branch."), ErrorCode::NoUpstream);
        assert_eq!(code("Author identity unknown\n\n*** Please tell me who you are."), ErrorCode::IdentityMissing);
        assert_eq!(
            code("error: Your local changes to the following files would be overwritten by checkout:\n\ta"),
            ErrorCode::DirtyWorktree
        );
        assert_eq!(code("fatal: There is no merge to abort (MERGE_HEAD missing)."), ErrorCode::NoOperation);
        assert_eq!(code("CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed"), ErrorCode::Conflict);
        assert_eq!(code("fatal: ambiguous argument 'zzz': unknown revision or path"), ErrorCode::NotFound);
        assert_eq!(code("etwas ganz anderes"), ErrorCode::Unknown);
    }

    /// The output names the cause: then it appears in the message.
    #[test]
    fn specific_causes_are_named() {
        let e = classify("branch", Some(128), b"", b"fatal: cannot lock ref 'refs/heads/lang/xxx': Unable to create 'C:/r/.git/refs/heads/lang/xxx.lock': Filename too long");
        assert_eq!(e.code, ErrorCode::InvalidName);
        assert!(e.message.contains("too long") && !e.message.contains("locked"), "{}", e.message);

        let e = classify("diff", Some(128), b"", b"error: open(\"src/a.txt\"): Permission denied\nfatal: cannot hash src/a.txt");
        assert_eq!(e.code, ErrorCode::Io);
        assert!(e.message.contains("“src/a.txt”") && e.message.contains("access denied"), "{}", e.message);
        let e = classify("clone", Some(128), b"", b"fatal: could not create work tree dir 'C:/ziel/x': Permission denied");
        assert!(e.code == ErrorCode::Io && e.message.contains("“C:/ziel/x”"), "{}", e.message);
        // Signing in via SSH stays a sign-in error.
        assert_eq!(code("git@x: Permission denied (publickey).\nfatal: Could not read from remote repository."), ErrorCode::AuthFailed);

        let e = classify("add", Some(128), b"", b"fatal: CRLF would be replaced by LF in gemischt.txt");
        assert_eq!(e.code, ErrorCode::NotAllowed);
        assert!(e.message.contains("“gemischt.txt”") && e.message.contains("core.safecrlf"), "{}", e.message);

        assert_eq!(code("error: could not lock config file .git/config: File exists"), ErrorCode::Locked);
        let e = classify("add", Some(128), b"", b"error: insufficient permission for adding an object to repository database .git/objects\nerror: README.md: failed to insert into database");
        assert!(e.code == ErrorCode::Io && e.message.contains("write permission"), "{}", e.message);

        let e = classify("status", Some(128), b"", b"fatal: bad config line 12 in file .git/config");
        assert!(e.code == ErrorCode::Io && e.message.contains("line 12") && e.message.contains(".git/config"), "{}", e.message);
        let e = classify("status", Some(128), b"", b"error: bad signature 0x4d5a9000\nfatal: index file corrupt");
        assert!(e.code == ErrorCode::Io && e.message.contains(".git/index"), "{}", e.message);
        let sha = "1234567890123456789012345678901234567890";
        for text in [format!("fatal: unable to read {sha}"), format!("fatal: missing object {sha} for refs/heads/x"), format!("error: Could not read {sha}\nfatal: revision walk setup failed")] {
            let e = classify("log", Some(128), b"", text.as_bytes());
            assert!(e.code == ErrorCode::Io && e.message.contains("object") && e.message.contains("1234567"), "{text}: {}", e.message);
        }
        // An unknown name or SHA stays "not found", a network error a network error.
        assert_eq!(code("fatal: bad object refs/heads/kaputt"), ErrorCode::NotFound);
        assert_eq!(code(&format!("fatal: bad object {sha}")), ErrorCode::NotFound);
        assert_eq!(code("fatal: Could not read from remote repository."), ErrorCode::Offline);
    }

    /// Signing failures name the signing problem – never "not found" or "locked".
    #[test]
    fn signing_failures_have_their_own_code() {
        let e = classify("commit", Some(128), b"", b"error: Couldn't load public key /home/a/.ssh/weg.pub: No such file or directory?\n\nfatal: failed to write commit object");
        assert_eq!(e.code, ErrorCode::SigningFailed);
        assert!(e.message.contains("“/home/a/.ssh/weg.pub”") && e.message.contains("No such file or directory"), "{}", e.message);
        assert_eq!(code("error: gpg failed to sign the data\nfatal: failed to write commit object"), ErrorCode::SigningFailed);
        assert_eq!(code("error: cannot run gpg: No such file or directory\nerror: gpg failed to sign the data\nfatal: failed to write commit object"), ErrorCode::SigningFailed);
        assert_eq!(code("error: gpg failed to sign the data\nerror: unable to sign the tag"), ErrorCode::SigningFailed);
        assert_eq!(code("fatal: either user.signingkey or gpg.ssh.defaultKeyCommand needs to be configured"), ErrorCode::SigningFailed);
        assert_eq!(code("error: ssh-keygen -Y sign is needed for ssh signing (available in openssh version 8.2p1+)"), ErrorCode::SigningFailed);
        // Unrelated "no such file" stays not_found.
        assert_eq!(code("fatal: cannot stat 'x': No such file or directory"), ErrorCode::NotFound);
    }

    /// A full disk and a running `git gc` name their cause; foreign lock files stay `locked`.
    #[test]
    fn full_disk_and_running_gc_are_named() {
        for text in [
            "fatal: write error: No space left on device\nerror: failed to run repack",
            "fatal: Unable to create temporary file '/r/.git/objects/pack/tmp_pack_Ab12Cd': No space left on device",
            "error: unable to write file C:/r/.git/objects/pack/tmp_pack_x: There is not enough space on the disk.",
        ] {
            let e = classify("gc", Some(128), b"", text.as_bytes());
            assert_eq!((e.code, e.message.as_str()), (ErrorCode::Io, DISK_FULL_MESSAGE), "{text}");
            assert!(e.git_output.is_some(), "Git's own words stay readable");
        }
        let running = "fatal: gc is already running on machine 'werkstatt-pc' pid 4711 (use --force if not)";
        let e = classify("gc", Some(128), b"", running.as_bytes());
        assert_eq!(e.code, ErrorCode::Locked);
        assert!(e.message.contains("process 4711") && !e.message.contains("--force"), "{}", e.message);
        assert_eq!(gc_running_pid(running), Some(4711));
        // A host name with " pid " in it does not confuse the number.
        assert_eq!(gc_running_pid("fatal: gc is already running on machine 'box pid 9' pid 12 (use --force if not)"), Some(12));
        assert_eq!(gc_running_pid("fatal: Unable to create '/r/.git/gc.pid.lock': File exists."), None);
        assert_eq!(code("fatal: Unable to create '/r/.git/gc.pid.lock': File exists.\n\nAnother git process seems to be running"), ErrorCode::Locked);
        assert_eq!(code("fatal: Unable to create 'C:/r/.git/index.lock': File exists.\n\nAnother git process seems to be running"), ErrorCode::Locked);
    }

    #[test]
    fn network_errors() {
        assert_eq!(code("fatal: unable to access 'https://x/r.git/': The requested URL returned error: 403"), ErrorCode::AuthFailed);
        assert_eq!(code("fatal: Authentication failed for 'https://x/r.git/'"), ErrorCode::AuthFailed);
        assert_eq!(code("git@x: Permission denied (publickey).\nfatal: Could not read from remote repository."), ErrorCode::AuthFailed);
        assert_eq!(code("user@x: Permission denied (password,keyboard-interactive).\nfatal: Could not read from remote repository."), ErrorCode::AuthFailed);
        assert_eq!(code("Host key verification failed.\nfatal: Could not read from remote repository."), ErrorCode::HostKeyUnknown);
        assert_eq!(code("ssh: Could not resolve hostname x: Name or service not known"), ErrorCode::Offline);
        assert_eq!(code("ssh: connect to host x port 22: Connection refused"), ErrorCode::Offline);
        assert_eq!(code("ssh: connect to host x port 22: Connection timed out"), ErrorCode::Offline);
        assert_eq!(code("error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 10 seconds"), ErrorCode::Timeout);
        assert_eq!(code("fatal: unable to connect to x: errno=Unknown error: read timed out"), ErrorCode::Timeout);
        assert_eq!(code("remote: Repository not found.\nfatal: repository 'https://x/a/b.git/' not found"), ErrorCode::NotFound);
        assert_eq!(code("fatal: Remote branch weg not found in upstream origin"), ErrorCode::NotFound);
        assert_eq!(code("fatal: repository 'C:/x/y' does not exist"), ErrorCode::NotFound);
        assert_eq!(code("fatal: 'C:/x/y' does not appear to be a git repository\nfatal: Could not read from remote repository."), ErrorCode::NoRemote);
        assert_eq!(code("fatal: the remote end hung up unexpectedly\nfatal: early EOF"), ErrorCode::Offline);
        // The more precise cause wins over "hung up".
        assert_eq!(code("fatal: couldn't find remote ref x\nfatal: the remote end hung up unexpectedly"), ErrorCode::NotFound);
    }

    #[test]
    fn nothing_to_commit_on_stdout() {
        let e = classify("commit", Some(1), b"On branch main\nnothing to commit, working tree clean\n", b"");
        assert_eq!(e.code, ErrorCode::NothingToCommit);
        assert!(e.git_output.is_some());
    }

    #[test]
    fn credentials_removed_from_output() {
        let e = classify("fetch", Some(128), b"", b"fatal: unable to access 'https://bob:secret@example.com/r.git/': x");
        let out = e.git_output.unwrap_or_default();
        assert!(!out.contains("secret"));
        assert!(!out.contains("bob"));
    }
}
