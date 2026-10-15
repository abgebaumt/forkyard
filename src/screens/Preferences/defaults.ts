/**
 * Settings defaults, for "Changed · Reset". Must match `Settings::default()` in
 * crates/core/src/model.rs; the type `Required<Settings>` enforces every field.
 */
import type { Settings } from "../../core";

export const DEFAULT_SETTINGS: Required<Settings> = {
  theme: "dark",
  zoom: 1,
  dateFormat: "relative",
  showInitials: false,
  toolbarLabels: true,
  rememberTabs: true,
  defaultBranchName: "main",
  autoFetchMinutes: 1,
  autoPrune: true,
  initialCommits: 2000,
  lazyLoad: true,
  defaultPullMode: "ff",
  squashOnMerge: false,
  pushAfterCommit: false,
  deleteOrigFiles: true,
  diffMode: "hunks",
  diffWordWrap: false,
  diffIgnoreWhitespace: false,
  editorFontSize: 13,
  editorTabSize: 4,
  externalEditor: null,
  externalTerminal: null,
  externalDiffTool: null,
  externalMergeTool: null,
  notifyOnFetch: false,
  notifyOnError: true,
  checkForUpdates: true,
  sshUseAgent: true,
  proxyUrl: null,
  proxyByHost: [],
  sslCaFile: null,
  sslNoVerifyHosts: [],
};

/** Does the field deviate from the default? */
export function isChanged(settings: Settings, field: keyof Settings): boolean {
  return JSON.stringify(settings[field] ?? null) !== JSON.stringify(DEFAULT_SETTINGS[field]);
}

/** Patch that resets exactly this field to the default. */
export function resetPatch(field: keyof Settings): Partial<Settings> {
  return { [field]: DEFAULT_SETTINGS[field] } as Partial<Settings>;
}
