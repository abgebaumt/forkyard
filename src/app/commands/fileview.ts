/**
 * Commands around a file (file view, history, blame): history and blame
 * of the file currently shown, pick a file to edit, create a new file, delete
 * a file.
 */
import { t } from "../../i18n";
import { core, CoreError } from "../../core";
import { toast } from "../../ui/Feedback";
import { undo } from "../actions/undo";
import { confirm, pickFromList, promptText } from "../dialogs";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { withStatus } from "../statusCache";
import { useAppStore } from "../store";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";

/** Path of the file currently shown in the centre (diff, file, history, blame). */
function centerPath(ctx: CommandContext): string | null {
  const center = ctx.view?.center;
  if (!center) return null;
  return center.kind === "diff" || center.kind === "file" || center.kind === "history" || center.kind === "blame" ? center.path : null;
}

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

/** Validates a new path relative to the repository; reason or null. */
export function newPathProblem(value: string): string | null {
  const path = value.trim().replace(/\\/g, "/");
  if (!path) return t("commands.file.path.empty");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return t("commands.file.path.absolute");
  if (path.split("/").some((part) => part === ".." || part === ".")) return t("commands.file.path.dots");
  if (path.endsWith("/")) return t("commands.file.path.noName");
  if (path.split("/").some((part) => part.toLowerCase() === ".git")) return t("commands.file.path.gitDir");
  if (/[<>:"|?*\u0000-\u001f]/.test(path)) return t("commands.file.path.windowsChars");
  return null;
}

/** Create a new, empty file and open it in the editor. */
export async function createFile(repoId: string, tabId: string, initial = ""): Promise<boolean> {
  const value = await promptText({
    title: t("commands.file.new.dialogTitle"),
    label: t("commands.file.new.label"),
    description: t("commands.file.new.description"),
    initial,
    placeholder: t("commands.file.new.placeholder"),
    mono: true,
    validate: async (raw) => {
      const problem = newPathProblem(raw);
      if (problem) return problem;
      try {
        await core.fileRead({ repoId, path: raw.trim().replace(/\\/g, "/"), sha: null });
        return t("commands.file.new.exists");
      } catch (error) {
        if (error instanceof CoreError && error.code === "not_found") return null;
        return error instanceof CoreError && error.code === "not_allowed" ? error.message : null;
      }
    },
    confirmLabel: t("commands.file.new.confirm"),
  });
  if (!value) return false;
  const path = value.replace(/\\/g, "/");
  const result = await runAction(t("commands.file.new.action"), () => core.fileWrite({ repoId, path, content: "", encoding: "utf-8", eol: "lf" }), {
    success: t("commands.file.new.done", { path }),
  });
  if (!result.ok) return false;
  useAppStore.getState().openFile(tabId, path, null, "edit");
  return true;
}

/**
 * Deletes a file in the working directory – after a prompt. The core backs it up first; the
 * message offers undo. If the file is currently shown in the centre, the view closes.
 */
export async function deleteFile(repoId: string, tabId: string, path: string): Promise<boolean> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ok = await confirm({
    title: t("commands.file.delete.confirmTitle", { name }),
    body: t("commands.file.delete.confirmBody", { path }),
    confirmLabel: t("commands.file.delete.confirm"),
    danger: true,
  });
  if (!ok) return false;
  const result = await runAction(t("commands.file.delete.action"), withStatus(repoId, () => core.fileDelete({ repoId, path })), { busyKey: `${repoId}:file-delete` });
  if (!result.ok) return false;
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  const store = useAppStore.getState();
  const center = store.views[tabId]?.center;
  if (center && (center.kind === "file" || center.kind === "blame") && center.path === path && center.sha === null) store.closeCenter(tabId);
  toast({ tone: "success", title: t("commands.file.delete.done", { name }), action: { label: t("commands.repo.undo.title"), onClick: () => void undo(repoId) } });
  return true;
}

/** Pick a file of the working directory and open it in the editor. */
async function pickFileToEdit(ctx: CommandContext): Promise<void> {
  const repoId = ctx.repoId!;
  const result = await runAction(t("commands.file.edit.readAction"), () => ctx.queryClient.fetchQuery({ queryKey: qk.tree(repoId, null, null), queryFn: () => core.treeList({ repoId, sha: null, filter: null }) }));
  if (!result.ok) return;
  const path = await pickFromList({
    title: t("commands.file.edit.pick"),
    label: t("commands.file.edit.label"),
    items: result.value.map((item) => ({ key: item, label: item })),
    empty: t("commands.file.edit.empty"),
    confirmLabel: t("commands.file.edit.confirm"),
    mono: true,
  });
  if (path) ctx.store.openFile(ctx.tabId!, path, null, "edit");
}

export const commands: AppCommand[] = [
  {
    id: "file.history",
    title: t("commands.file.history.title"),
    group: "Datei",
    shortcut: "Mod+Shift+H",
    keywords: kw("commands.file.history.keywords"),
    when: (ctx) => hasRepo(ctx) && centerPath(ctx) !== null && ctx.view?.center.kind !== "history",
    run: (ctx) => ctx.store.openHistory(ctx.tabId!, centerPath(ctx)!),
  },
  {
    id: "file.blame",
    title: t("commands.file.blame.title"),
    group: "Datei",
    keywords: kw("commands.file.blame.keywords"),
    when: (ctx) => hasRepo(ctx) && centerPath(ctx) !== null && ctx.view?.center.kind !== "blame",
    run: (ctx) => {
      const center = ctx.view!.center;
      const sha = center.kind === "file" || center.kind === "blame" ? center.sha : center.kind === "diff" && center.source.kind === "commit" ? center.source.sha : null;
      ctx.store.openBlame(ctx.tabId!, centerPath(ctx)!, sha);
    },
  },
  {
    id: "file.edit",
    title: t("commands.file.edit.title"),
    group: "Datei",
    keywords: kw("commands.file.edit.keywords"),
    when: hasRepo,
    run: (ctx) => pickFileToEdit(ctx),
  },
  {
    id: "file.new",
    title: t("commands.file.new.title"),
    group: "Datei",
    keywords: kw("commands.file.new.keywords"),
    when: hasRepo,
    run: (ctx) => createFile(ctx.repoId!, ctx.tabId!),
  },
  {
    id: "file.delete",
    title: t("commands.file.delete.title"),
    group: "Datei",
    keywords: kw("commands.file.delete.keywords"),
    when: (ctx) => hasRepo(ctx) && (ctx.view?.center.kind === "file" || ctx.view?.center.kind === "blame") && ctx.view.center.sha === null,
    run: (ctx) => deleteFile(ctx.repoId!, ctx.tabId!, centerPath(ctx)!),
  },
];
