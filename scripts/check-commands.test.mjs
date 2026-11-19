// Tests of the commands.rs parser (scripts/check-commands.mjs). Run: node --test scripts/check-commands.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBindings } from "./check-commands.mjs";

const SOURCE = `
macro_rules! commands {
    ($($name:ident => $area:ident :: $func:ident ( $($arg:ident : $ty:ty),* ) -> $ret:ty ;)*) => {
        #[tauri::command]
        pub async fn $name(core: State<'_, Core>, $($arg: $ty),*) -> R<$ret> {}
    };
}

commands! {
    hand_written: app_quit, repo_update;

    app_info => app::app_info() -> AppInfo;
    // --- Section ---
    graph_page => graph::graph_page(repo_id: String, cursor: Option<String>, map: BTreeMap<String, u32>) -> GraphPage;
}

#[tauri::command]
pub async fn app_quit(core: State<'_, Core>, window: tauri::Window) -> R<()> {}

// gc:params repoId,alias
#[tauri::command]
pub async fn repo_update(core: State<'_, Core>, request: tauri::ipc::Request<'_>) -> R<Repo> {}
`;

test("reads table lines, hand-written functions and the hand_written list", () => {
  const { bindings, handlers } = parseBindings(SOURCE);
  assert.deepEqual(Object.fromEntries(bindings), {
    app_info: [],
    graph_page: ["repoId", "cursor", "map"],
    app_quit: [],
    repo_update: ["repoId", "alias"],
  });
  assert.deepEqual(handlers, ["app_quit", "repo_update", "app_info", "graph_page"]);
});

test("a hand-written function missing from hand_written stays unregistered", () => {
  const { bindings, handlers } = parseBindings(SOURCE.replace("app_quit, ", ""));
  assert.ok(bindings.has("app_quit"));
  assert.ok(!handlers.includes("app_quit"));
});
