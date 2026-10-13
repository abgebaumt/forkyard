/** Actions on entries of the repository list: favourite, alias, group, colour, new location. */
import { core, type Id, type Repo } from "../../core";
import { forgetRepo, openRepositoryAt } from "../../app/actions/repos";
import { choose, confirm, promptText } from "../../app/dialogs";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { toast } from "../../ui/Feedback";
import { pathKey } from "../CloneDialog/paths";
import { t } from "../../i18n";

/** The eight lane colours as markers, with names for the menu (never colour alone). */
export const REPO_COLORS: { value: number; label: string }[] = [
  { value: 1, label: t("repos.colors.blue") },
  { value: 2, label: t("repos.colors.green") },
  { value: 3, label: t("repos.colors.yellow") },
  { value: 4, label: t("repos.colors.pink") },
  { value: 5, label: t("repos.colors.violet") },
  { value: 6, label: t("repos.colors.turquoise") },
  { value: 7, label: t("repos.colors.orange") },
  { value: 8, label: t("repos.colors.olive") },
];

export const displayName = (repo: Pick<Repo, "alias" | "name">) => repo.alias ?? repo.name;

/** Puts the changed entry into the list immediately; the core's event reconciles the rest. */
function putRepo(repo: Repo) {
  queryClient.setQueryData<Repo[]>(qk.repos, (list) => list?.map((item) => (item.id === repo.id ? repo : item)));
}

type Patch = { alias?: string | null; isFavorite?: boolean; groupName?: string | null; color?: number | null };

async function update(label: string, repoId: Id, patch: Patch) {
  const result = await runAction(label, () => core.repoUpdate({ repoId, ...patch }));
  if (result.ok) putRepo(result.value);
  return result;
}

export const setFavorite = (repo: Repo, isFavorite: boolean) => update(isFavorite ? t("repos.actions.favoriteSet") : t("repos.actions.favoriteRemove"), repo.id, { isFavorite });

export const setColor = (repo: Repo, color: number | null) => update(t("repos.actions.colorChange"), repo.id, { color });

export const clearAlias = (repo: Repo) => update(t("repos.actions.aliasRemove"), repo.id, { alias: null });

export const clearGroup = (repo: Repo) => update(t("repos.actions.groupRemove"), repo.id, { groupName: null });

/** Asks for a display name. The folder keeps its name. */
export async function editAlias(repo: Repo) {
  const alias = await promptText({
    title: repo.alias ? t("repos.actions.aliasChangeTitle", { name: repo.name }) : t("repos.actions.aliasSetTitle", { name: repo.name }),
    label: t("repos.actions.aliasLabel"),
    description: t("repos.actions.aliasDescription"),
    initial: repo.alias ?? repo.name,
    confirmLabel: t("repos.actions.aliasSave"),
    validate: (value) => (value.length > 80 ? t("repos.actions.maxChars", { count: 80 }) : null),
  });
  if (alias === null) return null;
  return update(t("repos.actions.aliasSave"), repo.id, { alias: alias === repo.name ? null : alias });
}

/** Asks for a group; existing groups are shown as help. */
export async function assignGroup(repo: Repo, existing: string[]) {
  const others = existing.filter((name) => name !== repo.groupName);
  const group = await promptText({
    title: t("repos.actions.groupTitle", { name: displayName(repo) }),
    label: t("repos.actions.groupLabel"),
    description: others.length
      ? t("repos.actions.groupExisting", { groups: others.join(", ") })
      : t("repos.actions.groupNone"),
    initial: repo.groupName ?? "",
    confirmLabel: t("repos.actions.groupAssign"),
    validate: (value) => (value.length > 60 ? t("repos.actions.maxChars", { count: 60 }) : null),
  });
  if (group === null) return null;
  return update(t("repos.actions.groupAssign"), repo.id, { groupName: group });
}

// --- Groups as a whole (local workspaces) -------------------------------------------------------

/** Gives all repositories of the group a new group name. An existing name merges the groups. */
export async function renameGroup(group: string, members: Repo[], existing: string[]) {
  const others = existing.filter((name) => name !== group);
  const next = await promptText({
    title: t("repos.actions.renameTitle", { group }),
    label: t("repos.actions.renameLabel"),
    description: others.length
      ? `${t("repos.actions.renameScope", { count: members.length })} ${t("repos.actions.renameMerge", { groups: others.join(", ") })}`
      : t("repos.actions.renameScope", { count: members.length }),
    initial: group,
    confirmLabel: t("repos.actions.rename"),
    validate: (value) => (!value.trim() ? t("repos.actions.renameEmpty") : value.length > 60 ? t("repos.actions.maxChars", { count: 60 }) : null),
  });
  if (next === null || next === group) return null;
  const result = await runAction(t("repos.actions.rename"), () => Promise.all(members.map((repo) => core.repoUpdate({ repoId: repo.id, groupName: next }))), {
    success: t("repos.actions.renamed", { group: next }),
  });
  if (result.ok) for (const repo of result.value) putRepo(repo);
  void queryClient.invalidateQueries({ queryKey: qk.repos });
  return result;
}

/** Dissolves the group: the repositories stay in the list, only the assignment goes away. */
export async function dissolveGroup(group: string, members: Repo[]) {
  const ok = await confirm({
    title: t("repos.actions.dissolveTitle", { group }),
    body: t("repos.actions.dissolveBody", { count: members.length }),
    details: members.map((repo) => displayName(repo)),
    detailsLabel: t("repos.actions.dissolveDetails"),
    confirmLabel: t("repos.actions.dissolve"),
    danger: true,
  });
  if (!ok) return null;
  const result = await runAction(t("repos.actions.dissolve"), () => Promise.all(members.map((repo) => core.repoUpdate({ repoId: repo.id, groupName: null }))), {
    success: t("repos.actions.dissolved", { group }),
  });
  if (result.ok) for (const repo of result.value) putRepo(repo);
  void queryClient.invalidateQueries({ queryKey: qk.repos });
  return result;
}

/**
 * The folder was moved: pick the new location, open it there, take over alias/favourite/group/colour
 * and remove the old entry.
 */
export async function relocateRepo(repo: Repo) {
  const picked = await core.pickFolder({ title: t("repos.actions.relocateTitle", { name: displayName(repo) }) });
  if (!picked) return null;
  const opened = await openRepositoryAt(picked);
  if (!opened.ok) return opened;
  const next = opened.value.repo;
  if (next.id !== repo.id && pathKey(next.path) !== pathKey(repo.path)) {
    await runAction(t("repos.actions.relocateMerge"), async () => {
      const merged = await core.repoUpdate({
        repoId: next.id,
        alias: next.alias ?? repo.alias,
        isFavorite: next.isFavorite || repo.isFavorite,
        groupName: next.groupName ?? repo.groupName,
        color: next.color ?? repo.color,
      });
      await core.repoForget({ repoId: repo.id });
      return merged;
    });
    void queryClient.invalidateQueries({ queryKey: qk.repos });
    void queryClient.invalidateQueries({ queryKey: qk.tabs });
    toast({ tone: "success", title: t("repos.actions.relocated", { name: displayName(repo), path: next.path }) });
  }
  return opened;
}

/** Enter on an entry whose folder is missing: ask what should happen. */
export async function resolveMissing(repo: Repo) {
  const choice = await choose({
    title: t("repos.actions.missingTitle", { name: displayName(repo) }),
    description: t("repos.actions.missingDescription", { path: repo.path }),
    options: [
      { key: "relocate", label: t("repos.menu.relocate"), description: t("repos.actions.relocateHint") },
      { key: "forget", label: t("repos.menu.remove"), description: t("repos.actions.forgetHint") },
    ],
  });
  if (choice === "relocate") return relocateRepo(repo);
  if (choice === "forget") return forgetRepo(repo);
  return null;
}
