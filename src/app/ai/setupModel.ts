/**
 * Pure model of “Set up AI” (spec 1.3, Teilpaket 1b): what the detection offers, what is preselected
 * (exactly one signed-in command-line tool → one click), when a step may be left and which settings
 * the end writes. Rendered by SetupDialog.tsx.
 */
import type { AiCliFound, AiDetection, AiFeature, AiProviderKind, Settings } from "../../core";
import { isCli, isLocal, usesBaseUrl } from "../../screens/Preferences/ai/model";

export type SetupStep = "search" | "found" | "provider" | "model" | "features" | "done";

export type SetupPick = { kind: "cli"; provider: AiProviderKind } | { kind: "local"; provider: AiProviderKind; models: string[] } | { kind: "key"; provider: AiProviderKind };

export const pickId = (pick: SetupPick): string => `${pick.kind}:${pick.provider}`;

/** Usable at once: a supported version that is signed in. */
export const isUsableCli = (cli: AiCliFound): boolean => cli.supported && cli.login === "logged_in";

export interface SetupOverview {
  /** What can be chosen, in this order: signed-in tools, local services with a model, stored keys. */
  picks: SetupPick[];
  /** Exactly one signed-in tool: chosen already, “Turn on with …” is one click. */
  preselected: SetupPick | null;
  /** Nothing to choose: offer an API key, a local model or the cockpit only. */
  nothingUsable: boolean;
}

export function setupOverview(detection: AiDetection): SetupOverview {
  const tools: SetupPick[] = detection.clis.filter(isUsableCli).map((cli) => ({ kind: "cli", provider: cli.provider }));
  const local: SetupPick[] = detection.local.filter((service) => service.models.length > 0).map((service) => ({ kind: "local", provider: service.provider, models: service.models }));
  const keys: SetupPick[] = detection.keys.map((provider) => ({ kind: "key", provider }));
  const picks = [...tools, ...local, ...keys];
  return { picks, preselected: tools.length === 1 ? (tools[0] ?? null) : null, nothingUsable: picks.length === 0 };
}

export interface SetupDraft {
  provider: AiProviderKind | null;
  /** Own address (compatible service, another port of Ollama / LM Studio); null = default. */
  baseUrl: string | null;
  /** null = the tool's default (command-line tools only). */
  model: string | null;
  /** Models the check or the detection found. */
  models: string[];
  /** The provider answered (check or detection). */
  checked: boolean;
  featuresOff: AiFeature[];
}

export const EMPTY_DRAFT: SetupDraft = { provider: null, baseUrl: null, model: null, models: [], checked: false, featuresOff: [] };

export function draftFromPick(pick: SetupPick): SetupDraft {
  switch (pick.kind) {
    case "cli":
      return { ...EMPTY_DRAFT, provider: pick.provider, checked: true };
    case "local":
      return { ...EMPTY_DRAFT, provider: pick.provider, models: pick.models, model: pick.models[0] ?? null, checked: true };
    case "key":
      return { ...EMPTY_DRAFT, provider: pick.provider };
  }
}

/** A signed-in tool turns AI on at once (model = the tool's default); everything else continues to the model. */
export const primaryAction = (pick: SetupPick | null): "turnOn" | "continue" | null => (pick === null ? null : pick.kind === "cli" ? "turnOn" : "continue");

/** “Continue” only after the provider answered (spec 1.3: „erst nach Erfolg ‚Weiter‘“). */
export const canLeaveProvider = (draft: SetupDraft): boolean => draft.provider !== null && draft.checked;

export const canLeaveModel = (draft: SetupDraft): boolean => draft.provider !== null && (isCli(draft.provider) || Boolean(draft.model?.trim()));

export function settingsPatch(draft: SetupDraft): Partial<Settings> {
  const patch: Partial<Settings> = { aiEnabled: true, aiProvider: draft.provider, aiModel: draft.model?.trim() || null, aiFeaturesOff: [...draft.featuresOff] };
  if (draft.provider && usesBaseUrl(draft.provider)) patch.aiBaseUrl = draft.baseUrl?.trim() || null;
  return patch;
}

/** The last sentence of the setup: to a tool on this computer, staying local, or over the internet. */
export const whereKind = (provider: AiProviderKind): "cli" | "local" | "api" => (isCli(provider) ? "cli" : isLocal(provider) ? "local" : "api");
