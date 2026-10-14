import { describe, expect, it } from "vitest";
import type { CustomCommandDef, CustomCommandEntry, CustomCommandScope } from "../../core";
import { commandsFor, draftErrors, fromDraft, hasErrors, initialValues, inputErrors, mergeImported, newDraft, toDraft, unknownPlaceholders } from "./model";

const def = (patch: Partial<CustomCommandDef> = {}): CustomCommandDef => ({
  id: "build",
  title: "Bauen",
  kind: "shell",
  run: "make ${input:target}",
  cwd: "worktree",
  confirm: false,
  shell: false,
  inputs: [{ id: "target", label: "Ziel", type: "choice", default: null, options: ["all", "test"] }],
  scope: ["repo", "commit"],
  ...patch,
});

const entry = (command: CustomCommandDef, source: "global" | "repo" = "global"): CustomCommandEntry => ({ key: `${source}:${command.id}`, source, command, runnable: true });

describe("custom commands: where they appear", () => {
  it("lists only commands whose scope contains the menu, in the core's order", () => {
    const list = [entry(def()), entry(def({ id: "tag", scope: ["branch"] })), entry(def({ id: "ci", scope: ["commit"] }), "repo")];
    expect(commandsFor(list, "commit").map((item) => item.key)).toEqual(["global:build", "repo:ci"]);
    expect(commandsFor(list, "file")).toEqual([]);
    expect(commandsFor(undefined, "repo")).toEqual([]);
  });
});

describe("custom commands: the run form", () => {
  it("starts with the defaults, the first choice and an unticked checkbox", () => {
    const command = def({
      inputs: [
        { id: "target", label: "Ziel", type: "choice", default: null, options: ["all", "test"] },
        { id: "level", label: "Stufe", type: "choice", default: "test", options: ["all", "test"] },
        { id: "force", label: "Erzwingen", type: "checkbox", default: null, options: [] },
        { id: "dry", label: "Probelauf", type: "checkbox", default: "true", options: [] },
        { id: "message", label: "Nachricht", type: "text", default: "Grüße", options: [] },
        { id: "file", label: "Datei", type: "file", default: null, options: [] },
      ],
    });
    expect(initialValues(command)).toEqual({ target: "all", level: "test", force: "false", dry: "true", message: "Grüße", file: "" });
  });

  it("only accepts offered choices; text may stay empty", () => {
    expect(inputErrors(def(), { target: "all" })).toEqual({});
    expect(Object.keys(inputErrors(def(), { target: "deploy" }))).toEqual(["target"]);
    expect(inputErrors(def({ inputs: [{ id: "m", label: "M", type: "text", default: null, options: [] }] }), { m: "" })).toEqual({});
  });
});

describe("custom commands: the editor", () => {
  it("keeps a definition unchanged through the draft", () => {
    const command = def({
      inputs: [
        { id: "target", label: "Ziel", type: "choice", default: "test", options: ["all", "test"] },
        { id: "force", label: "Erzwingen", type: "checkbox", default: "true", options: ["--force-with-lease"] },
      ],
    });
    expect(fromDraft(toDraft(command))).toEqual(command);
  });

  it("drops the shell switch for other kinds and keeps the scope in a fixed order", () => {
    const saved = fromDraft({ ...toDraft(def()), kind: "git", run: "log -1", shell: true, scope: ["file", "repo"] as CustomCommandScope[] });
    expect(saved.shell).toBe(false);
    expect(saved.scope).toEqual(["repo", "file"]);
  });

  it("names what the core would reject", () => {
    const others = [def({ id: "taken" })];
    const draft = { ...newDraft(others), id: "Taken!", title: " ", run: "echo ${user} ${input:missing}", scope: [] as CustomCommandScope[] };
    const errors = draftErrors(draft, others);
    expect(errors.id).toBeTruthy();
    expect(errors.title).toBeTruthy();
    expect(errors.run).toContain("${user}");
    expect(errors.run).toContain("${input:missing}");
    expect(errors.scope).toBeTruthy();
    expect(draftErrors({ ...draft, id: "taken" }, others).id).toBeTruthy();
    expect(draftErrors(toDraft(def({ kind: "url", run: "ftp://example.com" })), []).run).toBeTruthy();
    expect(draftErrors(toDraft(def({ kind: "git", run: "git log" })), []).run).toBeTruthy();
    expect(hasErrors(draftErrors(toDraft(def()), others))).toBe(false);
  });

  it("checks the inputs", () => {
    const base = toDraft(def());
    const input = (patch: Partial<(typeof base.inputs)[number]>) => ({ id: "a", label: "A", type: "text" as const, default: "", options: "", ...patch });
    const check = (inputs: (typeof base.inputs)[number][]) => draftErrors({ ...base, run: "make", inputs }, []).inputs;
    expect(check([input({ id: "A" })])[0]).toBeTruthy();
    expect(check([input({}), input({})])[1]).toBeTruthy();
    expect(check([input({ label: " " })])[0]).toBeTruthy();
    expect(check([input({ type: "choice" })])[0]).toBeTruthy();
    expect(check([input({ type: "choice", options: "x\ny", default: "z" })])[0]).toBeTruthy();
    expect(check([input({ type: "checkbox", options: "--a\n--b" })])[0]).toBeTruthy();
    expect(check([input({ type: "choice", options: "x\ny", default: "y" })])).toEqual({});
  });

  it("proposes a free ID for a new command", () => {
    expect(newDraft([def({ id: "command-1" })]).id).toBe("command-2");
    expect(newDraft([def({ id: "command-1" }), def({ id: "command-2" })]).id).toBe("command-3");
  });

  it("finds unknown placeholders and inputs without a field", () => {
    expect(unknownPlaceholders("make ${input:target} ${sha} ${branch}", ["target"])).toEqual([]);
    expect(unknownPlaceholders("make ${input:other} ${sha} ${nope}", ["target"])).toEqual(["${input:other}", "${nope}"]);
  });
});

describe("custom commands: import", () => {
  it("replaces commands with the same ID and appends new ones", () => {
    const merged = mergeImported([def({ id: "a", title: "Alt" }), def({ id: "b" })], [def({ id: "a", title: "Neu" }), def({ id: "c" })]);
    expect(merged.commands.map((command) => `${command.id}:${command.title}`)).toEqual(["a:Neu", "b:Bauen", "c:Bauen"]);
    expect(merged.replaced).toEqual(["a"]);
    expect(merged.added).toEqual(["c"]);
  });
});
