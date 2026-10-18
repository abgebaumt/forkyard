/**
 * Contract check along the REAL path: UI → Tauri invoke → Rust core → git.
 *
 *   node scripts/e2e/contract.mjs            all sections
 *   node scripts/e2e/contract.mjs --show     visible window
 *
 * Every response and every event is checked against the types in src/core/types.ts: the file is
 * read and evaluated here, so there is no second list of field names that could go stale.
 * An object must have EXACTLY the fields of its type (none extra, none missing, null instead of
 * absent); unions must match one variant.
 *
 * Whoever finishes a command adds a section below:
 *
 *   await section("stash", async () => {
 *     const list = await app.invoke("stash_list", { repoId });
 *     shape("Stash[]", list, "stash_list");
 *     equal(list.length, 2, "two stashes in the fixture");
 *   });
 *
 * `shape(type, value, name)` takes a type name or a type expression from types.ts
 * ("Repo", "Tab[]", "string | null").
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, keyringEntries, launchApp } from "./driver.mjs";
import { startGitHttpServer } from "./git-http-server.mjs";
import { startHostMock } from "./host-mock.mjs";
import { makeCleanRepoWithRemote, makeConflictRepo, makeEmptyRepo, makeNotARepo, makeRichRepo } from "./fixtures.mjs";

// ---------------------------------------------------------------------------
// Read types.ts
// ---------------------------------------------------------------------------

/** Reads `export interface` and `export type` from a TypeScript file (only the forms types.ts uses). */
export function loadTypes(file = path.join(ROOT, "src", "core", "types.ts")) {
  const source = fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
  const tokens = [];
  const pattern = /\s+|([A-Za-z_$][\w$]*)|("(?:[^"\\]|\\.)*")|(\d+(?:\.\d+)?)|(=>|[{}()[\]|;:?,=<>&.])/y;
  let position = 0;
  while (position < source.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) throw new Error(`types.ts: unexpected character "${source[position]}" at position ${position}`);
    position = pattern.lastIndex;
    if (match[1]) tokens.push({ kind: "name", text: match[1] });
    else if (match[2]) tokens.push({ kind: "string", text: JSON.parse(match[2]) });
    else if (match[3]) tokens.push({ kind: "number", text: Number(match[3]) });
    else if (match[4]) tokens.push({ kind: "sign", text: match[4] });
  }
  return { types: parseDeclarations(tokens), parse: (text) => parseExpression(text) };
}

function parser(tokens) {
  let index = 0;
  const peek = (offset = 0) => tokens[index + offset];
  const isSign = (text, offset = 0) => peek(offset)?.kind === "sign" && peek(offset).text === text;
  const take = () => tokens[index++];
  const expect = (text) => {
    if (!isSign(text)) throw new Error(`type parser: expected "${text}", found "${peek()?.text}"`);
    index += 1;
  };
  const fields = () => {
    const list = [];
    while (!isSign("}")) {
      const name = take();
      if (name.kind !== "name" && name.kind !== "string") throw new Error(`type parser: expected a field name, found "${name.text}"`);
      const optional = isSign("?");
      if (optional) index += 1;
      expect(":");
      list.push({ name: String(name.text), optional, type: union() });
      if (isSign(";") || isSign(",")) index += 1;
    }
    expect("}");
    return { t: "object", fields: list };
  };
  const primary = () => {
    const token = take();
    if (!token) throw new Error("type parser: unexpected end");
    if (token.kind === "sign" && token.text === "{") return fields();
    if (token.kind === "sign" && token.text === "(") {
      const inner = union();
      expect(")");
      return inner;
    }
    if (token.kind === "string" || token.kind === "number") return { t: "literal", value: token.text };
    if (token.kind === "name") {
      if (["string", "number", "boolean", "null", "undefined", "void"].includes(token.text)) return { t: "prim", name: token.text };
      if (token.text === "true" || token.text === "false") return { t: "literal", value: token.text === "true" };
      return { t: "ref", name: token.text };
    }
    throw new Error(`type parser: unexpected "${token.text}"`);
  };
  const postfix = () => {
    let node = primary();
    while (isSign("[") && isSign("]", 1)) {
      index += 2;
      node = { t: "array", of: node };
    }
    return node;
  };
  const union = () => {
    if (isSign("|")) index += 1;
    const members = [postfix()];
    while (isSign("|")) {
      index += 1;
      members.push(postfix());
    }
    return members.length === 1 ? members[0] : { t: "union", members };
  };
  return { peek, isSign, take, expect, fields, union, done: () => index >= tokens.length, skipBlock };

  function skipBlock() {
    let depth = 0;
    for (;;) {
      const token = take();
      if (!token) return;
      if (token.kind === "sign" && token.text === "{") depth += 1;
      if (token.kind === "sign" && token.text === "}" && --depth === 0) return;
    }
  }
}

function parseDeclarations(tokens) {
  const types = new Map();
  const p = parser(tokens);
  while (!p.done()) {
    const token = p.take();
    if (token.kind !== "name" || token.text !== "export") continue;
    const what = p.take();
    if (what.text === "interface") {
      const name = p.take().text;
      // `interface A extends B`: B's fields belong to it (B comes earlier in types.ts).
      let inherited = [];
      if (p.peek()?.kind === "name" && p.peek().text === "extends") {
        p.take();
        const base = types.get(p.take().text);
        if (!base || base.t !== "object") throw new Error(`type parser: ${name} extends a type that is not known (yet)`);
        inherited = base.fields;
      }
      p.expect("{");
      const own = p.fields();
      types.set(name, { t: "object", fields: [...inherited.filter((field) => !own.fields.some((mine) => mine.name === field.name)), ...own.fields] });
    } else if (what.text === "type") {
      const name = p.take().text;
      p.expect("=");
      types.set(name, p.union());
    } else if (what.text === "class") {
      p.skipBlock();
    }
  }
  return types;
}

const tokenCache = new Map();
function parseExpression(text) {
  if (!tokenCache.has(text)) {
    const tokens = [];
    const pattern = /\s+|([A-Za-z_$][\w$]*)|("(?:[^"\\]|\\.)*")|(\d+(?:\.\d+)?)|([{}()[\]|;:?,])/y;
    let position = 0;
    while (position < text.length) {
      pattern.lastIndex = position;
      const match = pattern.exec(text);
      if (!match) throw new Error(`type expression "${text}": unexpected character at position ${position}`);
      position = pattern.lastIndex;
      if (match[1]) tokens.push({ kind: "name", text: match[1] });
      else if (match[2]) tokens.push({ kind: "string", text: JSON.parse(match[2]) });
      else if (match[3]) tokens.push({ kind: "number", text: Number(match[3]) });
      else if (match[4]) tokens.push({ kind: "sign", text: match[4] });
    }
    tokenCache.set(text, parser(tokens).union());
  }
  return tokenCache.get(text);
}

const show = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

/** Checks `value` against a type node; returns the mismatches as texts. */
export function checkShape(types, node, value, where = "") {
  const errors = [];
  const at = where || "value";
  switch (node.t) {
    case "prim": {
      const ok =
        node.name === "null" ? value === null : node.name === "undefined" || node.name === "void" ? value === undefined || value === null : node.name === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === node.name;
      if (!ok) errors.push(`${at}: expected ${node.name}, got ${show(value)}`);
      break;
    }
    case "literal":
      if (value !== node.value) errors.push(`${at}: expected ${show(node.value)}, got ${show(value)}`);
      break;
    case "ref": {
      const target = types.get(node.name);
      if (!target) errors.push(`${at}: type "${node.name}" is not in types.ts`);
      else errors.push(...checkShape(types, target, value, where));
      break;
    }
    case "array":
      if (!Array.isArray(value)) errors.push(`${at}: expected a list, got ${show(value)}`);
      else value.forEach((item, index) => errors.push(...checkShape(types, node.of, item, `${where}[${index}]`)));
      break;
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${at}: expected an object, got ${show(value)}`);
        break;
      }
      const known = new Set(node.fields.map((field) => field.name));
      for (const field of node.fields) {
        if (!(field.name in value)) {
          if (!field.optional) errors.push(`${where ? `${where}.` : ""}${field.name}: field missing`);
          continue;
        }
        errors.push(...checkShape(types, field.type, value[field.name], `${where ? `${where}.` : ""}${field.name}`));
      }
      for (const key of Object.keys(value)) {
        if (!known.has(key)) errors.push(`${where ? `${where}.` : ""}${key}: field is not in the type (value ${show(value[key])})`);
      }
      break;
    }
    case "union": {
      const attempts = node.members.map((member) => checkShape(types, member, value, where));
      if (attempts.some((attempt) => attempt.length === 0)) break;
      // For the message take the variant whose tag field (kind/status) matches, otherwise the one with the fewest mismatches.
      const resolve = (member) => (member.t === "ref" ? (types.get(member.name) ?? member) : member);
      const tagged = node.members.findIndex((member) => {
        const target = resolve(member);
        return target.t === "object" && value && typeof value === "object" && target.fields.some((field) => ["kind", "status"].includes(field.name) && field.type.t === "literal" && field.type.value === value[field.name]);
      });
      const objects = node.members.some((member) => resolve(member).t === "object");
      if (tagged >= 0) errors.push(...attempts[tagged]);
      else if (objects && value && typeof value === "object") errors.push(...attempts.reduce((best, attempt) => (attempt.length < best.length ? attempt : best)));
      else errors.push(`${at}: ${show(value)} matches no variant`);
      break;
    }
    default:
      errors.push(`${at}: unknown type node`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const { types, parse } = loadTypes();
  const failures = [];
  let current = "";
  const fail = (message) => {
    failures.push(`${current}: ${message}`);
    console.log(`  ✗ ${message}`);
  };
  const shape = (type, value, label) => {
    const errors = checkShape(types, parse(type), value, "");
    if (errors.length) for (const error of errors.slice(0, 12)) fail(`${label} (${type}) – ${error}`);
    return errors.length === 0;
  };
  const equal = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label}: expected ${show(expected)}, got ${show(actual)}`);
  };
  const truthy = (value, label) => {
    if (!value) fail(label);
  };
  const section = async (name, run) => {
    current = name;
    const before = failures.length;
    try {
      await run();
    } catch (error) {
      fail(`aborted: ${error?.message ?? error}`);
    }
    console.log(`${failures.length === before ? "✓" : "✗"} ${name}`);
  };
  /** Expects a CoreError with this code and checks its shape. */
  const rejects = async (code, label, run) => {
    try {
      await run();
      fail(`${label}: should have failed with "${code}"`);
    } catch (error) {
      if (!error.raw) throw error;
      shape("CoreErrorData", error.raw, `${label}: error object`);
      equal(error.code, code, `${label}: error code`);
      truthy(typeof error.raw.message === "string" && error.raw.message.length > 3, `${label}: error message is empty`);
    }
  };
  const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const rich = makeRichRepo();
  const empty = makeEmptyRepo();
  const plain = makeNotARepo();
  const clean = makeCleanRepoWithRemote();
  const conflict = makeConflictRepo();
  let app = null;
  let hostMock = null;
  try {
    // Test server for hosts; the app stores its secrets under its own service name in the
    // keychain, not under the user's real entries.
    hostMock = await startHostMock();
    const keyringService = `forkyard-test-contract-${process.pid}`;
    app = await launchApp({
      show: process.argv.includes("--show"),
      env: { FORKYARD_KEYRING_SERVICE: keyringService },
    });
    const events = await app.recordEvents();
    /** Events since the last call; checks their shape against CoreEvents. */
    const takeEvents = async () => {
      await app.page.waitForTimeout(120);
      const list = await events.take();
      for (const event of list) shape(`CoreEvents`, { ...emptyEvents(), [event.name]: event.payload }, `Event ${event.name}`);
      return list;
    };
    // CoreEvents requires all events as fields; to check a single one, fill the rest with valid placeholders.
    const placeholders = {
      "repo:changed": { repoId: "x", what: [] },
      "job:progress": { jobId: "x", repoId: null, phase: "", percent: null, line: "" },
      "job:done": { jobId: "x", repoId: null, ok: true, cancelled: false, message: null },
      "credential:request": { requestId: "x", kind: "password", host: "", username: null, detail: null, prompt: "", canRemember: false },
      "credential:closed": { requestId: "x" },
      "hook:output": { repoId: "x", hook: "", output: "", exitCode: 0 },
      "log:appended": { id: "x", scope: "app", repoId: null, startedAt: "", durationMs: 0, command: "", exitCode: null, output: "" },
      "app:changed": { what: [] },
      "terminal:data": { terminalId: "x", data: "" },
      "terminal:exit": { terminalId: "x", code: null },
      "app:open_request": { path: "x", commit: null },
      "app:close_requested": {},
      "submodules:updated": { repoId: "x", ok: true, paths: [], message: null },
      "agents:changed": { repoId: "x", running: 0 },
      "agents:collisions": { repoId: "x", state: "pending", checkedAt: null, error: null, collisions: [], skipped: [] },
    };
    const emptyEvents = () => structuredClone(placeholders);
    const whatOf = (list, name) => list.filter((event) => event.name === name).flatMap((event) => event.payload.what ?? []);

    let repoId = null;
    let tabId = null;

    await section("appInfo", async () => {
      const info = await app.invoke("app_info");
      shape("AppInfo", info, "app_info");
      equal(info.platform, "windows", "platform");
      truthy(info.gitVersion && /^\d+\.\d+/.test(info.gitVersion), `gitVersion does not look like a version: ${info.gitVersion}`);
      truthy(samePath(info.dataDir, app.dataDir), `dataDir ${info.dataDir} is not the directory from FORKYARD_DATA_DIR (${app.dataDir})`);
      equal(info.gitMinVersion, "2.39", "gitMinVersion");
    });

    await section("settings", async () => {
      const settings = await app.invoke("settings_get");
      shape("Settings", settings, "settings_get");
      await takeEvents();
      const changed = await app.invoke("settings_set", { patch: { theme: "light", zoom: 1.1 } });
      shape("Settings", changed, "settings_set");
      equal([changed.theme, changed.zoom], ["light", 1.1], "settings_set takes theme and zoom");
      equal(changed.dateFormat, settings.dateFormat, "fields not given stay");
      truthy(whatOf(await takeEvents(), "app:changed").includes("settings"), "settings_set does not report app:changed with \"settings\"");
      equal((await app.invoke("settings_get")).theme, "light", "settings_get returns the stored value");
      await rejects("not_allowed", "settings_set with unknown field", () => app.invoke("settings_set", { patch: { gibtEsNicht: true } }));
      await rejects("not_allowed", "settings_set with wrong type", () => app.invoke("settings_set", { patch: { zoom: "groß" } }));
      await app.invoke("settings_set", { patch: { theme: settings.theme, zoom: settings.zoom } });
    });

    await section("profile", async () => {
      const profiles = await app.invoke("profile_list");
      shape("Profile[]", profiles, "profile_list");
      equal(profiles.filter((profile) => profile.isActive).length, 1, "exactly one active profile");
      await takeEvents();
      const added = await app.invoke("profile_save", { id: null, name: "Schule", authorName: "Lena Hartmann", authorEmail: "lena@schule.example", syncGitconfig: false });
      shape("Profile[]", added, "profile_save (new)");
      equal(added.length, profiles.length + 1, "profile_save creates a profile");
      truthy(whatOf(await takeEvents(), "app:changed").includes("profiles"), "profile_save does not report app:changed with \"profiles\"");
      const created = added.find((profile) => profile.name === "Schule");
      const renamed = await app.invoke("profile_save", { id: created.id, name: "Schule Nord", authorName: "Lena Hartmann", authorEmail: "lena@schule.example", syncGitconfig: false });
      equal(renamed.find((profile) => profile.id === created.id)?.name, "Schule Nord", "profile_save changes a profile");
      const activated = await app.invoke("profile_activate", { id: created.id });
      shape("Profile[]", activated, "profile_activate");
      equal(activated.filter((profile) => profile.isActive).map((profile) => profile.id), [created.id], "profile_activate");
      const back = await app.invoke("profile_activate", { id: profiles.find((profile) => profile.isActive).id });
      equal(back.filter((profile) => profile.isActive).length, 1, "exactly one active profile again");
      const removed = await app.invoke("profile_delete", { id: created.id });
      shape("Profile[]", removed, "profile_delete");
      equal(removed.length, profiles.length, "profile_delete removes the profile");
      await rejects("not_found", "profile_activate with unknown ID", () => app.invoke("profile_activate", { id: "gibt-es-nicht" }));
    });

    await section("repoOpen, repoList, tabs", async () => {
      const before = await app.invoke("tabs_list");
      shape("Tab[]", before, "tabs_list");
      await takeEvents();
      const opened = await app.invoke("repo_open", { path: rich.path });
      shape("OpenedRepo", opened, "repo_open");
      repoId = opened.repo.id;
      tabId = opened.tab.id;
      truthy(samePath(opened.repo.path, rich.path), `repo.path ${opened.repo.path} ≠ ${rich.path}`);
      equal([opened.repo.name, opened.repo.missing, opened.tab.kind, opened.tab.repoId, opened.tab.isActive, opened.tab.title], ["wetterstation", false, "repo", repoId, true, "wetterstation"], "repo_open");
      const openEvents = await takeEvents();
      truthy(whatOf(openEvents, "app:changed").includes("tabs") && whatOf(openEvents, "app:changed").includes("repos"), `repo_open reports app:changed with tabs and repos (was: ${show(whatOf(openEvents, "app:changed"))})`);

      // A subfolder opens the same repository, no second entry
      const again = await app.invoke("repo_open", { path: path.join(rich.path, "src") });
      equal(again.repo.id, repoId, "subfolder opens the same repository");
      const repos = await app.invoke("repo_list");
      shape("Repo[]", repos, "repo_list");
      equal(repos.length, 1, "repo_list has one entry");

      const withManagement = await app.invoke("tab_open", { repoId: null });
      shape("Tab[]", withManagement, "tab_open");
      const management = withManagement.find((tab) => tab.kind === "management");
      truthy(management && management.isActive && management.repoId === null && management.path === null && management.title === "", `management tab: ${show(management)}`);
      const second = await app.invoke("repo_open", { path: empty.path });
      const tabs = await app.invoke("tabs_list");
      equal(tabs.map((tab) => tab.position), tabs.map((_, index) => index), "positions are contiguous from 0");
      equal(tabs.filter((tab) => tab.isActive).length, 1, "exactly one active tab");
      const moved = await app.invoke("tab_move", { tabId: second.tab.id, position: 0 });
      shape("Tab[]", moved, "tab_move");
      equal([...moved].sort((a, b) => a.position - b.position)[0].id, second.tab.id, "tab_move moves the tab to the front");
      const activated = await app.invoke("tab_activate", { tabId });
      shape("Tab[]", activated, "tab_activate");
      equal(activated.find((tab) => tab.isActive)?.id, tabId, "tab_activate");
      const closed = await app.invoke("tab_close", { tabId: second.tab.id });
      shape("Tab[]", closed, "tab_close");
      truthy(!closed.some((tab) => tab.id === second.tab.id), "tab_close removes the tab");
      await app.invoke("repo_forget", { repoId: second.repo.id });

      await rejects("not_a_repo", "repo_open on a plain folder", () => app.invoke("repo_open", { path: plain.path }));
      await rejects("path_not_found", "repo_open on a missing folder", () => app.invoke("repo_open", { path: path.join(plain.root, "gibt-es-nicht") }));
      await rejects("not_found", "tab_close with unknown ID", () => app.invoke("tab_close", { tabId: "gibt-es-nicht" }));
      await takeEvents();
    });

    await section("repoUpdate: field missing ≠ null", async () => {
      const full = await app.invoke("repo_update", { repoId, alias: "Wetter", isFavorite: true, groupName: "Schule", color: 3 });
      shape("Repo", full, "repo_update");
      equal([full.alias, full.isFavorite, full.groupName, full.color], ["Wetter", true, "Schule", 3], "all fields set");
      truthy(whatOf(await takeEvents(), "app:changed").includes("repos"), "repo_update does not report app:changed with \"repos\"");
      const onlyFavorite = await app.invoke("repo_update", { repoId, isFavorite: false });
      equal([onlyFavorite.alias, onlyFavorite.isFavorite, onlyFavorite.groupName, onlyFavorite.color], ["Wetter", false, "Schule", 3], "missing fields stay unchanged");
      const aliasNull = await app.invoke("repo_update", { repoId, alias: null });
      equal([aliasNull.alias, aliasNull.groupName, aliasNull.color], [null, "Schule", 3], "alias: null clears only the alias");
      const rest = await app.invoke("repo_update", { repoId, groupName: null, color: null });
      equal([rest.alias, rest.isFavorite, rest.groupName, rest.color], [null, false, null, null], "groupName and color: null");
      const untouched = await app.invoke("repo_update", { repoId });
      equal(untouched, rest, "without fields nothing changes");
      const tabs = await app.invoke("tabs_list");
      equal(tabs.find((tab) => tab.id === tabId)?.title, "wetterstation", "without an alias the tab title is the folder name again");
      await app.invoke("repo_update", { repoId, alias: "Wetter" });
      equal((await app.invoke("tabs_list")).find((tab) => tab.id === tabId)?.title, "Wetter", "tab title follows the alias");
      await app.invoke("repo_update", { repoId, alias: null });
      await rejects("not_found", "repo_update with unknown ID", () => app.invoke("repo_update", { repoId: "gibt-es-nicht", alias: "x" }));
    });

    await section("viewState, draft, repoSettings", async () => {
      const view = await app.invoke("view_state_get", { repoId });
      shape("RepoViewState", view, "view_state_get");
      const patched = await app.invoke("view_state_set", { repoId, patch: { hiddenRefs: ["refs/heads/experiment/alte-auswertung"], pinnedRefs: ["refs/heads/main"] } });
      shape("RepoViewState", patched, "view_state_set");
      equal([patched.hiddenRefs, patched.pinnedRefs, patched.soloRefs], [["refs/heads/experiment/alte-auswertung"], ["refs/heads/main"], view.soloRefs], "view_state_set changes only the given fields");
      equal(await app.invoke("view_state_get", { repoId }), patched, "view_state_get returns what was stored");
      await rejects("not_allowed", "view_state_set with unknown field", () => app.invoke("view_state_set", { repoId, patch: { gibtEsNicht: 1 } }));

      const draft = await app.invoke("draft_get", { repoId });
      shape("CommitDraft", draft, "draft_get");
      equal(draft, { summary: "", description: "", amend: false }, "empty draft");
      const stored = { summary: "Größen ergänzt", description: "Zeile 1\nZeile 2 mit „Anführungszeichen“", amend: true };
      equal(await app.invoke("draft_set", { repoId, draft: stored }), null, "draft_set returns nothing");
      equal(await app.invoke("draft_get", { repoId }), stored, "draft_get returns the stored draft");
      await app.invoke("draft_set", { repoId, draft: { summary: "", description: "", amend: false } });

      const settings = await app.invoke("repo_settings_get", { repoId });
      shape("RepoSettings", settings, "repo_settings_get");
      await takeEvents();
      const changed = await app.invoke("repo_settings_set", { repoId, patch: { authorName: "Lena H.", autoFetch: false } });
      shape("RepoSettings", changed, "repo_settings_set");
      equal([changed.authorName, changed.autoFetch], ["Lena H.", false], "repo_settings_set");
      const changes = await takeEvents();
      const repoChanged = changes.filter((event) => event.name === "repo:changed");
      truthy(repoChanged.some((event) => event.payload.repoId === repoId && event.payload.what.includes("config")), `repo_settings_set (authorName) reports repo:changed with "config" (was: ${show(repoChanged.map((event) => event.payload))})`);
      truthy(changes.some((event) => event.name === "log:appended" && event.payload.repoId === repoId && event.payload.scope === "repo" && event.payload.command.includes("config")), "the Git call shows up as log:appended");
      await app.invoke("repo_settings_set", { repoId, patch: { authorName: settings.authorName, autoFetch: settings.autoFetch } });
    });

    await section("statusGet", async () => {
      const status = await app.invoke("status_get", { repoId });
      shape("Status", status, "status_get");
      equal(status.head, { kind: "branch", branch: "main", sha: rich.info.head }, "head");
      equal(status.upstream, { name: "origin/main", ahead: 2, behind: 1, gone: false }, "upstream");
      equal(status.staged.map((file) => file.path), rich.info.changes.staged, "staged");
      equal(status.unstaged.map((file) => file.path), rich.info.changes.unstaged, "unstaged");
      equal([status.conflicted, status.operation, status.identitySet], [[], null, true], "no conflict, no operation, identity set");
      const byPath = (list, file) => list.find((entry) => entry.path === file);
      equal(byPath(status.staged, "docs/stationsaufbau.md")?.oldPath, "docs/aufbau.md", "rename carries oldPath");
      equal([byPath(status.staged, "daten/testlauf.csv")?.status, byPath(status.staged, "src/export.py")?.status], ["deleted", "added"], "deleted and new in the index");
      equal(byPath(status.unstaged, "daten/kalibrierung.bin")?.isBinary, true, "binary file detected");
      equal(byPath(status.unstaged, "notizen/Übersicht März.txt")?.status, "untracked", "untracked file with umlaut and space");
      const emptyOpened = await app.invoke("repo_open", { path: empty.path });
      const unborn = await app.invoke("status_get", { repoId: emptyOpened.repo.id });
      shape("Status", unborn, "status_get (no commit)");
      equal(unborn.head, { kind: "unborn", branch: "main" }, "head in a repository without commits");
      await app.invoke("repo_forget", { repoId: emptyOpened.repo.id });
      await app.invoke("tab_activate", { tabId });
      await rejects("not_found", "status_get with unknown ID", () => app.invoke("status_get", { repoId: "gibt-es-nicht" }));
    });

    await section("refsList", async () => {
      const refs = await app.invoke("refs_list", { repoId });
      shape("RefsSnapshot", refs, "refs_list");
      equal(refs.head, { kind: "branch", branch: "main", sha: rich.info.head }, "head");
      equal(refs.locals.map((ref) => ref.name), rich.info.localBranches, "local branches");
      equal(refs.remotes.map((ref) => ref.name), rich.info.remoteBranches, "remote branches");
      equal(refs.tags.map((ref) => ref.name), rich.info.tags, "Tags");
      const main = refs.locals.find((ref) => ref.name === "main");
      equal([main.fullName, main.isHead, main.upstream, main.ahead, main.behind, main.upstreamGone], ["refs/heads/main", true, "origin/main", 2, 1, false], "main");
      equal(refs.tags.filter((ref) => ref.isAnnotated).map((ref) => ref.name), rich.info.annotatedTags, "annotated tags");
      equal(refs.remotes.every((ref) => ref.remote === "origin"), true, "remote branches carry the remote name");
    });

    await section("activityList, log:appended", async () => {
      const repoLog = await app.invoke("activity_list", { scope: "repo", repoId, cursor: null, limit: 5 });
      shape("ActivityPage", repoLog, "activity_list (repo)");
      truthy(repoLog.entries.length > 0 && repoLog.entries.every((entry) => entry.scope === "repo" && entry.repoId === repoId), "entries of the repository");
      if (repoLog.nextCursor) shape("ActivityPage", await app.invoke("activity_list", { scope: "repo", repoId, cursor: repoLog.nextCursor, limit: 5 }), "activity_list (second page)");
      const appLog = await app.invoke("activity_list", { scope: "app", repoId: null, cursor: null, limit: 50 });
      shape("ActivityPage", appLog, "activity_list (app)");
      truthy(appLog.entries.every((entry) => entry.scope === "app" && entry.repoId === null), "app entries have no repoId");
    });

    await section("appRecheckGit", async () => {
      const before = await app.invoke("app_info");
      const info = await app.invoke("app_recheck_git");
      shape("AppInfo", info, "app_recheck_git");
      equal([info.gitVersion, info.gitPath], [before.gitVersion, before.gitPath], "app_recheck_git finds the same Git");
    });

    await section("graphPage", async () => {
      const page = await app.invoke("graph_page", { repoId, cursor: null, limit: 40 });
      shape("GraphPage", page, "graph_page");
      const [wip] = page.rows;
      equal([wip.id, wip.kind, wip.sha, wip.parents], ["wip", "wip", null, [rich.info.head]], "first row is the WIP row above HEAD");
      truthy(wip.wipCount >= rich.info.changes.unstaged.length, `wipCount ${wip.wipCount}`);
      const head = page.rows.find((row) => row.sha === rich.info.head);
      truthy(head?.isHead && head.refs.some((ref) => ref.name === "main"), `HEAD row with label main: ${show(head)}`);
      const stashRows = page.rows.filter((row) => row.kind === "stash");
      equal(stashRows.map((row) => row.stashIndex).sort(), [0, 1], "both stashes as rows");
      const merge = page.rows.find((row) => row.sha === rich.info.shas.secondMerge);
      equal([merge?.kind, merge?.parents.length], ["merge", 2], "merge commit");
      truthy(page.nextCursor === null || typeof page.nextCursor === "string", "nextCursor");
      truthy(!page.rows.some((row) => row.refs.some((ref) => ref.name.startsWith("refs/forkyard"))), "no backup refs in the graph");
      if (page.nextCursor) {
        const next = await app.invoke("graph_page", { repoId, cursor: page.nextCursor, limit: 40 });
        shape("GraphPage", next, "graph_page (next page)");
        truthy(!next.rows.some((row) => page.rows.some((seen) => seen.id === row.id)), "next page without repetitions");
      }
      const all = await app.invoke("graph_page", { repoId, cursor: null, limit: 10000 });
      truthy(all.rows.some((row) => row.sha === rich.info.shas.first) && all.nextCursor === null, "all commits down to the first");
      await rejects("stale_state", "graph_page with unreadable cursor", () => app.invoke("graph_page", { repoId, cursor: "kaputt", limit: 10 }));
    });

    await section("commitDetails", async () => {
      const co = await app.invoke("commit_details", { repoId, source: { kind: "commit", sha: rich.info.shas.coAuthored } });
      shape("CommitDetails", co, "commit_details (commit)");
      equal(co.commit?.coAuthors.map((person) => person.name).length, 2, "two co-authors");
      equal(co.files.map((file) => file.path), ["tests/test_pruefung.py"], "files of the commit");
      equal([co.files[0].status, co.files[0].area], ["added", "commit"], "new file in the commit");
      const first = await app.invoke("commit_details", { repoId, source: { kind: "commit", sha: rich.info.shas.first } });
      equal(first.commit?.parents, [], "first commit without parents");
      equal(first.files.length, 3, "first commit against the empty tree");
      const unstaged = await app.invoke("commit_details", { repoId, source: { kind: "unstaged" } });
      shape("CommitDetails", unstaged, "commit_details (unstaged)");
      equal(unstaged.commit, null, "no commit for unstaged");
      equal(unstaged.files.map((file) => file.path), rich.info.changes.unstaged, "unstaged as in the status");
      const staged = await app.invoke("commit_details", { repoId, source: { kind: "staged" } });
      equal(staged.files.map((file) => file.path), rich.info.changes.staged, "staged as in the status");
      const range = await app.invoke("commit_details", { repoId, source: { kind: "range", from: rich.info.shas.first, to: rich.info.shas.csv } });
      shape("CommitDetails", range, "commit_details (range)");
      equal(range.files.map((file) => file.path).sort(), ["daten/messwerte-2026-01.csv", "daten/testlauf.csv", "src/auswertung.py"], "range");
      const toWorktree = await app.invoke("commit_details", { repoId, source: { kind: "range", from: rich.info.head, to: null } });
      shape("CommitDetails", toWorktree, "commit_details (range to working tree)");
      const stash = await app.invoke("commit_details", { repoId, source: { kind: "stash", index: 0 } });
      shape("CommitDetails", stash, "commit_details (stash)");
      truthy(stash.files.some((file) => file.path === "notizen/ideen.txt" && file.status === "untracked"), `stash with untracked file: ${show(stash.files)}`);
      await rejects("not_found", "commit_details with unknown commit", () => app.invoke("commit_details", { repoId, source: { kind: "commit", sha: "0123456789abcdef0123456789abcdef01234567" } }));
      await rejects("not_found", "commit_details with unknown stash", () => app.invoke("commit_details", { repoId, source: { kind: "stash", index: 9 } }));
    });

    await section("diffFile: all kinds", async () => {
      const diff = (file, source, extra = {}) => app.invoke("diff_file", { repoId, path: file, source, ...extra });
      const text = await diff("src/auswertung.py", { kind: "unstaged" });
      shape("FileDiff", text, "diff_file (text, unstaged)");
      equal([text.kind, text.status, text.encoding], ["text", "modified", "utf-8"], "text diff");
      truthy(typeof text.token === "string" && text.token.length > 0, "unstaged has a token");
      truthy(text.hunks.length === 1 && text.hunks[0].lines.some((line) => line.kind === "add" && line.text.includes("aus {pfad} gelesen")), "hunk with the changed line");
      const multi = await diff(rich.info.multiHunkFile, { kind: "unstaged" });
      equal(multi.hunks?.length, 3, "three hunks");
      const staged = await diff("README.md", { kind: "staged" });
      shape("FileDiff", staged, "diff_file (staged)");
      truthy(staged.kind === "text" && staged.token, "staged with token");
      const renamed = await diff("docs/stationsaufbau.md", { kind: "staged" });
      equal([renamed.status, renamed.oldPath], ["renamed", "docs/aufbau.md"], "rename in the index");
      const untracked = await diff("notizen/offene-fragen.md", { kind: "unstaged" });
      equal([untracked.kind, untracked.status], ["text", "untracked"], "untracked file");
      truthy(untracked.hunks.flatMap((hunk) => hunk.lines).every((line) => line.kind === "add"), "untracked: added lines only");
      const commit = await diff("src/auswertung.py", { kind: "commit", sha: rich.info.shas.csv });
      shape("FileDiff", commit, "diff_file (commit)");
      equal([commit.kind, commit.status, commit.token], ["text", "added", null], "commit diff without token");
      const range = await diff("src/auswertung.py", { kind: "range", from: rich.info.shas.csv, to: rich.info.head });
      shape("FileDiff", range, "diff_file (range)");
      const toWorktree = await diff("src/auswertung.py", { kind: "range", from: rich.info.head, to: null });
      shape("FileDiff", toWorktree, "diff_file (range to working tree)");
      const stashed = await diff("README.md", { kind: "stash", index: 0 });
      shape("FileDiff", stashed, "diff_file (stash)");
      const binary = await diff(rich.info.binaryFile, { kind: "unstaged" });
      shape("FileDiff", binary, "diff_file (binary)");
      equal([binary.kind, binary.oldSize, binary.newSize], ["binary", 2048, 3072], "binary file with sizes");
      const image = await diff(rich.info.imageFile, { kind: "unstaged" });
      shape("FileDiff", image, "diff_file (image)");
      truthy(image.kind === "image" && image.oldDataUrl?.startsWith("data:image/png") && image.newDataUrl?.startsWith("data:image/png"), `image diff: ${show(image)}`);
      const newImage = await diff("docs/standort.png", { kind: "unstaged" });
      equal([newImage.kind, newImage.oldDataUrl], ["image", null], "new image without old side");
      // LFS pointer and too-large file, both untracked
      rich.write("daten/modell.bin", `version https://git-lfs.github.com/spec/v1\noid sha256:${"ab".repeat(32)}\nsize 123456\n`);
      const lfs = await diff("daten/modell.bin", { kind: "unstaged" });
      shape("FileDiff", lfs, "diff_file (lfs)");
      equal([lfs.kind, lfs.newOid, lfs.newSize, lfs.oldOid], ["lfs", "ab".repeat(32), 123456, null], "LFS pointer");
      rich.write("daten/gross.csv", "2026-01-01;1,0;50;0,0;5\n".repeat(60000));
      const large = await diff("daten/gross.csv", { kind: "unstaged" });
      shape("FileDiff", large, "diff_file (too_large)");
      equal(large.kind, "too_large", "file too large");
      truthy(large.bytes > 1024 * 1024, `bytes ${large.bytes}`);
      const forced = await diff("daten/gross.csv", { kind: "unstaged" }, { force: true });
      shape("FileDiff", forced, "diff_file (force)");
      equal(forced.kind, "text", "with force the text comes");
      fs.rmSync(path.join(rich.path, "daten/modell.bin"));
      fs.rmSync(path.join(rich.path, "daten/gross.csv"));
      await rejects("not_found", "diff_file with unknown path", () => diff("gibt/es/nicht.txt", { kind: "unstaged" }));
    });

    await section("stashList, remoteList", async () => {
      const stashes = await app.invoke("stash_list", { repoId });
      shape("Stash[]", stashes, "stash_list");
      equal(stashes.map((stash) => stash.message), rich.info.stashes, "stash messages");
      equal(stashes.map((stash) => [stash.index, stash.branch]), [[0, "main"], [1, "main"]], "index and branch");
      equal(stashes[0].fileCount, 2, "README and untracked note");
      const remotes = await app.invoke("remote_list", { repoId });
      shape("Remote[]", remotes, "remote_list");
      equal(remotes.map((remote) => [remote.name, remote.pushUrl, remote.host]), [["origin", null, "other"]], "origin");
      truthy(samePath(remotes[0].fetchUrl, rich.remotePath), `fetchUrl ${remotes[0].fetchUrl}`);
    });

    await section("fileHistory, fileBlame, fileRead", async () => {
      const history = await app.invoke("file_history", { repoId, path: "src/auswertung.py", limit: 0 });
      shape("FileHistoryEntry[]", history, "file_history");
      equal(history.at(-1)?.commit.sha, rich.info.shas.csv, "oldest entry is the commit that created the file");
      equal(history.at(-1)?.status, "added", "created");
      truthy(history.every((entry) => entry.path === "src/auswertung.py"), "path per entry");
      equal((await app.invoke("file_history", { repoId, path: "gibt/es/nicht", limit: 5 })).length, 0, "unknown path: empty list");

      const blame = await app.invoke("file_blame", { repoId, path: "src/auswertung.py", sha: null });
      shape("BlameLine[]", blame, "file_blame (working tree)");
      truthy(blame.some((line) => line.uncommitted && /^0{40}$/.test(line.sha)), "the changed line is not committed");
      truthy(blame.some((line) => line.sha === rich.info.shas.csv), "lines from the first commit of the file");
      const atCommit = await app.invoke("file_blame", { repoId, path: "README.md", sha: rich.info.shas.first });
      truthy(atCommit.length > 0 && atCommit.every((line) => line.sha === rich.info.shas.first && !line.uncommitted), "blame at a commit");
      await rejects("unsupported", "file_blame of a binary file", () => app.invoke("file_blame", { repoId, path: rich.info.binaryFile, sha: null }));

      const readme = await app.invoke("file_read", { repoId, path: "README.md", sha: null });
      shape("FileContent", readme, "file_read");
      equal([readme.isBinary, readme.encoding, readme.eol], [false, "utf-8", "lf"], "README");
      truthy(readme.text.includes("Sammlung von Skripten"), "content from the working tree");
      const old = await app.invoke("file_read", { repoId, path: "README.md", sha: rich.info.shas.first });
      truthy(old.text.includes("Kleine Sammlung von Skripten"), "content from the commit");
      const umlaut = await app.invoke("file_read", { repoId, path: rich.info.umlautFile, sha: null });
      shape("FileContent", umlaut, "file_read (umlaut in the name)");
      const binary = await app.invoke("file_read", { repoId, path: rich.info.binaryFile, sha: null });
      equal([binary.text, binary.isBinary, binary.encoding, binary.size], [null, true, "", 3072], "binary file");
      await rejects("not_found", "file_read of a missing file", () => app.invoke("file_read", { repoId, path: "gibt/es/nicht.txt", sha: null }));
      await rejects("not_allowed", "file_read outside the repository", () => app.invoke("file_read", { repoId, path: "../ausserhalb.txt", sha: null }));
    });

    await section("sshKeyList, credentialsList, initTemplates", async () => {
      const keys = await app.invoke("ssh_key_list");
      shape("SshKey[]", keys, "ssh_key_list");
      equal(keys, [], "no keys in a fresh profile");
      const accounts = await app.invoke("credentials_list");
      shape("HostAccount[]", accounts, "credentials_list");
      equal(accounts, [], "no remembered credentials");
      const templates = await app.invoke("init_templates");
      shape("InitTemplates", templates, "init_templates");
      truthy(["node", "python", "rust"].every((key) => templates.gitignore.some((entry) => entry.key === key)), ".gitignore templates");
      truthy(["MIT", "Apache-2.0"].every((key) => templates.licenses.some((entry) => entry.key === key)), "licenses");
    });

    await section("rebasePlan", async () => {
      const merges = await app.invoke("rebase_plan", { repoId, base: rich.info.shas.first });
      shape("RebasePlan", merges, "rebase_plan (with merge commits)");
      equal([merges.status, merges.reason], ["refused", "merge_commits"], "merge commits in the range");
      const dirty = await app.invoke("rebase_plan", { repoId, base: rich.info.shas.longSummary });
      equal([dirty.status, dirty.reason], ["refused", "dirty_worktree"], "uncommitted changes");
      const opened = await app.invoke("repo_open", { path: clean.path });
      const plan = await app.invoke("rebase_plan", { repoId: opened.repo.id, base: "HEAD~1" });
      shape("RebasePlan", plan, "rebase_plan (ok)");
      equal([plan.status, plan.branch, plan.rows?.length, plan.rows?.[0]?.sha, plan.rows?.[0]?.action, plan.rewritesPushed], ["ok", "main", 1, clean.info.head, "pick", true], "plan over a pushed commit");
      await rejects("not_found", "rebase_plan with unknown base", () => app.invoke("rebase_plan", { repoId: opened.repo.id, base: "gibt-es-nicht" }));

      // Delete a remote branch in the same clean repository
      await takeEvents();
      const deleted = await app.invoke("branch_delete_remote", { repoId: opened.repo.id, jobId: "contract-delete-remote", remote: "origin", name: "feature/export" });
      shape("PushResult", deleted, "branch_delete_remote");
      equal(deleted, { status: "done", remote: "origin", branch: "feature/export", createdUpstream: false, forced: false }, "remote branch deleted");
      const deleteEvents = await takeEvents();
      truthy(deleteEvents.some((event) => event.name === "job:done" && event.payload.jobId === "contract-delete-remote" && event.payload.ok), "job:done for the deletion");
      truthy(whatOf(deleteEvents, "repo:changed").includes("refs"), "repo:changed with refs");
      const again = await app.invoke("branch_delete_remote", { repoId: opened.repo.id, jobId: "contract-delete-remote-2", remote: "origin", name: "feature/export" });
      equal(again, { status: "up_to_date" }, "second deletion: already gone");
      await app.invoke("repo_forget", { repoId: opened.repo.id });
      await app.invoke("tab_activate", { tabId });
    });

    await section("conflictGet, operationContinue (OpResult with note)", async () => {
      const opened = await app.invoke("repo_open", { path: conflict.path });
      const id = opened.repo.id;
      const file = await app.invoke("conflict_get", { repoId: id, path: conflict.info.conflicted[0] });
      shape("ConflictFile", file, "conflict_get");
      equal([file.path, file.oursLabel, file.theirsLabel, file.isBinary], [conflict.info.conflicted[0], conflict.info.target, conflict.info.source, false], "conflict file");
      truthy(file.merged?.includes("<<<<<<<"), "working tree with markers");
      await rejects("not_found", "conflict_get without conflict", () => app.invoke("conflict_get", { repoId: id, path: "README.md" }));
      const pending = await app.invoke("operation_continue", { repoId: id, message: null });
      shape("OpResult", pending, "operation_continue (conflicts left)");
      equal([pending.status, pending.files, pending.note, pending.operation?.kind], ["conflict", conflict.info.conflicted, null, "merge"], "conflict as result");
      const peek = await app.invoke("undo_peek", { repoId: id });
      equal(peek, { undo: null, redo: null, undoBlocked: null }, "during the operation undo offers nothing");
      // The fixture is a copy: all timestamps in the index are stale – exactly the case in
      // which an abort without refreshing the index first fails.
      const status = await app.invoke("operation_abort", { repoId: id });
      shape("Status", status, "operation_abort");
      equal([status.operation, status.conflicted], [null, []], "aborted");
      await app.invoke("repo_forget", { repoId: id });
      await app.invoke("tab_activate", { tabId });
    });

    await section("undoPeek, undo, redo", async () => {
      const empty = await app.invoke("undo_peek", { repoId });
      shape("UndoState", empty, "undo_peek");
      equal(empty, { undo: null, redo: null, undoBlocked: null }, "nothing to undo yet");
      await app.invoke("branch_delete", { repoId, names: ["feature/luftdruck"], force: false });
      const peek = await app.invoke("undo_peek", { repoId });
      shape("UndoState", peek, "undo_peek after branch_delete");
      equal([peek.undo?.action, peek.undo?.label, peek.redo], ["delete_branch", "Undo deletion of branch ‘feature/luftdruck’", null], "undo step");
      await takeEvents();
      const undone = await app.invoke("undo", { repoId });
      shape("UndoState", undone, "undo");
      equal([undone.undo, undone.redo?.action, undone.redo?.label], [null, "delete_branch", "Redo deletion of branch ‘feature/luftdruck’"], "after undo");
      truthy((await app.invoke("refs_list", { repoId })).locals.some((ref) => ref.name === "feature/luftdruck"), "the branch is back");
      truthy(whatOf(await takeEvents(), "repo:changed").includes("refs"), "undo reports repo:changed with refs");
      const redone = await app.invoke("redo", { repoId });
      equal([redone.undo?.action, redone.redo], ["delete_branch", null], "after redo");
      await rejects("nothing_to_undo", "redo without another step", () => app.invoke("redo", { repoId }));
      // Back to the fixture state: the branch is back.
      await app.invoke("undo", { repoId });
      await rejects("nothing_to_undo", "undo without another step", () => app.invoke("undo", { repoId }));
    });

    await section("commitDetails and diffFile from the empty tree, commitSearch with searchId", async () => {
      const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const first = await app.invoke("commit_details", { repoId, source: { kind: "commit", sha: rich.info.shas.first } });
      const fromEmpty = await app.invoke("commit_details", { repoId, source: { kind: "range", from: emptyTree, to: rich.info.shas.first } });
      shape("CommitDetails", fromEmpty, "commit_details (range from the empty tree)");
      equal([fromEmpty.commit, fromEmpty.notCombinableReason], [null, null], "range from the empty tree can be combined");
      equal(fromEmpty.files.map((file) => [file.path, file.status]), first.files.map((file) => [file.path, "added"]), "empty tree to root commit = files of the root commit");
      const untilCsv = await app.invoke("commit_details", { repoId, source: { kind: "range", from: emptyTree, to: rich.info.shas.csv } });
      truthy(untilCsv.files.length > first.files.length && untilCsv.files.every((file) => file.status === "added"), "sequence from the root commit: everything added");
      const diff = await app.invoke("diff_file", { repoId, path: untilCsv.files[0].path, source: { kind: "range", from: emptyTree, to: rich.info.shas.csv } });
      shape("FileDiff", diff, "diff_file (range from the empty tree)");
      equal(diff.status, "added", "file from the empty tree is added");

      const [palette, bar] = await Promise.all([
        app.invoke("commit_search", { repoId, query: "a", limit: 5, searchId: "palette" }),
        app.invoke("commit_search", { repoId, query: "e", limit: 5, searchId: "searchbar" }),
      ]);
      shape("CommitSummary[]", palette, "commit_search (searchId palette)");
      shape("CommitSummary[]", bar, "commit_search (searchId searchbar)");
      truthy(palette.length > 0 && bar.length > 0, "two searches with different searchId run side by side");
      shape("CommitSummary[]", await app.invoke("commit_search", { repoId, query: "a", limit: 5 }), "commit_search without searchId");
      shape("CommitSummary[]", await app.invoke("commit_search", { repoId, query: "a", limit: 5, searchId: null }), "commit_search with searchId null");
    });

    await section("fileDelete, patchCreate, patchApply", async () => {
      const opened = await app.invoke("repo_open", { path: clean.path });
      const id = opened.repo.id;
      const settings = await app.invoke("repo_settings_get", { repoId: id });
      equal(settings.commitTemplateText, null, "without a template commitTemplateText is null");
      await app.invoke("file_write", { repoId: id, path: "notiz größe.txt", content: "erste Zeile\nzweite Zeile\n", encoding: "utf-8", eol: "lf" });
      await app.invoke("file_write", { repoId: id, path: "README.md", content: "# Messnetz\n\nGeändert für den Patch.\n", encoding: "utf-8", eol: "lf" });
      const patch = await app.invoke("patch_create", { repoId: id, source: { kind: "unstaged" }, paths: null });
      shape("PatchText", patch, "patch_create (unstaged)");
      truthy(patch.text.includes("+erste Zeile") && patch.text.includes("+Geändert für den Patch.") && patch.skipped.length === 0, `patch contains the changed and the new file: ${show(patch.text)}`);
      const one = await app.invoke("patch_create", { repoId: id, source: { kind: "unstaged" }, paths: ["README.md"] });
      truthy(one.text.includes("Geändert für den Patch.") && !one.text.includes("erste Zeile"), "patch_create with paths takes only these files");
      const mail = await app.invoke("patch_create", { repoId: id, source: { kind: "commit", sha: clean.info.head }, paths: null });
      truthy(mail.text.startsWith("From ") && mail.text.includes("Subject: [PATCH]"), "patch_create (commit) in format-patch format");

      await takeEvents();
      const deleted = await app.invoke("file_delete", { repoId: id, path: "notiz größe.txt" });
      shape("Status", deleted, "file_delete");
      truthy(!fs.existsSync(path.join(clean.path, "notiz größe.txt")), "the file is deleted");
      truthy(whatOf(await takeEvents(), "repo:changed").includes("worktree"), "file_delete reports repo:changed with worktree");
      const peek = await app.invoke("undo_peek", { repoId: id });
      equal([peek.undo?.action, peek.undo?.label], ["discard", "Undo deleting ‘notiz größe.txt’"], "file_delete can be undone");
      await app.invoke("undo", { repoId: id });
      truthy(fs.existsSync(path.join(clean.path, "notiz größe.txt")), "undo brings the file back");
      await rejects("not_found", "file_delete without file", () => app.invoke("file_delete", { repoId: id, path: "gibt-es-nicht.txt" }));
      await rejects("not_allowed", "file_delete outside", () => app.invoke("file_delete", { repoId: id, path: "../draußen.txt" }));

      // Discard everything, then check and apply the patch: the same state comes back.
      await app.invoke("discard_paths", { repoId: id, paths: null });
      const checked = await app.invoke("patch_apply", { repoId: id, text: patch.text, checkOnly: true });
      shape("Status", checked, "patch_apply (checkOnly)");
      equal(checked.unstaged.length, 0, "checkOnly changes nothing");
      await takeEvents();
      const applied = await app.invoke("patch_apply", { repoId: id, text: patch.text, checkOnly: false });
      shape("Status", applied, "patch_apply");
      equal(applied.unstaged.map((file) => file.path).sort(), ["README.md", "notiz größe.txt"], "the patch is applied");
      truthy(whatOf(await takeEvents(), "repo:changed").includes("worktree"), "patch_apply reports repo:changed with worktree");
      await rejects("not_allowed", "patch_apply a second time", () => app.invoke("patch_apply", { repoId: id, text: patch.text, checkOnly: false }));
      await rejects("not_allowed", "patch_apply without a patch", () => app.invoke("patch_apply", { repoId: id, text: "kein Patch", checkOnly: true }));
      await app.invoke("discard_paths", { repoId: id, paths: null });

      // External diff and merge tool: without setup an explanation, nothing is started.
      await app.invoke("file_write", { repoId: id, path: "README.md", content: "# Messnetz\n\nFür das Diff-Tool.\n", encoding: "utf-8", eol: "lf" });
      await rejects("not_found", "open_external diff_tool without a configured tool", () => app.invoke("open_external", { repoId: id, target: "diff_tool", path: "README.md" }));
      await rejects("not_allowed", "open_external diff_tool without file", () => app.invoke("open_external", { repoId: id, target: "diff_tool", path: null }));
      await rejects("not_found", "open_external merge_tool without conflict", () => app.invoke("open_external", { repoId: id, target: "merge_tool", path: "README.md" }));
      await app.invoke("settings_set", { patch: { externalDiffTool: "gibt-es-ganz-sicher-nicht-4711 {local} {remote}" } });
      await rejects("not_found", "open_external diff_tool with missing program", () =>
        app.invoke("open_external", { repoId: id, target: "diff_tool", path: "README.md", source: { kind: "unstaged" } }),
      );
      await app.invoke("settings_set", { patch: { externalDiffTool: null } });
      await app.invoke("discard_paths", { repoId: id, paths: null });

      await app.invoke("repo_forget", { repoId: id });
      await app.invoke("tab_activate", { tabId });
    });

    await section("worktrees", async () => {
      const opened = await app.invoke("repo_open", { path: clean.path });
      const id = opened.repo.id;
      const list = await app.invoke("worktree_list", { repoId: id });
      shape("Worktree[]", list, "worktree_list");
      equal([list.length, list[0].isMain, list[0].isCurrent, list[0].branch], [1, true, true, "main"], "only the main worktree");
      const target = path.join(clean.root, "zweiter worktree");
      await takeEvents();
      const added = await app.invoke("worktree_add", { repoId: id, path: target, branch: "vertrag/worktree", newBranch: true, start: null });
      shape("Worktree[]", added, "worktree_add");
      const second = added.find((entry) => samePath(entry.path, target));
      equal([added.length, second?.branch, second?.isMain, second?.isCurrent, second?.hasChanges], [2, "vertrag/worktree", false, false, false], "new worktree with new branch");
      truthy(whatOf(await takeEvents(), "repo:changed").includes("refs"), "worktree_add reports repo:changed with refs");
      const locked = await app.invoke("worktree_lock", { repoId: id, path: target, reason: "für die Vertragsprüfung" });
      shape("Worktree[]", locked, "worktree_lock");
      equal([locked[1].isLocked, locked[1].lockReason], [true, "für die Vertragsprüfung"], "locked with reason");
      await rejects("not_allowed", "worktree_remove locked", () => app.invoke("worktree_remove", { repoId: id, path: target, force: true }));
      shape("Worktree[]", await app.invoke("worktree_unlock", { repoId: id, path: target }), "worktree_unlock");
      fs.writeFileSync(path.join(target, "unverfolgt.txt"), "x");
      await rejects("dirty_worktree", "worktree_remove with changes", () => app.invoke("worktree_remove", { repoId: id, path: target, force: false }));
      await rejects("name_exists", "worktree_add with existing branch", () =>
        app.invoke("worktree_add", { repoId: id, path: path.join(clean.root, "dritter"), branch: "main", newBranch: true, start: null }),
      );
      const removed = await app.invoke("worktree_remove", { repoId: id, path: target, force: true });
      shape("Worktree[]", removed, "worktree_remove");
      equal(removed.length, 1, "the worktree is removed");
      shape("Worktree[]", await app.invoke("worktree_prune", { repoId: id }), "worktree_prune");
      await app.invoke("branch_delete", { repoId: id, names: ["vertrag/worktree"], force: true });
      await app.invoke("repo_forget", { repoId: id });
      await app.invoke("tab_activate", { tabId });
    });

    await section("submodule, lfs, signing", async () => {
      const opened = await app.invoke("repo_open", { path: clean.path });
      const id = opened.repo.id;
      const subs = await app.invoke("submodule_list", { repoId: id });
      shape("Submodule[]", subs, "submodule_list");
      equal(subs, [], "no submodules");
      await takeEvents();
      await rejects("not_allowed", "submodule_add with FTP URL", () => app.invoke("submodule_add", { repoId: id, jobId: "vertrag-sub-1", url: "ftp://server.example/lib.git", path: "libs/lib" }));
      const jobEvents = (await takeEvents()).filter((event) => event.name === "job:done" && event.payload.jobId === "vertrag-sub-1");
      equal(jobEvents.map((event) => [event.payload.ok, event.payload.cancelled]), [[false, false]], "submodule_add reports job:done on an error too");
      await rejects("path_exists", "submodule_add onto an existing path", () => app.invoke("submodule_add", { repoId: id, jobId: "vertrag-sub-2", url: "https://example.invalid/lib.git", path: "src" }));
      shape("Submodule[]", await app.invoke("submodule_update", { repoId: id, jobId: "vertrag-sub-3", paths: null, init: true }), "submodule_update without submodules");
      await rejects("not_found", "submodule_update with unknown path", () => app.invoke("submodule_update", { repoId: id, jobId: "vertrag-sub-4", paths: ["kein/submodul"], init: false }));
      await rejects("not_found", "submodule_remove without submodule", () => app.invoke("submodule_remove", { repoId: id, path: "kein/submodul" }));

      const lfs = await app.invoke("lfs_status", { repoId: id });
      shape("LfsStatus", lfs, "lfs_status");
      if (lfs.installed) {
        truthy(/^\d+\.\d+/.test(lfs.version ?? ""), `lfs_status.version does not look like a version: ${lfs.version}`);
        const tracked = await app.invoke("lfs_track", { repoId: id, pattern: "*.vertragstest" });
        shape("LfsStatus", tracked, "lfs_track");
        equal(tracked.patterns, ["*.vertragstest"], "pattern is tracked");
        const untracked = await app.invoke("lfs_untrack", { repoId: id, pattern: "*.vertragstest" });
        shape("LfsStatus", untracked, "lfs_untrack");
        equal(untracked.patterns, [], "pattern is gone again");
        await rejects("not_found", "lfs_untrack without pattern", () => app.invoke("lfs_untrack", { repoId: id, pattern: "*.vertragstest" }));
        shape("string", await app.invoke("lfs_prune", { repoId: id }), "lfs_prune");
      } else {
        equal([lfs.version, lfs.installed], [null, false], "no version without Git LFS");
        await rejects("unsupported", "lfs_track without Git LFS", () => app.invoke("lfs_track", { repoId: id, pattern: "*.bin" }));
        await rejects("unsupported", "lfs_pull without Git LFS", () => app.invoke("lfs_pull", { repoId: id, jobId: "vertrag-lfs-1" }));
      }
      await rejects(lfs.installed ? "not_allowed" : "not_allowed", "lfs_track with empty pattern", () => app.invoke("lfs_track", { repoId: id, pattern: "  " }));

      const signing = await app.invoke("signing_status", { repoId: id });
      shape("SigningStatus", signing, "signing_status (repository)");
      shape("SigningStatus", await app.invoke("signing_status", { repoId: null }), "signing_status (global)");
      await takeEvents();
      const set = await app.invoke("signing_set", { repoId: id, enabled: true, format: "ssh", key: "~/.ssh/id_ed25519.pub" });
      shape("SigningStatus", set, "signing_set");
      equal([set.enabled, set.format, set.key], [true, "ssh", "~/.ssh/id_ed25519.pub"], "signing_set in the repository");
      truthy(whatOf(await takeEvents(), "repo:changed").includes("config"), "signing_set reports repo:changed with config");
      // Program and allowed-signers file: three-valued (missing = keep, null = remove).
      const withProgram = await app.invoke("signing_set", { repoId: id, enabled: true, format: "ssh", key: "~/.ssh/id_ed25519.pub", program: "C:/Programme/OpenSSH/ssh-keygen.exe", allowedSignersFile: "~/.ssh/allowed_signers" });
      shape("SigningStatus", withProgram, "signing_set with program");
      equal([withProgram.program, withProgram.allowedSignersFile], ["C:/Programme/OpenSSH/ssh-keygen.exe", "~/.ssh/allowed_signers"], "program (gpg.ssh.program) and allowedSignersFile set");
      const kept = await app.invoke("signing_set", { repoId: id, enabled: true, format: "ssh", key: "~/.ssh/id_ed25519.pub" });
      equal([kept.program, kept.allowedSignersFile], [withProgram.program, withProgram.allowedSignersFile], "without the fields both stay");
      const dropped = await app.invoke("signing_set", { repoId: id, enabled: null, format: "ssh", key: null, program: null, allowedSignersFile: null });
      equal([dropped.enabled, dropped.program, dropped.allowedSignersFile], [false, null, null], "null removes the entries in the repository (enabled: null = as global)");
      const cleared = await app.invoke("signing_set", { repoId: id, enabled: false, format: null, key: null });
      equal([cleared.enabled, cleared.format, cleared.key], [false, signing.format, signing.key], "signing_set reverted");
      await app.invoke("discard_paths", { repoId: id, paths: null });
      await app.invoke("repo_forget", { repoId: id });
      await app.invoke("tab_activate", { tabId });
    });

    await section("terminal", async () => {
      const terminalEvents = await app.recordEvents(["terminal:data", "terminal:exit"]);
      const seen = [];
      const pull = async () => {
        const list = await terminalEvents.take();
        for (const event of list) shape("CoreEvents", { ...emptyEvents(), [event.name]: event.payload }, `Event ${event.name}`);
        seen.push(...list);
        return seen;
      };
      const until = async (label, done) => {
        const deadline = Date.now() + 60000;
        while (!done(await pull())) {
          if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
          await app.page.waitForTimeout(100);
        }
      };
      const terminalId = await app.invoke("terminal_open", { repoId, cols: 100, rows: 30 });
      shape("string", terminalId, "terminal_open");
      const output = () => seen.filter((event) => event.name === "terminal:data" && event.payload.terminalId === terminalId).map((event) => event.payload.data).join("");
      equal(await app.invoke("terminal_resize", { terminalId, cols: 120, rows: 40 }), null, "terminal_resize returns nothing");
      equal(await app.invoke("terminal_write", { terminalId, data: "git rev-parse HEAD\r" }), null, "terminal_write returns nothing");
      await until("command output in the terminal", () => output().includes(rich.info.head));
      await app.invoke("terminal_write", { terminalId, data: "exit 7\r" });
      await until("terminal:exit", (list) => list.some((event) => event.name === "terminal:exit" && event.payload.terminalId === terminalId));
      equal(seen.filter((event) => event.name === "terminal:exit").map((event) => event.payload.code), [7], "exit code of the shell, exactly one terminal:exit");
      await rejects("not_found", "terminal_write after the end", () => app.invoke("terminal_write", { terminalId, data: "x" }));
      equal(await app.invoke("terminal_close", { terminalId }), null, "terminal_close after the end is not an error");
      const second = await app.invoke("terminal_open", { repoId, cols: 80, rows: 24 });
      await app.invoke("terminal_close", { terminalId: second });
      await until("terminal:exit after terminal_close", (list) => list.some((event) => event.name === "terminal:exit" && event.payload.terminalId === second));
      await rejects("not_found", "terminal_open with unknown repository", () => app.invoke("terminal_open", { repoId: "gibt-es-nicht", cols: 80, rows: 24 }));
      await terminalEvents.stop();
    });

    await section("External start: appLaunchRequest, second instance, app:open_request", async () => {
      const first = await app.invoke("app_launch_request");
      shape("LaunchRequest | null", first, "app_launch_request");
      equal(await app.invoke("app_launch_request"), null, "a second call returns nothing");
      const openEvents = await app.recordEvents(["app:open_request"]);
      // A second instance with the same data directory hands the request over and exits at once.
      const second = (args) =>
        new Promise((resolve) => {
          const child = spawn(path.join(ROOT, "target", "debug", "forkyard.exe"), args, {
            cwd: rich.path,
            env: { ...process.env, FORKYARD_DATA_DIR: app.dataDir, FORKYARD_E2E_WINDOW: "hidden" },
            stdio: "ignore",
            windowsHide: true,
          });
          const timer = setTimeout(() => {
            child.kill();
            resolve("still running (not handed over)");
          }, 20000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
      const short = rich.info.head.slice(0, 12);
      equal(await second([rich.path, "--commit", short]), 0, "second instance exits once the first has the request");
      await openEvents.waitFor("app:open_request", 10000);
      const [byPath] = await openEvents.take();
      shape("CoreEvents", { ...emptyEvents(), [byPath.name]: byPath.payload }, "Event app:open_request");
      truthy(samePath(byPath.payload.path, rich.path), `app:open_request names ${byPath.payload.path}, expected ${rich.path}`);
      equal(byPath.payload.commit, short, "commit from --commit");
      // The same as a link, with a path relative to the working directory of the second instance.
      equal(await second([`forkyard://open?path=${encodeURIComponent(path.join(rich.path, "src"))}&commit=${short}`]), 0, "forkyard:// link is handed over");
      await openEvents.waitFor("app:open_request", 10000);
      const [byUrl] = await openEvents.take();
      truthy(samePath(byUrl.payload.path, path.join(rich.path, "src")), `path from the link: ${byUrl.payload.path}`);
      // A folder that does not exist: the request still arrives, with a reason and without a commit.
      const missing = path.join(rich.root, "gibt-es-nicht");
      equal(await second([missing, "--commit", short]), 0, "a request with an invalid path is handed over too");
      await openEvents.waitFor("app:open_request", 10000);
      const [gone] = await openEvents.take();
      shape("CoreEvents", { ...emptyEvents(), [gone.name]: gone.payload }, "Event app:open_request (invalid path)");
      equal([gone.payload.invalid, gone.payload.commit], ["path_not_found", null], "invalid names the reason");
      truthy(samePath(gone.payload.path, missing), `the requested path is in the request: ${gone.payload.path}`);
      equal(await app.invoke("app_launch_request"), null, "delivered by event, cannot be fetched again");
      await openEvents.stop();
      await app.settle();
      await app.invoke("tab_activate", { tabId });
    });

    await section("fileHistory with offset, encoding per call", async () => {
      const all = await app.invoke("file_history", { repoId, path: "src/auswertung.py", limit: 0 });
      const paged = [];
      for (let offset = 0; offset < all.length; offset += 2) {
        const page = await app.invoke("file_history", { repoId, path: "src/auswertung.py", limit: 2, offset });
        shape("FileHistoryEntry[]", page, `file_history (offset ${offset})`);
        paged.push(...page);
      }
      equal(paged.map((entry) => entry.commit.sha), all.map((entry) => entry.commit.sha), "paging gives the same list");
      equal((await app.invoke("file_history", { repoId, path: "src/auswertung.py", limit: 2, offset: all.length })).length, 0, "past the end: empty");

      const forced = await app.invoke("file_read", { repoId, path: "README.md", sha: null, encoding: "windows-1252" });
      shape("FileContent", forced, "file_read (encoding)");
      equal(forced.encoding, "windows-1252", "the given encoding applies");
      equal((await app.invoke("file_read", { repoId, path: "README.md", sha: null, encoding: null })).encoding, "utf-8", "null means detect");
      await rejects("not_allowed", "file_read with unknown encoding", () => app.invoke("file_read", { repoId, path: "README.md", sha: null, encoding: "klingonisch" }));
      shape("BlameLine[]", await app.invoke("file_blame", { repoId, path: "README.md", sha: rich.info.shas.first, encoding: "iso-8859-15" }), "file_blame (encoding)");
      const diff = await app.invoke("diff_file", { repoId, path: "src/auswertung.py", source: { kind: "unstaged" }, encoding: "windows-1252" });
      shape("FileDiff", diff, "diff_file (encoding)");
      equal([diff.kind, diff.encoding], ["text", "windows-1252"], "diff_file with given encoding");
      await rejects("not_allowed", "diff_file with unknown encoding", () => app.invoke("diff_file", { repoId, path: "src/auswertung.py", source: { kind: "unstaged" }, encoding: "klingonisch" }));
    });

    await section("activityList: error code in the entry", async () => {
      const page = await app.invoke("activity_list", { scope: "repo", repoId, cursor: null, limit: 200 });
      shape("ActivityPage", page, "activity_list");
      truthy(page.entries.every((entry) => "code" in entry), "every entry carries the field code");
      truthy(page.entries.filter((entry) => entry.exitCode === 0).every((entry) => entry.code === null), "successful calls have no code");
      const failed = page.entries.filter((entry) => entry.exitCode !== null && entry.exitCode !== 0);
      truthy(failed.every((entry) => typeof entry.code === "string"), `failed calls carry a code: ${show(failed.map((entry) => [entry.command, entry.code]))}`);
    });

    await section("branchFastForward, gitflow, stashApplyPaths, workspaces", async () => {
      const opened = await app.invoke("repo_open", { path: clean.path });
      const id = opened.repo.id;
      const rev = (name) => clean.git("rev-parse", name);

      // --- Fast-forward of a branch that is not checked out ---
      const before = rev("main");
      const remoteSha = clean.commitOnRemote({ message: "Kalibrierung nachgetragen" });
      clean.git("checkout", "-q", "-b", "arbeit");
      clean.git("branch", "ohne-upstream");
      clean.git("fetch", "-q", "origin");
      await takeEvents();
      const forwarded = await app.invoke("branch_fast_forward", { repoId: id, branch: "main" });
      shape("OpResult", forwarded, "branch_fast_forward");
      equal([forwarded.status, forwarded.sha, forwarded.fastForward], ["done", remoteSha, true], "fast-forward to the upstream");
      equal(rev("main"), remoteSha, "git: main is at origin/main");
      equal(clean.git("symbolic-ref", "--short", "HEAD"), "arbeit", "HEAD stays");
      truthy(whatOf(await takeEvents(), "repo:changed").includes("refs"), "branch_fast_forward reports repo:changed with refs");
      equal(await app.invoke("branch_fast_forward", { repoId: id, branch: "main" }), { status: "up_to_date" }, "second call: nothing to do");
      await rejects("not_allowed", "branch_fast_forward on the checked-out branch", () => app.invoke("branch_fast_forward", { repoId: id, branch: "arbeit" }));
      await rejects("no_upstream", "branch_fast_forward without upstream", () => app.invoke("branch_fast_forward", { repoId: id, branch: "ohne-upstream" }));
      await rejects("not_found", "branch_fast_forward with unknown branch", () => app.invoke("branch_fast_forward", { repoId: id, branch: "gibt-es-nicht" }));
      const afterUndo = await app.invoke("undo", { repoId: id });
      shape("UndoState", afterUndo, "undo after branch_fast_forward");
      equal(rev("main"), before, "undo resets main");
      await app.invoke("redo", { repoId: id });
      equal(rev("main"), remoteSha, "redo repeats the fast-forward");

      // --- Gitflow ---
      const fresh = await app.invoke("gitflow_status", { repoId: id });
      shape("GitflowStatus", fresh, "gitflow_status (not set up)");
      equal([fresh.initialized, fresh.main, fresh.develop, fresh.active], [false, "main", "develop", []], "suggestions without setup");
      await rejects("not_allowed", "gitflow_start without setup", () => app.invoke("gitflow_start", { repoId: id, kind: "feature", name: "x" }));
      const flow = await app.invoke("gitflow_init", { repoId: id, main: "main", develop: "develop", prefixes: { feature: "feature/", release: "release/", hotfix: "hotfix/", versionTag: "v" } });
      shape("GitflowStatus", flow, "gitflow_init");
      equal([flow.initialized, flow.prefixes.versionTag], [true, "v"], "set up");
      equal([clean.git("config", "gitflow.branch.master"), clean.git("config", "gitflow.branch.develop"), clean.git("config", "gitflow.prefix.versiontag")], ["main", "develop", "v"], "git: the usual gitflow.* keys");
      const started = await app.invoke("gitflow_start", { repoId: id, kind: "feature", name: "karte" });
      shape("GitflowStatus", started, "gitflow_start");
      truthy(started.active.some((entry) => entry.kind === "feature" && entry.name === "karte" && entry.branch === "feature/karte"), `active branches: ${show(started.active)}`);
      equal(clean.git("symbolic-ref", "--short", "HEAD"), "feature/karte", "git: feature branch checked out");
      clean.write("karte.md", "# Karte\n");
      clean.git("add", "-A");
      clean.git("commit", "-q", "-m", "Karte angelegt");
      const finished = await app.invoke("gitflow_finish", { repoId: id, kind: "feature", name: "karte" });
      shape("OpResult", finished, "gitflow_finish (feature)");
      equal(finished.status, "done", "feature finished");
      equal([clean.git("symbolic-ref", "--short", "HEAD"), clean.git("branch", "--list", "feature/karte")], ["develop", ""], "git: on develop, feature branch deleted");
      equal(clean.git("log", "-1", "--format=%P", "develop").split(" ").length, 2, "git: merge commit on develop");
      await app.invoke("gitflow_start", { repoId: id, kind: "release", name: "1.0" });
      await rejects("not_allowed", "second release branch", () => app.invoke("gitflow_start", { repoId: id, kind: "release", name: "1.1" }));
      clean.write("VERSION", "1.0\n");
      clean.git("add", "-A");
      clean.git("commit", "-q", "-m", "Version 1.0");
      const mainBefore = rev("main");
      const released = await app.invoke("gitflow_finish", { repoId: id, kind: "release", name: "1.0", options: { message: "Erste Fassung", deleteBranch: true } });
      shape("OpResult", released, "gitflow_finish (release)");
      equal(released.status, "done", "release finished");
      equal([clean.git("cat-file", "-t", "refs/tags/v1.0"), rev("v1.0^{commit}")], ["tag", rev("main")], "git: annotated tag v1.0 on main");
      truthy(rev("main") !== mainBefore, "git: main has the merge");
      const undone = await app.invoke("undo", { repoId: id });
      shape("UndoState", undone, "undo after gitflow_finish");
      equal([rev("main"), clean.git("tag", "-l", "v1.0"), clean.git("symbolic-ref", "--short", "HEAD")], [mainBefore, "", "release/1.0"], "one undo reverts merge, tag and branch switch");
      await rejects("not_found", "gitflow_finish with unknown branch", () => app.invoke("gitflow_finish", { repoId: id, kind: "hotfix", name: "gibt-es-nicht" }));

      // --- Single file from a stash ---
      clean.write("stationen.csv", "geändert\n");
      clean.write("notiz-neu.txt", "neu\n");
      const stashes = await app.invoke("stash_create", { repoId: id, opId: `contract-stash-${Date.now()}`, message: "Teil", paths: null, includeUntracked: true });
      equal(stashes.length, 1, "one stash");
      const partly = await app.invoke("stash_apply_paths", { repoId: id, index: 0, paths: ["stationen.csv"] });
      shape("Status", partly, "stash_apply_paths");
      equal(fs.readFileSync(path.join(clean.path, "stationen.csv"), "utf8").replace(/\r\n/g, "\n"), "geändert\n", "the chosen file is applied");
      truthy(!fs.existsSync(path.join(clean.path, "notiz-neu.txt")), "the other file stays in the stash");
      await rejects("not_found", "stash_apply_paths with a file that is not in the stash", () => app.invoke("stash_apply_paths", { repoId: id, index: 0, paths: ["README.md"] }));
      await app.invoke("undo", { repoId: id });
      truthy(!fs.readFileSync(path.join(clean.path, "stationen.csv"), "utf8").startsWith("geändert"), "undo reverts the apply");
      await app.invoke("stash_drop", { repoId: id, index: 0 });

      // --- Workspaces ---
      equal(await app.invoke("workspace_list"), [], "no workspace yet");
      await takeEvents();
      const saved = await app.invoke("workspace_save", { name: "Schule", repoIds: [repoId, id] });
      shape("Workspace[]", saved, "workspace_save");
      equal([saved.length, saved[0]?.name, saved[0]?.repoIds], [1, "Schule", [repoId, id]], "workspace created");
      truthy(whatOf(await takeEvents(), "app:changed").includes("workspaces"), "workspace_save reports app:changed with workspaces");
      const workspaceId = saved[0].id;
      const fetched = await app.invoke("workspace_fetch", { jobId: "contract-ws-fetch", workspaceId });
      shape("WorkspaceRunResult", fetched, "workspace_fetch");
      equal(fetched.results.map((entry) => entry.repoId), [repoId, id], "one result per repository, in workspace order");
      const runEvents = await takeEvents();
      const progress = runEvents.filter((event) => event.name === "job:progress" && event.payload.jobId === "contract-ws-fetch");
      truthy([repoId, id].every((one) => progress.some((event) => event.payload.repoId === one && event.payload.phase === "start")), "job:progress with repoId per repository");
      equal(runEvents.filter((event) => event.name === "job:done" && event.payload.jobId === "contract-ws-fetch").map((event) => event.payload.ok), [true], "exactly one job:done");
      const pulled = await app.invoke("workspace_pull", { jobId: "contract-ws-pull", workspaceId, mode: null });
      shape("WorkspaceRunResult", pulled, "workspace_pull");
      const renamed = await app.invoke("workspace_save", { id: workspaceId, name: "Schule Nord", repoIds: [id] });
      equal([renamed[0]?.name, renamed[0]?.repoIds], ["Schule Nord", [id]], "workspace_save replaces name and repositories");
      await rejects("invalid_name", "workspace_save without a name", () => app.invoke("workspace_save", { name: " ", repoIds: [] }));
      await rejects("not_found", "workspace_save with unknown repository", () => app.invoke("workspace_save", { name: "X", repoIds: ["gibt-es-nicht"] }));
      await rejects("not_found", "workspace_fetch with unknown workspace", () => app.invoke("workspace_fetch", { jobId: "contract-ws-x", workspaceId: "gibt-es-nicht" }));
      equal(await app.invoke("workspace_delete", { id: workspaceId }), [], "workspace_delete");
      await takeEvents();
      await app.invoke("repo_forget", { repoId: id });
      await app.invoke("tab_activate", { tabId });
    });

    await section("Network: HTTPS with custom certificate, exception per host only", async () => {
      const original = await app.invoke("settings_get");
      const server = await startGitHttpServer({ users: { lena: "geheim" }, tls: true });
      const opened = await app.invoke("repo_open", { path: clean.path });
      const id = opened.repo.id;
      const credentials = await app.recordEvents(["credential:request"]);
      let run = 0;
      /** Fetch from the TLS remote. If a credential prompt comes, the TLS check has passed; the prompt is cancelled. */
      const attempt = async () => {
        run += 1;
        const requestsBefore = server.requests.length;
        const pending = app.invoke("fetch", { repoId: id, jobId: `contract-tls-${run}`, remote: "tls", prune: false }).then(
          () => ({ code: null }),
          (error) => ({ code: error.code, gitOutput: error.gitOutput ?? "" }),
        );
        let asked = false;
        let outcome = null;
        const deadline = Date.now() + 60000;
        while (outcome === null && Date.now() < deadline) {
          outcome = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(null), 150))]);
          for (const event of await credentials.take()) {
            asked = true;
            await app.invoke("credential_answer", { requestId: event.payload.requestId, value: null, remember: false });
          }
        }
        return { asked, code: outcome?.code ?? "timeout", reachedServer: server.requests.length > requestsBefore };
      };
      try {
        await app.invoke("settings_set", { patch: { autoFetchMinutes: 0, proxyUrl: null, proxyByHost: [], sslCaFile: null, sslNoVerifyHosts: [] } });
        server.createBare("messnetz.git", { from: clean.path });
        const url = server.url("messnetz.git");
        const host = new URL(url).host;
        await app.invoke("remote_add", { repoId: id, name: "tls", fetchUrl: url, pushUrl: null });

        const untrusted = await attempt();
        equal([untrusted.asked, untrusted.reachedServer], [false, false], `without a setting the certificate check already fails (code ${untrusted.code})`);

        const withCa = await app.invoke("settings_set", { patch: { sslCaFile: server.caFile } });
        shape("Settings", withCa, "settings_set (sslCaFile)");
        const trusted = await attempt();
        equal([trusted.asked, trusted.reachedServer, trusted.code], [true, true, "cancelled"], "with custom CA bundle: TLS works, Git asks for credentials");

        const exception = await app.invoke("settings_set", { patch: { sslCaFile: null, sslNoVerifyHosts: [host] } });
        equal(exception.sslNoVerifyHosts, [`https://${host}`], "the host is stored as https://host:port in the settings");
        const skipped = await attempt();
        equal([skipped.asked, skipped.reachedServer, skipped.code], [true, true, "cancelled"], "exception for exactly this host: no TLS check");

        await app.invoke("settings_set", { patch: { sslNoVerifyHosts: ["anderer-host.example"] } });
        const other = await attempt();
        equal([other.asked, other.reachedServer], [false, false], "an exception for a DIFFERENT host does not apply here");

        await rejects("not_allowed", "sslNoVerifyHosts with wildcard", () => app.invoke("settings_set", { patch: { sslNoVerifyHosts: ["*"] } }));
        await rejects("not_allowed", "proxyUrl without scheme", () => app.invoke("settings_set", { patch: { proxyUrl: "proxy:8080" } }));
        await rejects("path_not_found", "sslCaFile that does not exist", () => app.invoke("settings_set", { patch: { sslCaFile: path.join(clean.root, "fehlt.pem") } }));
      } finally {
        await credentials.stop();
        await app.invoke("settings_set", { patch: { autoFetchMinutes: original.autoFetchMinutes, proxyUrl: null, proxyByHost: [], sslCaFile: null, sslNoVerifyHosts: [] } });
        await app.invoke("remote_remove", { repoId: id, name: "tls" }).catch(() => {});
        await server.close();
        await takeEvents();
        await app.invoke("repo_forget", { repoId: id });
        await app.invoke("tab_activate", { tabId });
      }
    });

    await section("Hosts: accounts, pull requests, issues against the local test server", async () => {
      const opened = await app.invoke("repo_open", { path: clean.path });
      const id = opened.repo.id;
      const remotes = [];
      /** Runs `call` and returns the error (or null). */
      const failure = async (call) => {
        try {
          await call();
          return null;
        } catch (error) {
          return error;
        }
      };
      try {
        const none = await app.invoke("host_accounts");
        shape("HosterAccount[]", none, "host_accounts");
        equal(none, [], "no account yet");
        for (const kind of ["github", "gitlab"]) {
          hostMock.reset();
          await takeEvents();
          const account = await app.invoke("host_connect", { kind, baseUrl: hostMock.url, token: hostMock.token });
          shape("HosterAccount", account, `host_connect (${kind})`);
          equal([account.kind, account.baseUrl, account.tokenHint, account.scopesOk, account.missingScopes, account.lastError], [kind, hostMock.url, "…abcd", true, [], null], `account (${kind})`);
          truthy(!JSON.stringify(account).includes(hostMock.token), "the token is not in the response");
          truthy(whatOf(await takeEvents(), "app:changed").includes("host_accounts"), "host_connect reports app:changed with host_accounts");
          equal((await app.invoke("host_accounts")).map((entry) => entry.id), [account.id], "host_accounts");
          equal(keyringEntries(keyringService), [`hoster:${account.id}`], "the token is in the OS keychain – as the only entry");

          const remote = `mock-${kind}`;
          await app.invoke("remote_add", { repoId: id, name: remote, fetchUrl: hostMock.remoteUrl(kind), pushUrl: null });
          remotes.push(remote);
          const info = await app.invoke("host_repo_info", { repoId: id, remote });
          shape("HostRepoInfo | null", info, `host_repo_info (${kind})`);
          equal([info.kind, info.owner, info.name, info.defaultBranch, info.canPush, info.error], [kind, kind === "github" ? "octo" : "gruppe/unter", "demo", "main", true, null], `repository at the host (${kind})`);
          equal(info.account?.id, account.id, "the account is attached to the result");

          const first = await app.invoke("pr_list", { repoId: id, state: "open", remote });
          shape("PrPage", first, `pr_list (${kind})`);
          equal([first.items.length, first.nextPage, first.items[0].number], [20, 2, 44], "first page: 20 of 36 open");
          const second = await app.invoke("pr_list", { repoId: id, state: "open", page: 2, perPage: 20, remote });
          const one = second.items.find((pr) => pr.number === 1);
          equal([second.items.length, second.nextPage, one?.checks, one?.reviewState], [16, null, "passing", "approved"], "second page, with checks and review state");
          equal((await app.invoke("pr_list", { repoId: id, state: "merged", remote })).items.map((pr) => [pr.number, pr.state]), [[40, "merged"], [30, "merged"], [20, "merged"], [10, "merged"]], "Filter merged");

          const details = await app.invoke("pr_get", { repoId: id, number: 1, remote });
          shape("PrDetails", details, `pr_get (${kind})`);
          truthy(details.comments.length >= 2 && details.commits.length === 2 && details.checkRuns.length >= 2, "comments, commits and checks are included");
          const before = hostMock.requests.length;
          await app.invoke("pr_get", { repoId: id, number: 1, remote });
          truthy(hostMock.requests.slice(before).some((request) => request.status === 304), "reading again asks with If-None-Match – the server answers 304");

          const created = await app.invoke("pr_create", { repoId: id, title: "Vertragsprüfung", body: "Text", sourceBranch: "feature/vertrag", targetBranch: "main", draft: false, reviewers: null, labels: null, remote });
          shape("PrSummary", created, `pr_create (${kind})`);
          equal([created.number, created.title, created.sourceBranch], [101, "Vertragsprüfung", "feature/vertrag"], "created");
          await rejects("name_exists", "pr_create: one already exists", () => app.invoke("pr_create", { repoId: id, title: "Doppelt", body: "", sourceBranch: "schon-da", targetBranch: "main", draft: false, remote }));
          await rejects("empty_message", "pr_create without title", () => app.invoke("pr_create", { repoId: id, title: " ", body: "", sourceBranch: "a", targetBranch: "main", draft: false, remote }));
          const renamed = await app.invoke("pr_update", { repoId: id, number: 2, title: "Neuer Titel", remote });
          shape("PrSummary", renamed, `pr_update (${kind})`);
          equal(renamed.title, "Neuer Titel", "pr_update changes only the title");
          const comment = await app.invoke("pr_comment", { repoId: id, number: 2, body: "Passt so.", remote });
          shape("HostComment", comment, `pr_comment (${kind})`);
          equal((await app.invoke("pr_merge", { repoId: id, number: 2, method: "squash", deleteBranch: false, remote })).state, "merged", "pr_merge");
          await rejects("host_rejected", "pr_merge, not mergeable", () => app.invoke("pr_merge", { repoId: id, number: 13, method: "merge", deleteBranch: false, remote }));
          equal((await app.invoke("pr_close", { repoId: id, number: 4, remote })).state, "closed", "pr_close");
          equal((await app.invoke("pr_reopen", { repoId: id, number: 4, remote })).state, "open", "pr_reopen");
          shape("string | null", await app.invoke("pr_template", { repoId: id }), "pr_template");

          const issues = await app.invoke("issue_list", { repoId: id, state: "open", query: null, remote });
          shape("IssuePage", issues, `issue_list (${kind})`);
          truthy(issues.items.length >= 6 && issues.items.every((issue) => issue.state === "open"), "open issues");
          shape("IssuePage", await app.invoke("issue_list", { repoId: id, state: "all", query: "anmeldung", page: 1, perPage: 10, remote }), "issue_list with search text");
          shape("IssueDetails", await app.invoke("issue_get", { repoId: id, number: 2, remote }), `issue_get (${kind})`);

          // Error kinds – the server is switched on purpose for each.
          hostMock.fail("rate_limit", { times: 1 });
          const limited = await failure(() => app.invoke("pr_get", { repoId: id, number: 6, remote }));
          equal(limited?.code, "host_rate_limited", "403/429 with limit");
          truthy(/You can continue at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(limited?.message ?? ""), `the message names the time: ${limited?.message}`);
          hostMock.fail("not_found", { times: 1 });
          await rejects("host_not_found", "404", () => app.invoke("pr_get", { repoId: id, number: 6, remote }));
          hostMock.fail("broken_json", { times: 1 });
          await rejects("unknown", "broken JSON", () => app.invoke("issue_list", { repoId: id, state: "open", remote }));
          hostMock.fail("unauthorized", { times: 1 });
          await rejects("host_auth_failed", "401", () => app.invoke("pr_get", { repoId: id, number: 6, remote }));
          truthy((await app.invoke("host_accounts"))[0].lastError, "a rejected token marks the account");
          const checked = await app.invoke("host_check", { accountId: account.id });
          shape("HosterAccount", checked, "host_check");
          equal(checked.lastError, null, "after a successful check the error is gone");

          // The token is in no log entry.
          const logs = [
            ...(await app.invoke("activity_list", { scope: "repo", repoId: id, cursor: null, limit: 500 })).entries,
            ...(await app.invoke("activity_list", { scope: "app", repoId: null, cursor: null, limit: 500 })).entries,
          ];
          truthy(logs.some((entry) => entry.command.startsWith(`GET ${hostMock.url}/api/`)), "the API calls are in the log");
          truthy(!JSON.stringify(logs).includes(hostMock.token), "no token in the log");
          truthy(!JSON.stringify(await takeEvents()).includes(hostMock.token), "no token in the events");

          const left = await app.invoke("host_disconnect", { accountId: account.id });
          shape("HosterAccount[]", left, "host_disconnect");
          equal(left, [], "disconnected");
          equal(await app.invoke("host_repo_info", { repoId: id, remote }), null, "without an account the local server is not a known host");
        }

        // Without an account, and with a different host.
        await app.invoke("remote_add", { repoId: id, name: "oeffentlich", fetchUrl: "git@github.com:octo/demo.git", pushUrl: null });
        await app.invoke("remote_add", { repoId: id, name: "anderswo", fetchUrl: "https://git.example.org/team/demo.git", pushUrl: null });
        remotes.push("oeffentlich", "anderswo");
        const open = await app.invoke("host_repo_info", { repoId: id, remote: "oeffentlich" });
        shape("HostRepoInfo | null", open, "host_repo_info without account");
        equal([open.account, open.kind, open.webUrl, open.defaultBranch], [null, "github", "https://github.com/octo/demo", null], "github.com is recognised without an account too");
        await rejects("host_not_connected", "pr_list without account", () => app.invoke("pr_list", { repoId: id, state: "open", remote: "oeffentlich" }));
        equal(await app.invoke("host_repo_info", { repoId: id, remote: "anderswo" }), null, "other hosts are not recognised");
        await rejects("host_unsupported", "pr_list with a different host", () => app.invoke("pr_list", { repoId: id, state: "open", remote: "anderswo" }));
        await rejects("not_allowed", "host_connect over http to a foreign machine", () => app.invoke("host_connect", { kind: "gitlab", baseUrl: "http://gitlab.firma.example", token: hostMock.token }));
        await rejects("host_auth_failed", "host_connect with wrong token", () => app.invoke("host_connect", { kind: "github", baseUrl: hostMock.url, token: "ghp_ErfundenUndFalsch0000000000" }));
        equal(await app.invoke("host_accounts"), [], "a rejected token leaves no account");
      } finally {
        hostMock.recover();
        for (const account of await app.invoke("host_accounts").catch(() => [])) await app.invoke("host_disconnect", { accountId: account.id }).catch(() => {});
        for (const name of remotes) await app.invoke("remote_remove", { repoId: id, name }).catch(() => {});
        await takeEvents();
        await app.invoke("repo_forget", { repoId: id });
        await app.invoke("tab_activate", { tabId });
      }
    });

    await section("Hosts over HTTPS: custom certificate, exception per host only", async () => {
      const original = await app.invoke("settings_get");
      const tlsMock = await startHostMock({ tls: true });
      const host = new URL(tlsMock.url).host;
      const connect = async () => {
        try {
          const account = await app.invoke("host_connect", { kind: "gitlab", baseUrl: tlsMock.url, token: tlsMock.token });
          await app.invoke("host_disconnect", { accountId: account.id });
          return "connected";
        } catch (error) {
          return `${error.code}: ${error.message}`;
        }
      };
      try {
        await app.invoke("settings_set", { patch: { proxyUrl: null, proxyByHost: [], sslCaFile: null, sslNoVerifyHosts: [] } });
        const untrusted = await connect();
        truthy(untrusted.startsWith("offline:") && untrusted.includes("certificate"), `without a setting the certificate check fails (was: ${untrusted})`);
        equal(tlsMock.requests.length, 0, "before the check passes the server sees no request (and no token)");
        await app.invoke("settings_set", { patch: { sslCaFile: tlsMock.caFile } });
        equal(await connect(), "connected", "with custom CA bundle");
        await app.invoke("settings_set", { patch: { sslCaFile: null, sslNoVerifyHosts: [host] } });
        equal(await connect(), "connected", "exception for exactly this host");
        await app.invoke("settings_set", { patch: { sslNoVerifyHosts: ["anderer-host.example"] } });
        truthy((await connect()).startsWith("offline:"), "an exception for a DIFFERENT host does not apply here");
      } finally {
        await app.invoke("settings_set", { patch: { autoFetchMinutes: original.autoFetchMinutes, proxyUrl: null, proxyByHost: [], sslCaFile: null, sslNoVerifyHosts: [] } });
        for (const account of await app.invoke("host_accounts").catch(() => [])) await app.invoke("host_disconnect", { accountId: account.id }).catch(() => {});
        await tlsMock.close();
        await takeEvents();
      }
    });

    await section("Proxy password in the keychain, clipboard, notification, core.on with ready", async () => {
      // Proxy password: the address is stored and returned without the password.
      const withProxy = await app.invoke("settings_set", { patch: { proxyUrl: "http://anna:streng-geheim@127.0.0.1:9" } });
      shape("Settings", withProxy, "settings_set (proxy with password)");
      equal(withProxy.proxyUrl, "http://anna@127.0.0.1:9", "the response names no password");
      equal((await app.invoke("settings_get")).proxyUrl, "http://anna@127.0.0.1:9", "neither does settings_get");
      const stored = fs
        .readdirSync(app.dataDir)
        .map((name) => {
          try {
            return fs.readFileSync(path.join(app.dataDir, name)).toString("latin1");
          } catch {
            return "";
          }
        })
        .join("");
      truthy(!stored.includes("streng-geheim"), "the password is in no file of the data directory");
      equal((await app.invoke("settings_set", { patch: { proxyUrl: null } })).proxyUrl, null, "proxy removed again");

      // Clipboard via the plugin (no WebView prompt).
      const text = `Vertragsprüfung ${Date.now()} äöü`;
      equal(await app.invoke("plugin:clipboard-manager|write_text", { text }), null, "clipboard write_text");
      equal(await app.invoke("plugin:clipboard-manager|read_text"), text, "clipboard read_text returns what was written");

      // Notifications: the plugin replaces window.Notification; on Windows permission is granted.
      equal(await app.invoke("plugin:notification|is_permission_granted"), true, "notifications are allowed");
      equal(await app.page.evaluate(() => (typeof window.Notification === "function" ? window.Notification.permission : "missing")), "granted", "window.Notification comes from the plugin");
      equal(await app.invoke("plugin:notification|notify", { options: { title: "forkyard – contract check", body: "Test of the system notification. Can be ignored." } }), null, "notify is accepted");

      // core.on returns an unsubscribe with `ready`; core.notify* and core.clipboard* go through the plugins.
      const viaCore = await app.page.evaluate(async () => {
        const { core } = await import("/src/core/index.ts");
        const seen = [];
        const stop = core.on("app:changed", (payload) => seen.push(payload.what));
        const hasReady = stop.ready instanceof Promise;
        await stop.ready;
        await core.settingsSet({ patch: { zoom: 1 } });
        for (let waited = 0; waited < 3000 && !seen.length; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
        stop();
        const afterStop = seen.length;
        await core.settingsSet({ patch: { zoom: 1 } });
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { hasReady, seen: afterStop, afterStop: seen.length, permission: await core.notifyPermission(), clip: await core.clipboardRead() };
      });
      equal([viaCore.hasReady, viaCore.seen >= 1, viaCore.afterStop === viaCore.seen, viaCore.permission, viaCore.clip], [true, true, true, "granted", text], "core.on with ready, unsubscribe, notifyPermission, clipboardRead");
      await takeEvents();
    });

    await section("repoForget", async () => {
      await takeEvents();
      equal(await app.invoke("repo_forget", { repoId }), null, "repo_forget returns nothing");
      const after = await takeEvents();
      truthy(whatOf(after, "app:changed").includes("repos") && whatOf(after, "app:changed").includes("tabs"), `repo_forget reports app:changed with repos and tabs (was: ${show(whatOf(after, "app:changed"))})`);
      equal(await app.invoke("repo_list"), [], "repo_list is empty");
      truthy(!(await app.invoke("tabs_list")).some((tab) => tab.repoId === repoId), "the repository tab is closed");
      truthy(fs.existsSync(path.join(rich.path, ".git")), "repo_forget deletes nothing on disk");
    });

    await section("Keychain: nothing is left after disconnecting and deleting", async () => {
      equal(keyringEntries(keyringService), [], "no token, key or proxy password of the check is left in the keychain");
    });

    current = "console";
    if (app.consoleErrors.length) fail(`console errors during the check:\n${app.consoleErrors.join("\n")}`);
  } catch (error) {
    failures.push(`aborted: ${error?.stack ?? error}`);
    console.error(error?.stack ?? error);
  } finally {
    await app?.close();
    await hostMock?.close();
    rich.cleanup();
    empty.cleanup();
    plain.cleanup();
    clean.cleanup();
    conflict.cleanup();
  }
  console.log(failures.length ? `\nContract check failed: ${failures.length} mismatches.` : "\nContract check green.");
  process.exit(failures.length ? 1 : 0);
}
