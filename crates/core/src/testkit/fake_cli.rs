//! Installing the fake AI command-line tool (`src/bin/forkyard-fake-cli.rs`) under the name of the
//! tool it plays, and reading what it was called with.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

/// One recorded call of the fake tool.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeCall {
    pub args: Vec<String>,
    pub cwd: String,
    pub cwd_entries: Vec<String>,
    pub stdin: String,
    pub env: BTreeMap<String, String>,
    pub files: BTreeMap<String, String>,
}

pub struct FakeCli {
    /// What Forkyard starts: the program, or the `.cmd` shim of `install_batch`.
    pub program: PathBuf,
    state: PathBuf,
    name: String,
}

impl FakeCli {
    /// Copies `binary` (target/debug/forkyard-fake-cli) to `dir/<name>` (`.exe` on Windows) with `config`.
    pub fn install(binary: &Path, dir: &Path, name: &str, config: &Value) -> FakeCli {
        std::fs::create_dir_all(dir).expect("folder of the fake tool");
        let program = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        std::fs::copy(binary, &program).unwrap_or_else(|e| panic!("copy {} → {}: {e}", binary.display(), program.display()));
        let fake = FakeCli { program, state: dir.to_path_buf(), name: name.to_string() };
        fake.set_config(config);
        fake
    }

    /// Like an npm install on Windows: `dir/<name>.cmd` calls the real program in `dir/<name>-bin/`.
    pub fn install_batch(binary: &Path, dir: &Path, name: &str, config: &Value) -> FakeCli {
        let inner = FakeCli::install(binary, &dir.join(format!("{name}-bin")), name, config);
        let shim = dir.join(format!("{name}.cmd"));
        std::fs::write(&shim, format!("@\"%~dp0{name}-bin\\{name}.exe\" %*\r\n")).expect("shim");
        FakeCli { program: shim, state: inner.state, name: inner.name }
    }

    pub fn set_config(&self, config: &Value) {
        let text = serde_json::to_string_pretty(config).expect("config");
        std::fs::write(self.state.join(format!("{}.fake.json", self.name)), text).expect("config file");
    }

    pub fn calls(&self) -> Vec<FakeCall> {
        let text = std::fs::read_to_string(self.state.join(format!("{}.calls.jsonl", self.name))).unwrap_or_default();
        text.lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).expect("call record")).collect()
    }

    /// The calls whose arguments start with `prefix`.
    pub fn calls_with(&self, prefix: &[&str]) -> Vec<FakeCall> {
        self.calls().into_iter().filter(|call| call.args.len() >= prefix.len() && call.args.iter().zip(prefix).all(|(arg, want)| arg == want)).collect()
    }
}
