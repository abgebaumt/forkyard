//! Measures graph pages and blame on a large repository (built by `scripts/bench/large-repo.mjs`):
//!
//!   forkyard-bench --repo <path> --file <rel> [--depth 100000] [--page 500] [--first 2000]
//!
//! Prints one JSON object to stdout. It never grants trust: an untrusted repository ends it with
//! exit code 2.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use gitcore::app::{Core, CoreConfig};
use gitcore::commands::graph::{graph_page, release_graph_walkers};
use gitcore::commands::{history::file_blame_job, repos::repo_open};
use gitcore::error::CoreError;
use gitcore::events::{names, EventSink};
use serde_json::{json, Value};

/// Records when the first `blame:chunk` with spans arrived.
#[derive(Default)]
struct FirstSpans(OnceLock<Instant>);

impl EventSink for FirstSpans {
    fn emit(&self, event: &str, payload: Value) {
        if event == names::BLAME_CHUNK && payload["spans"].as_array().is_some_and(|s| !s.is_empty()) {
            let _ = self.0.set(Instant::now());
        }
    }
}

struct Args {
    repo: String,
    file: String,
    depth: usize,
    page: u32,
    first: u32,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args { repo: String::new(), file: String::new(), depth: 100_000, page: 500, first: 2000 };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
        let number = || value.parse::<u32>().map_err(|_| format!("{flag}: not a number: {value}"));
        match flag.as_str() {
            "--repo" => args.repo = value.clone(),
            "--file" => args.file = value.clone(),
            "--depth" => args.depth = number()? as usize,
            "--page" => args.page = number()?,
            "--first" => args.first = number()?,
            _ => return Err(format!("unknown argument {flag}")),
        }
    }
    if args.repo.is_empty() || args.file.is_empty() {
        return Err("usage: forkyard-bench --repo <path> --file <rel> [--depth 100000] [--page 500] [--first 2000]".into());
    }
    Ok(args)
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

/// `git rev-list --all --count` in the repository.
fn commit_count(repo: &str) -> Result<u64, CoreError> {
    let out = std::process::Command::new("git").args(["-C", repo, "rev-list", "--all", "--count"]).output()?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0))
}

async fn run(args: &Args, data_dir: &Path) -> Result<Value, CoreError> {
    let sink = Arc::new(FirstSpans::default());
    let core = Core::open(CoreConfig::new(data_dir, env!("CARGO_PKG_VERSION"), sink.clone())).await?;
    let opened = repo_open(&core, args.repo.clone()).await?;
    if !opened.repo.trusted {
        return Err(CoreError::repo_untrusted());
    }
    let id = opened.repo.id;

    let start = Instant::now();
    let mut page = graph_page(&core, id.clone(), None, args.first).await?;
    let first_page_ms = ms(start);
    let mut delivered = page.rows.len();
    let mut deep_page_ms = None;
    while delivered < args.depth {
        let Some(cursor) = page.next_cursor.take() else { break };
        let start = Instant::now();
        page = graph_page(&core, id.clone(), Some(cursor), args.page).await?;
        let elapsed = ms(start);
        delivered += page.rows.len();
        if delivered >= args.depth {
            deep_page_ms = Some(elapsed);
        }
    }
    release_graph_walkers(&core, &id);

    let start = Instant::now();
    let lines = file_blame_job(&core, id, "bench-blame".into(), args.file.clone(), None, None).await?;
    let blame_done_ms = ms(start);
    let blame_first_lines_ms = sink.0.get().map(|t| t.duration_since(start).as_secs_f64() * 1000.0);

    Ok(json!({
        "commits": commit_count(&args.repo)?,
        "firstPageMs": first_page_ms,
        "deepPageMs": deep_page_ms,
        "depth": args.depth,
        "blameFirstLinesMs": blame_first_lines_ms,
        "blameDoneMs": blame_done_ms,
        "blameLines": lines.len(),
    }))
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("forkyard-bench: {message}");
            return ExitCode::from(1);
        }
    };
    let data_dir: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../target/bench/data-{}", std::process::id()));
    let result = run(&args, &data_dir).await;
    let _ = std::fs::remove_dir_all(&data_dir);
    match result {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("forkyard-bench: {}", e.message);
            ExitCode::from(if e.code == gitcore::error::ErrorCode::RepoUntrusted { 2 } else { 1 })
        }
    }
}
