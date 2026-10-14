/**
 * Custom commands in the UI: which ones belong in a menu, start values and checks of the run form,
 * and the editor's draft. The core checks every definition again (when saving and before every
 * run) and builds every command line – the UI never does.
 */
import type { CustomCommandCwd, CustomCommandDef, CustomCommandEntry, CustomCommandKind, CustomCommandScope, CustomInputType } from "../../core";
import { t } from "../../i18n";

export const SCOPES: CustomCommandScope[] = ["repo", "commit", "branch", "file", "submodule"];
export const KINDS: CustomCommandKind[] = ["shell", "git", "url"];
export const INPUT_TYPES: CustomInputType[] = ["text", "choice", "checkbox", "file"];

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INPUT_ID = /^[a-z][a-z0-9_]{0,31}$/;
const PLACEHOLDER = /\$\{([^}]*)\}/g;
const KNOWN = new Set(["repo", "sha", "branch", "file", "remote"]);

/** Values of the run form by input ID (checkbox "true"/"false"). */
export type InputValues = Record<string, string>;

/** Commands for a menu or the palette: those whose scope contains `scope`, in the core's order (global first). */
export function commandsFor(list: CustomCommandEntry[] | undefined, scope: CustomCommandScope): CustomCommandEntry[] {
  return (list ?? []).filter((entry) => entry.command.scope.includes(scope));
}

export function initialValues(command: CustomCommandDef): InputValues {
  const values: InputValues = {};
  for (const input of command.inputs) {
    if (input.type === "checkbox") values[input.id] = input.default === "true" ? "true" : "false";
    else if (input.type === "choice") values[input.id] = input.default && input.options.includes(input.default) ? input.default : (input.options[0] ?? "");
    else values[input.id] = input.default ?? "";
  }
  return values;
}

/** Problems of the run form: input ID → sentence. Text and file fields may stay empty. */
export function inputErrors(command: CustomCommandDef, values: InputValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const input of command.inputs) {
    const value = values[input.id] ?? "";
    if (input.type === "choice" && !input.options.includes(value)) errors[input.id] = t("customCommands.inputs.pickOne");
    else if (value.includes("\0")) errors[input.id] = t("customCommands.inputs.invalid");
  }
  return errors;
}

/** Placeholders the core would reject: unknown names and `${input:…}` without a field. */
export function unknownPlaceholders(run: string, inputIds: string[]): string[] {
  const unknown: string[] = [];
  for (const match of run.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? "";
    const ok = name.startsWith("input:") ? inputIds.includes(name.slice("input:".length)) : KNOWN.has(name);
    if (!ok && !unknown.includes(match[0])) unknown.push(match[0]);
  }
  return unknown;
}

export interface DraftInput {
  id: string;
  label: string;
  type: CustomInputType;
  default: string;
  /** One option per line. */
  options: string;
}

export interface Draft {
  id: string;
  title: string;
  kind: CustomCommandKind;
  run: string;
  cwd: CustomCommandCwd;
  confirm: boolean;
  shell: boolean;
  scope: CustomCommandScope[];
  inputs: DraftInput[];
}

export interface DraftErrors {
  id?: string;
  title?: string;
  run?: string;
  scope?: string;
  /** Index of the input → sentence. */
  inputs: Record<number, string>;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function newDraft(existing: CustomCommandDef[]): Draft {
  let n = existing.length + 1;
  while (existing.some((command) => command.id === `command-${n}`)) n += 1;
  return { id: `command-${n}`, title: "", kind: "shell", run: "", cwd: "worktree", confirm: false, shell: false, scope: ["repo"], inputs: [] };
}

export function toDraft(command: CustomCommandDef): Draft {
  return {
    id: command.id,
    title: command.title,
    kind: command.kind,
    run: command.run,
    cwd: command.cwd,
    confirm: command.confirm,
    shell: command.shell,
    scope: [...command.scope],
    inputs: command.inputs.map((input) => ({ id: input.id, label: input.label, type: input.type, default: input.default ?? "", options: input.options.join("\n") })),
  };
}

export function fromDraft(draft: Draft): CustomCommandDef {
  return {
    id: draft.id.trim(),
    title: draft.title.trim(),
    kind: draft.kind,
    run: draft.run.trim(),
    cwd: draft.cwd,
    confirm: draft.confirm,
    shell: draft.kind === "shell" && draft.shell,
    scope: SCOPES.filter((scope) => draft.scope.includes(scope)),
    inputs: draft.inputs.map((input) => ({
      id: input.id.trim(),
      label: input.label.trim(),
      type: input.type,
      default: input.type === "checkbox" ? (input.default === "true" ? "true" : null) : input.default.trim() === "" ? null : input.default,
      options: input.type === "choice" || input.type === "checkbox" ? lines(input.options) : [],
    })),
  };
}

/** What the core would reject, for immediate feedback in the editor. `others`: the other commands (IDs must be unique). */
export function draftErrors(draft: Draft, others: CustomCommandDef[]): DraftErrors {
  const errors: DraftErrors = { inputs: {} };
  const id = draft.id.trim();
  if (!ID.test(id)) errors.id = t("customCommands.editor.errors.id");
  else if (others.some((command) => command.id === id)) errors.id = t("customCommands.editor.errors.idTaken");
  if (!draft.title.trim()) errors.title = t("customCommands.editor.errors.title");
  const run = draft.run.trim();
  const inputIds = draft.inputs.map((input) => input.id.trim());
  if (!run) errors.run = t("customCommands.editor.errors.run");
  else if (draft.kind === "url" && !/^https?:\/\//i.test(run)) errors.run = t("customCommands.editor.errors.url");
  else if (draft.kind === "git" && /^git(\s|$)/.test(run)) errors.run = t("customCommands.editor.errors.gitPrefix");
  else {
    const unknown = unknownPlaceholders(run, inputIds);
    if (unknown.length > 0) errors.run = t("customCommands.editor.errors.placeholder", { names: unknown.join(", ") });
  }
  if (draft.scope.length === 0) errors.scope = t("customCommands.editor.errors.scope");
  draft.inputs.forEach((input, index) => {
    const inputId = input.id.trim();
    const options = lines(input.options);
    const fallback = input.default.trim();
    if (!INPUT_ID.test(inputId)) errors.inputs[index] = t("customCommands.editor.errors.inputId");
    else if (inputIds.indexOf(inputId) !== index) errors.inputs[index] = t("customCommands.editor.errors.inputIdTaken");
    else if (!input.label.trim()) errors.inputs[index] = t("customCommands.editor.errors.inputLabel");
    else if (input.type === "choice" && options.length === 0) errors.inputs[index] = t("customCommands.editor.errors.options");
    else if (input.type === "choice" && fallback && !options.includes(fallback)) errors.inputs[index] = t("customCommands.editor.errors.defaultOption");
    else if (input.type === "checkbox" && options.length > 1) errors.inputs[index] = t("customCommands.editor.errors.checkboxOptions");
  });
  return errors;
}

export const hasErrors = (errors: DraftErrors): boolean => Boolean(errors.id || errors.title || errors.run || errors.scope || Object.keys(errors.inputs).length > 0);

/** Import: an imported command replaces the one with the same ID, the others are appended. */
export function mergeImported(current: CustomCommandDef[], imported: CustomCommandDef[]): { commands: CustomCommandDef[]; replaced: string[]; added: string[] } {
  const replaced = imported.filter((command) => current.some((existing) => existing.id === command.id)).map((command) => command.id);
  const added = imported.filter((command) => !current.some((existing) => existing.id === command.id));
  const commands = [...current.map((existing) => imported.find((command) => command.id === existing.id) ?? existing), ...added];
  return { commands, replaced, added: added.map((command) => command.id) };
}
