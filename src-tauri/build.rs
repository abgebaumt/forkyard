use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    if let Err(reason) = build_askpass_sidecar() {
        // tauri_build requires the file from `bundle.externalBin`; without it the build fails anyway.
        panic!("Could not build the forkyard-askpass helper: {reason}");
    }
    tauri_build::build()
}

/// Compiles `crates/askpass/src/main.rs` (std only, no dependencies) directly with
/// rustc to `binaries/forkyard-askpass-<target>[.exe]`. That is where Tauri expects the
/// sidecar from `bundle.externalBin`: `tauri_build` copies it next to the app executable in
/// the target folder, the bundler packs it into installers and packages.
fn build_askpass_sidecar() -> Result<(), String> {
    let manifest = PathBuf::from(env("CARGO_MANIFEST_DIR")?);
    let source = manifest.join("..").join("crates").join("askpass").join("src").join("main.rs");
    println!("cargo:rerun-if-changed={}", source.display());
    if !source.is_file() {
        return Err(format!("{} is missing", source.display()));
    }
    let target = env("TARGET")?;
    let suffix = if target.contains("windows") { ".exe" } else { "" };
    let dest = manifest.join("binaries").join(format!("forkyard-askpass-{target}{suffix}"));
    // Only recompile when the source is newer: rustc doesn't produce the same bytes on every run,
    // and every change to the file triggers the next build via `tauri_build`.
    if is_up_to_date(&source, &dest) {
        return Ok(());
    }
    let out_dir = PathBuf::from(env("OUT_DIR")?);
    let built = out_dir.join(format!("forkyard-askpass{suffix}"));

    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = Command::new(rustc)
        .arg("--edition=2021")
        .args(["--crate-name", "forkyard_askpass", "--crate-type", "bin"])
        .args(["-C", "opt-level=2", "-C", "debuginfo=0", "-C", "strip=symbols", "-C", "panic=abort"])
        .args(["--target", &target])
        .arg("-o")
        .arg(&built)
        .arg(&source)
        .output()
        .map_err(|e| format!("could not start rustc: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    // copy instead of write: on Unix the file must stay executable.
    std::fs::copy(&built, &dest).map(|_| ()).map_err(|e| format!("{}: {e}", dest.display()))
}

fn is_up_to_date(source: &Path, dest: &Path) -> bool {
    let modified = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok();
    match (modified(source), modified(dest)) {
        (Some(source), Some(dest)) => dest >= source,
        _ => false,
    }
}

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("environment variable {name} is missing"))
}
