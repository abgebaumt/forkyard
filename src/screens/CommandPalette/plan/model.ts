/**
 * "Git in plain language" in the command palette (spec Paket 5) – the pure part: when the ask row
 * appears, what the keys do in the plan preview, why Enter may not run, the words and tones of
 * classes, checks and outcomes, the step editor's drafts and the texts around a run. The palette
 * (`index.tsx`) and `usePlanSession.ts` render it and call the core.
 */
import type { PlanArgValue, PlanCheck, PlanPreview, PlanRunResult, PlanStep, PlanStepOutcome, PlanStepView } from "../../../core";
import { errorView } from "../../../app/ai/requestState";
import { describeError, toCoreError } from "../../../app/errors";
import { t } from "../../../i18n";

export const ASK_PREFIX = "?";
export const MAX_REQUEST_CHARS = 500;
/** Part of the core's reason for plans with more than 10 steps (`ai::plan_check::PLAN_TOO_LONG`). */
export const PLAN_TOO_LONG = "plan too long";

export type Tone = "muted" | "accent" | "success" | "warning" | "danger";
export type Draft = Record<string, string | boolean>;

export type PlanPhase =
  | { kind: "idle" }
  | { kind: "loading"; text: string; jobId: string; startedAt: number }
  | { kind: "preview"; text: string; preview: PlanPreview; selected: number; confirmed: number[]; busy: boolean }
  | { kind: "editing"; text: string; preview: PlanPreview; selected: number; confirmed: number[]; draft: Draft }
  | { kind: "running"; text: string; preview: PlanPreview; confirmed: number[]; jobId: string; startedAt: number }
  | { kind: "result"; text: string; preview: PlanPreview; confirmed: number[]; result: PlanRunResult }
  | { kind: "failed"; text: string; error: unknown };

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type PlanKeyAction =
  | { kind: "none" }
  | { kind: "select"; index: number }
  | { kind: "confirm"; index: number }
  | { kind: "edit"; index: number }
  | { kind: "remove"; index: number }
  | { kind: "run" }
  | { kind: "close" }
  | { kind: "notice"; text: string };

export type EscapeAction = "cancelRequest" | "cancelRun" | "endEdit" | "close" | "back" | "none";

export const ARG_LABELS: Record<string, string> = {
  name: t("palette.plan.args.name"),
  start: t("palette.plan.args.start"),
  checkout: t("palette.plan.args.checkout"),
  target: t("palette.plan.args.target"),
  newName: t("palette.plan.args.newName"),
  force: t("palette.plan.args.force"),
  resetMode: t("palette.plan.args.resetMode"),
  onto: t("palette.plan.args.onto"),
  branch: t("palette.plan.args.branch"),
  commits: t("palette.plan.args.commits"),
  commit: t("palette.plan.args.commit"),
  source: t("palette.plan.args.source"),
  mergeMode: t("palette.plan.args.mergeMode"),
  message: t("palette.plan.args.message"),
  includeUntracked: t("palette.plan.args.includeUntracked"),
  paths: t("palette.plan.args.paths"),
  summary: t("palette.plan.args.summary"),
  description: t("palette.plan.args.description"),
  remote: t("palette.plan.args.remote"),
  prune: t("palette.plan.args.prune"),
  pullMode: t("palette.plan.args.pullMode"),
};

export const MODE_WORDS: Record<string, string> = {
  soft: t("palette.plan.mode.soft"),
  mixed: t("palette.plan.mode.mixed"),
  hard: t("palette.plan.mode.hard"),
  default: t("palette.plan.mode.default"),
  ff_only: t("palette.plan.mode.ff_only"),
  no_ff: t("palette.plan.mode.no_ff"),
  squash: t("palette.plan.mode.squash"),
  ff: t("palette.plan.mode.ff"),
  rebase: t("palette.plan.mode.rebase"),
};

/** `?text` → `text` while asking is possible; `null` = not in ask mode. */
export function askQuery(raw: string, enabled: boolean): string | null {
  if (!enabled || !raw.startsWith(ASK_PREFIX)) return null;
  return raw.slice(ASK_PREFIX.length).trim();
}

/** The last row "Ask in plain language: “…”" without a prefix: only with text and no match. */
export function offerAskRow(enabled: boolean, scope: string, text: string, matches: number): boolean {
  return enabled && scope === "all" && text.trim().length > 0 && matches === 0;
}

export function runBlocker(preview: PlanPreview, confirmed: readonly number[]): string | null {
  if (preview.blocked) return t("palette.plan.blocked");
  if (!preview.steps.length) return t("palette.plan.nothingToRun");
  const stuck = preview.steps.findIndex((step) => step.check.status === "invalid" || step.check.status === "conflicts");
  if (stuck >= 0) return t("palette.plan.blockedStep", { n: stuck + 1 });
  const open = preview.steps.findIndex((step, index) => step.class === "outward" && !confirmed.includes(index));
  if (open >= 0) return t("palette.plan.confirmFirst", { n: open + 1 });
  return null;
}

/** Keys while the focus is in the palette input (Esc and Tab are handled elsewhere). */
export function planKey(phase: PlanPhase, input: KeyInput): PlanKeyAction {
  if (phase.kind === "result") return input.key === "Enter" ? { kind: "close" } : { kind: "none" };
  if (phase.kind !== "preview" || phase.busy) return { kind: "none" };
  const plain = !input.ctrlKey && !input.metaKey && !input.altKey;
  const count = phase.preview.steps.length;
  const current = phase.preview.steps[phase.selected];
  switch (input.key) {
    case "ArrowDown":
      return count ? { kind: "select", index: (phase.selected + 1) % count } : { kind: "none" };
    case "ArrowUp":
      return count ? { kind: "select", index: (phase.selected - 1 + count) % count } : { kind: "none" };
    case "Enter": {
      if (!plain) return { kind: "none" };
      const reason = runBlocker(phase.preview, phase.confirmed);
      return reason ? { kind: "notice", text: reason } : { kind: "run" };
    }
    case "Delete":
      return plain && current ? { kind: "remove", index: phase.selected } : { kind: "none" };
    case " ":
      return plain && current?.class === "outward" ? { kind: "confirm", index: phase.selected } : { kind: "none" };
    case "e":
    case "E":
      if (!plain || !current) return { kind: "none" };
      return current.fields.length ? { kind: "edit", index: phase.selected } : { kind: "notice", text: t("palette.plan.noArgs") };
    default:
      return { kind: "none" };
  }
}

/** Esc: cancel what runs, leave the editor, or go back to the input – the text stays. */
export function escapeAction(phase: PlanPhase): EscapeAction {
  switch (phase.kind) {
    case "idle":
      return "none";
    case "loading":
      return "cancelRequest";
    case "running":
      return "cancelRun";
    case "editing":
      return "endEdit";
    case "result":
      return "close";
    case "preview":
    case "failed":
      return "back";
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const shown = (value: string) => (FULL_SHA.test(value) ? value.slice(0, 7) : value);

function argText(step: PlanStep, name: string): string {
  const value: PlanArgValue | undefined = step.args[name];
  if (Array.isArray(value)) return value.map(shown).join(", ");
  return typeof value === "string" ? shown(value) : "";
}

const modeWord = (value: string) => MODE_WORDS[value] ?? value;

export function stepTitle(step: PlanStep): string {
  const a = (name: string) => argText(step, name);
  const flag = (name: string) => step.args[name] === true;
  switch (step.command) {
    case "branchCreate":
      return flag("checkout")
        ? t("palette.plan.step.branchCreateCheckout", { name: a("name"), start: a("start") || "HEAD" })
        : t("palette.plan.step.branchCreate", { name: a("name"), start: a("start") || "HEAD" });
    case "branchCheckout":
      return t("palette.plan.step.branchCheckout", { target: a("target") });
    case "branchRename":
      return t("palette.plan.step.branchRename", { name: a("name"), newName: a("newName") });
    case "branchDelete":
      return flag("force") ? t("palette.plan.step.branchDeleteForce", { name: a("name") }) : t("palette.plan.step.branchDelete", { name: a("name") });
    case "resetBranch":
      return t("palette.plan.step.resetBranch", { target: a("target"), mode: modeWord(a("resetMode")) });
    case "rebaseStart":
      return a("branch") ? t("palette.plan.step.rebaseStartBranch", { branch: a("branch"), onto: a("onto") }) : t("palette.plan.step.rebaseStart", { onto: a("onto") });
    case "cherryPick":
      return t("palette.plan.step.cherryPick", { commits: a("commits") });
    case "revertCommit":
      return t("palette.plan.step.revertCommit", { commit: a("commit") });
    case "mergeStart":
      return t("palette.plan.step.mergeStart", { source: a("source"), mode: modeWord(a("mergeMode")) });
    case "stashCreate":
      return a("message") ? t("palette.plan.step.stashCreateMessage", { message: a("message") }) : t("palette.plan.step.stashCreate");
    case "tagCreate":
      return t("palette.plan.step.tagCreate", { name: a("name"), commit: a("commit") || "HEAD" });
    case "commitReword":
      return t("palette.plan.step.commitReword", { commit: a("commit") || "HEAD", summary: a("summary") });
    case "fetch":
      return a("remote") ? t("palette.plan.step.fetchRemote", { remote: a("remote") }) : t("palette.plan.step.fetch");
    case "pull":
      return a("pullMode") ? t("palette.plan.step.pullMode", { mode: modeWord(a("pullMode")) }) : t("palette.plan.step.pull");
    case "push": {
      const values = { branch: a("branch") || t("palette.plan.currentBranch"), remote: a("remote") || t("palette.plan.upstream") };
      return flag("force") ? t("palette.plan.step.pushForce", values) : t("palette.plan.step.push", values);
    }
    case "branchDeleteRemote":
      return t("palette.plan.step.branchDeleteRemote", { name: a("name"), remote: a("remote") });
    case "tagPush":
      return t("palette.plan.step.tagPush", { name: a("name"), remote: a("remote") });
  }
}

export function classView(step: PlanStepView): { word: string; tone: Tone } {
  if (step.class === "outward") return { word: t("palette.plan.class.outward"), tone: "danger" };
  if (step.destructive) return { word: t("palette.plan.class.destructive"), tone: "danger" };
  return { word: t("palette.plan.class.local"), tone: "muted" };
}

/** `not_needed` has no word: the step cannot stop on conflicts. */
export function checkView(check: PlanCheck): { word: string; tone: Tone; detail: string | null } {
  switch (check.status) {
    case "clean":
      return { word: t("palette.plan.check.clean"), tone: "success", detail: null };
    case "not_needed":
      return { word: "", tone: "muted", detail: null };
    case "conflicts":
      return { word: t("palette.plan.check.conflicts"), tone: "danger", detail: check.files.join(", ") };
    case "unknown":
      return { word: t("palette.plan.check.unknown"), tone: "warning", detail: check.reason };
    case "invalid":
      return { word: t("palette.plan.check.invalid"), tone: "danger", detail: check.reason };
  }
}

export function outcomeView(outcome: PlanStepOutcome): { word: string; tone: Tone; detail: string | null } {
  switch (outcome.status) {
    case "done":
      return { word: t("palette.plan.outcome.done"), tone: "success", detail: null };
    case "failed":
      return { word: t("palette.plan.outcome.failed"), tone: "danger", detail: outcome.error ? describeError(outcome.error).text : null };
    case "not_run":
      return { word: t("palette.plan.outcome.notRun"), tone: "muted", detail: null };
  }
}

/** Only what the core takes back (`aiPlanCheck`, `aiPlanRun`). */
export const toStep = ({ command, args, why }: PlanStep): PlanStep => ({ command, args, why });

export function withoutStep(preview: PlanPreview, index: number): PlanStep[] {
  return preview.steps.filter((_, at) => at !== index).map(toStep);
}

/** Confirmations follow their steps when one is removed. */
export function shiftConfirmed(confirmed: readonly number[], removed: number): number[] {
  return confirmed.filter((index) => index !== removed).map((index) => (index > removed ? index - 1 : index));
}

export function draftOf(step: PlanStepView): Draft {
  const draft: Draft = {};
  for (const field of step.fields) {
    const value = step.args[field.name] ?? null;
    if (field.kind === "boolean") draft[field.name] = value === true;
    else if (field.kind === "list") draft[field.name] = Array.isArray(value) ? value.join(", ") : "";
    else draft[field.name] = typeof value === "string" ? value : "";
  }
  return draft;
}

/** Lists split at commas only (paths may contain spaces); empty optional fields become `null`. */
export function applyDraft(step: PlanStepView, draft: Draft): PlanStep {
  const args: Record<string, PlanArgValue> = {};
  for (const field of step.fields) {
    const value = draft[field.name];
    const text = typeof value === "string" ? value.trim() : "";
    switch (field.kind) {
      case "boolean":
        args[field.name] = value === true;
        break;
      case "list":
        args[field.name] = String(value ?? "").split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
        break;
      case "text":
      case "choice":
        args[field.name] = text;
        break;
      case "optional_text":
      case "optional_choice":
        args[field.name] = text === "" ? null : text;
        break;
    }
  }
  return { command: step.command, args, why: step.why };
}

export function planErrorText(error: unknown): string {
  const coreError = toCoreError(error);
  if (coreError.code === "ai_invalid_answer" && coreError.message.includes(PLAN_TOO_LONG)) return t("palette.plan.tooLong");
  if (coreError.code === "stale_state") return t("palette.plan.expired");
  const shownError = errorView(coreError);
  return shownError.kind === "cancelled" ? "" : shownError.text;
}

/** The footer of the palette in plan mode: only keys that work right now. */
export function footerKeys(phase: PlanPhase): [string, string][] {
  switch (phase.kind) {
    case "idle":
      return [];
    case "loading":
    case "running":
      return [["Esc", t("palette.plan.footer.cancel")]];
    case "editing":
      return [
        ["Enter", t("palette.plan.footer.apply")],
        ["Esc", t("palette.plan.footer.cancelEdit")],
      ];
    case "result":
      return [["Esc", t("palette.plan.footer.close")]];
    case "failed":
      return [["Esc", t("palette.plan.footer.back")]];
    case "preview": {
      const keys: [string, string][] = [
        ["↑↓", t("palette.plan.footer.select")],
        ["Enter", t("palette.plan.footer.run")],
        ["E", t("palette.plan.footer.edit")],
        [t("palette.plan.keys.delete"), t("palette.plan.footer.remove")],
      ];
      if (phase.preview.steps[phase.selected]?.class === "outward") keys.push([t("palette.plan.keys.space"), t("palette.plan.footer.confirm")]);
      keys.push(["Esc", t("palette.plan.footer.back")]);
      return keys;
    }
  }
}
