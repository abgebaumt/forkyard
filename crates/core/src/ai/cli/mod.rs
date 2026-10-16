//! Command-line AI providers (Teilpaket 1b): Claude Code, Codex and opencode with the sign-in the
//! user already has – Forkyard stores nothing of it.
//!
//! - Every call runs through `proc::Proc` in a fresh, empty folder under the data folder (never in
//!   a repository: the tools would load its configuration and could read files such as `.env`
//!   themselves), without a shell; prompt and context only on stdin, the schema as Forkyard's own
//!   argument (Claude Code), as a file in that folder (Codex) or in the prompt. The folder is removed
//!   afterwards, also on error and cancel.
//! - What a tool can is read from its `--help` once per path and version. A missing safety switch
//!   (tools off, setting sources, sandbox, permissions, no stored sessions) refuses the tool
//!   (`ai_unsupported_version`); only the schema may fall back into the prompt.
//! - Time limit: the function's limit plus 30 s for the start. Cancel ends the process tree.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::util;

#[derive(Default)]
struct SearchDir {
    dir: Mutex<Option<PathBuf>>,
}

/// Search the tools only in `dir`: no PATH, no install folders, no login shell (tests; the debug
/// switch `FORKYARD_AI_CLI_DIR`). `None` = the normal search.
pub fn configure_dir(core: &Core, dir: Option<PathBuf>) {
    *core.state::<SearchDir>().dir.lock() = dir;
}

pub fn search_dir(core: &Core) -> Option<PathBuf> {
    core.state::<SearchDir>().dir.lock().clone()
}

/// A fresh empty folder `<data>/tmp/ai-<id>` for one call; removed when the guard is dropped.
pub struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    pub fn new(core: &Core) -> CoreResult<ScratchDir> {
        let path = core.data_dir().join("tmp").join(format!("ai-{}", util::new_id()));
        std::fs::create_dir_all(&path).map_err(|e| CoreError::io(format!("The temporary folder for the AI tool could not be created: {e}")))?;
        Ok(ScratchDir { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
