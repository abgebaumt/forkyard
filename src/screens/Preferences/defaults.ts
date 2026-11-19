/**
 * Settings defaults, for "Changed · Reset": `Settings::default()` of the core, written by
 * `npm run gen:types` (never edit the JSON by hand).
 */
import type { Settings } from "../../core";
import defaults from "../../core/generated/settingsDefaults.json";

// The JSON is the core's own serialisation, so its literal strings are valid `Settings` values.
export const DEFAULT_SETTINGS = defaults as Required<Settings>;

/** Does the field deviate from the default? */
export function isChanged(settings: Settings, field: keyof Settings): boolean {
  return JSON.stringify(settings[field] ?? null) !== JSON.stringify(DEFAULT_SETTINGS[field]);
}

/** Patch that resets exactly this field to the default. */
export function resetPatch(field: keyof Settings): Partial<Settings> {
  return { [field]: DEFAULT_SETTINGS[field] } as Partial<Settings>;
}
