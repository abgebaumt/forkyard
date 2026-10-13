/**
 * Save a patch as a file: the operating system's save dialog, then write.
 *
 * Limitation, as long as the core has no command that writes text unchanged to a freely chosen
 * location: writing goes through `fileWrite`, so only INTO the repository, and only patches without
 * Windows line endings (`fileWrite` normalises line endings and would alter such patches).
 * Everything else is rejected with a clear sentence instead of being silently saved wrong.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { core, CoreError, type Id } from "../../core";
import { t } from "../../i18n";
import { relativeInside } from "./model";

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
export async function pickSavePath(input: { title: string; defaultPath: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
  if (import.meta.env.DEV && window.__gcTestSaves?.length) return window.__gcTestSaves.shift() ?? null;
  const filters = input.filters ?? [{ name: t("patches.save.filterName"), extensions: ["patch", "diff"] }];
  const picked = await save({ title: input.title, defaultPath: input.defaultPath, filters });
  return typeof picked === "string" ? picked : null;
}

export type SaveOutcome =
  | { status: "saved"; path: string; relative: string }
  | { status: "cancelled" }
  /** Not possible with today's core; `reason` is a complete sentence. */
  | { status: "refused"; reason: string };

const joinPath = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, "")}${folder.includes("\\") ? "\\" : "/"}${name}`;

/**
 * Asks for the target and writes the patch. Throws `CoreError` if the write itself fails.
 */
export async function savePatchFile(input: { repoId: Id; repoPath: string; text: string; fileName: string; windows: boolean }): Promise<SaveOutcome> {
  if (input.text.includes("\r")) {
    return {
      status: "refused",
      reason: t("patches.save.crlf"),
    };
  }
  const target = await pickSavePath({ title: t("patches.save.title"), defaultPath: joinPath(input.repoPath, input.fileName) });
  if (!target) return { status: "cancelled" };
  const relative = relativeInside(input.repoPath, target, input.windows);
  if (!relative) {
    return {
      status: "refused",
      reason: t("patches.save.outside"),
    };
  }
  await core.fileWrite({ repoId: input.repoId, path: relative, content: input.text, encoding: "utf-8", eol: "lf" });
  // Cross-check: is the very same text really in the file?
  const written = await core.fileRead({ repoId: input.repoId, path: relative, sha: null });
  if (written.text !== input.text) {
    throw new CoreError({ code: "io", message: t("patches.save.mismatch"), gitOutput: null });
  }
  return { status: "saved", path: target, relative };
}
