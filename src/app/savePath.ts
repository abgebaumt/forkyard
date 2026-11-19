import { save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";

/**
 * For automated tests: the save dialog cannot be remote-controlled. If a path is set here,
 * `pickSavePath` takes it instead of opening the dialog (null = cancelled) – like `__gcTestPicks`.
 */
declare global {
  interface Window {
    __gcTestSaves?: (string | null)[];
  }
}

/** The operating system's save dialog; `filters` defaults to patch files. Also used for crash reports. */
export async function pickSavePath(input: {
  title: string;
  defaultPath: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (import.meta.env.DEV && window.__gcTestSaves?.length) return window.__gcTestSaves.shift() ?? null;
  const filters = input.filters ?? [{ name: t("patches.save.filterName"), extensions: ["patch", "diff"] }];
  const picked = await save({ title: input.title, defaultPath: input.defaultPath, filters });
  return typeof picked === "string" ? picked : null;
}
