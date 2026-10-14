/**
 * Settings → "Custom commands": the user's own commands (global, the same in every profile) with
 * editor, import and export – and, with a repository tab active, the commands of its
 * `.forkyard/commands.json` with their approval. Repository commands only run once exactly this
 * version of the file is approved; every change needs a new approval.
 */
import type { ReactNode } from "react";
import { core, type CustomCommandChange, type CustomCommandDef, type CustomCommandList, type Id } from "../../core";
import { confirm } from "../../app/dialogs";
import { useCustomCommandList } from "../../app/queries";
import { runAction } from "../../app/run";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/Feedback";
import { t } from "../../i18n";
import { pickSavePath } from "../Patches/save";
import { Badge, LoadError, Mono, SectionHeader, SettingsCard, SettingsSkeleton } from "../Preferences/parts";
import { editCommand } from "./Editor";
import { mergeImported } from "./model";

function save(commands: CustomCommandDef[], success: string) {
  return runAction(t("customCommands.settings.saveLabel"), () => core.customCommandsSave({ commands }), { success });
}

function CommandRow({ command, actions }: { command: CustomCommandDef; actions?: ReactNode }) {
  return (
    <div data-custom-command={command.id} className="flex items-start gap-3 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-text">{command.title}</span>
          <Badge>{t(`customCommands.kinds.${command.kind}`)}</Badge>
          {command.confirm ? <Badge tone="accent">{t("customCommands.settings.confirmBadge")}</Badge> : null}
        </div>
        <Mono className="mt-1">{command.run}</Mono>
        <p className="mt-0.5 text-sm text-text-muted">{command.scope.map((scope) => t(`customCommands.scopes.${scope}`)).join(" · ")}</p>
      </div>
      {actions ? <div className="flex shrink-0 gap-1">{actions}</div> : null}
    </div>
  );
}

function ChangeList({ changes }: { changes: CustomCommandChange[] }) {
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {changes.map((change) => (
        <li key={`${change.change}:${change.id}`} className="text-sm">
          <p className="font-medium text-text">{t(`customCommands.repo.change.${change.change}`, { title: change.title })}</p>
          {change.before ? <Mono className="text-text-muted">{`− ${change.before}`}</Mono> : null}
          {change.after ? <Mono>{`+ ${change.after}`}</Mono> : null}
        </li>
      ))}
    </ul>
  );
}

function RepoCommandsCard({ repoId, list }: { repoId: Id; list: CustomCommandList }) {
  const info = list.repo;
  if (!info) return null;
  const commands = list.commands.filter((entry) => entry.source === "repo").map((entry) => entry.command);
  const approve = (hash: string | null, success: string) => runAction(t("customCommands.repo.trustLabel"), () => core.customCommandsTrust({ repoId, hash }), { success });
  return (
    <SettingsCard title={t("customCommands.repo.card", { path: info.path })}>
      {info.state === "missing" ? (
        <p className="py-3 text-base text-text-muted">{t("customCommands.repo.missing", { path: info.path })}</p>
      ) : (
        <div className="py-3" data-repo-commands={info.state}>
          {info.state === "trusted" ? (
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-base text-text-muted">{t("customCommands.repo.trustedBody")}</p>
              <Button size="sm" onClick={() => void approve(null, t("customCommands.repo.revoked"))}>
                {t("customCommands.repo.revoke")}
              </Button>
            </div>
          ) : (
            <Banner
              tone="warning"
              title={info.state === "changed" ? t("customCommands.repo.changedTitle") : t("customCommands.repo.untrustedTitle")}
              actions={
                info.hash ? (
                  <Button size="sm" variant="primary" onClick={() => void approve(info.hash, t("customCommands.repo.trusted"))}>
                    {t("customCommands.repo.allow")}
                  </Button>
                ) : undefined
              }
            >
              {info.state === "changed" ? t("customCommands.repo.changedBody") : t("customCommands.repo.untrustedBody")}
            </Banner>
          )}
          {info.changes.length > 0 ? <ChangeList changes={info.changes} /> : null}
          {info.problems.length > 0 ? (
            <ul className="mt-3 list-disc pl-5 text-sm text-text-muted">
              {info.problems.map((problem) => (
                <li key={problem} className="selectable">
                  {problem}
                </li>
              ))}
            </ul>
          ) : null}
          {commands.length > 0 ? (
            <div className="mt-2">
              {commands.map((command) => (
                <CommandRow key={command.id} command={command} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </SettingsCard>
  );
}

export function CustomCommandsSection({ repoId }: { repoId: Id | null }) {
  const list = useCustomCommandList(repoId);
  if (list.isPending) return <SettingsSkeleton rows={3} />;
  if (list.isError) return <LoadError title={t("customCommands.settings.loadError")} error={list.error} onRetry={() => void list.refetch()} />;
  const own = list.data.commands.filter((entry) => entry.source === "global").map((entry) => entry.command);

  const create = async () => {
    const created = await editCommand(null, own);
    if (created) await save([...own, created], t("customCommands.settings.saved", { title: created.title }));
  };
  const edit = async (command: CustomCommandDef) => {
    const changed = await editCommand(command, own.filter((other) => other.id !== command.id));
    if (changed) await save(own.map((other) => (other.id === command.id ? changed : other)), t("customCommands.settings.saved", { title: changed.title }));
  };
  const remove = async (command: CustomCommandDef) => {
    const ok = await confirm({
      title: t("customCommands.settings.deleteTitle", { title: command.title }),
      body: t("customCommands.settings.deleteBody"),
      confirmLabel: t("customCommands.settings.deleteLabel"),
      danger: true,
    });
    if (ok) await save(own.filter((other) => other.id !== command.id), t("customCommands.settings.deleted", { title: command.title }));
  };
  const importFile = async () => {
    const path = await core.pickFile({ title: t("customCommands.settings.importTitle") });
    if (!path) return;
    const read = await runAction(t("customCommands.settings.importLabel"), () => core.customCommandsImport({ path }));
    if (!read.ok) return;
    const merged = mergeImported(own, read.value);
    await save(merged.commands, t("customCommands.settings.imported", { added: merged.added.length, replaced: merged.replaced.length }));
  };
  const exportFile = async () => {
    const path = await pickSavePath({
      title: t("customCommands.settings.exportTitle"),
      defaultPath: "forkyard-commands.json",
      filters: [{ name: t("customCommands.settings.jsonFilter"), extensions: ["json"] }],
    });
    if (!path) return;
    await runAction(t("customCommands.settings.exportLabel"), () => core.customCommandsExport({ path }), { success: t("customCommands.settings.exported", { path }) });
  };

  return (
    <section data-section="custom-commands">
      <SectionHeader
        title={t("customCommands.settings.title")}
        actions={
          <>
            <Button onClick={() => void importFile()}>{t("customCommands.settings.import")}</Button>
            <Button disabled={own.length === 0} onClick={() => void exportFile()}>
              {t("customCommands.settings.export")}
            </Button>
            <Button variant="primary" onClick={() => void create()}>
              {t("customCommands.settings.new")}
            </Button>
          </>
        }
      >
        {t("customCommands.settings.intro")}
      </SectionHeader>
      <SettingsCard title={t("customCommands.settings.card")}>
        {own.length === 0 ? (
          <p className="py-3 text-base text-text-muted">{t("customCommands.settings.empty")}</p>
        ) : (
          own.map((command) => (
            <CommandRow
              key={command.id}
              command={command}
              actions={
                <>
                  <Button size="sm" onClick={() => void edit(command)}>
                    {t("customCommands.settings.edit")}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void remove(command)}>
                    {t("customCommands.settings.delete")}
                  </Button>
                </>
              }
            />
          ))
        )}
      </SettingsCard>
      {repoId ? <RepoCommandsCard repoId={repoId} list={list.data} /> : null}
    </section>
  );
}
