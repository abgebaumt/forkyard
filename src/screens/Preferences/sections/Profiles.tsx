/**
 * Profile and identity: edit the active profile (takes effect immediately), create, switch and
 * delete further profiles.
 */
import { useState } from "react";
import { Check, Plus, Trash2, UserRound } from "lucide-react";
import { core, type Profile } from "../../../core";
import { refreshAfterProfileChange, switchProfile } from "../../../app/actions/profiles";
import { confirm } from "../../../app/dialogs";
import { qk, queryClient, useProfiles } from "../../../app/queries";
import { runAction } from "../../../app/run";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Banner, toast } from "../../../ui/Feedback";
import { TextField } from "../../../ui/Field";
import { Avatar } from "../../../ui/Git";
import { Switch } from "../../../ui/Switch";
import { Tip } from "../../../ui/Tooltip";
import { cn } from "../../../ui/cn";
import { Badge, CommitText, GroupTitle, LoadError, SectionHeader, SettingRow, SettingsSkeleton } from "../parts";
import { checkEmail, enqueue, fieldError } from "../settings";
import { t } from "../../../i18n";

/**
 * Changes single fields of a profile. The core always takes the whole profile; the calls therefore
 * run one after another, and each reads the state the previous one left behind – otherwise a quick
 * second change (name, then e-mail right away) would overwrite the first with the old value.
 */
export function saveProfile(id: string, patch: Partial<Pick<Profile, "name" | "authorName" | "authorEmail" | "syncGitconfig" | "color">>) {
  return enqueue(async () => {
    // A query already in flight read the state before this change: it no longer counts.
    await queryClient.cancelQueries({ queryKey: qk.profiles });
    const current = queryClient.getQueryData<Profile[]>(qk.profiles)?.find((profile) => profile.id === id);
    if (!current) return null;
    const next = { ...current, ...patch };
    const result = await runAction(
      t("preferences.profiles.save"),
      () => core.profileSave({ id, name: next.name, authorName: next.authorName, authorEmail: next.authorEmail, syncGitconfig: next.syncGitconfig, color: next.color ?? null }),
      { quiet: ["invalid_name", "name_exists", "not_allowed"] },
    );
    if (result.ok) {
      queryClient.setQueryData(qk.profiles, result.value);
      refreshAfterProfileChange(false);
    }
    return result;
  });
}

const saveField = async (id: string, patch: Parameters<typeof saveProfile>[1]) => {
  const result = await saveProfile(id, patch);
  return result ? fieldError(result) : t("preferences.profiles.gone");
};

export function ProfilesSection({ create = false }: { create?: boolean }) {
  const profiles = useProfiles();
  const [creating, setCreating] = useState(create);

  if (profiles.isPending) return <SettingsSkeleton rows={4} />;
  if (profiles.isError) return <LoadError title={t("preferences.loadError.profiles")} error={profiles.error} onRetry={() => void profiles.refetch()} />;

  const list = profiles.data;
  const active = list.find((profile) => profile.isActive) ?? list[0];
  if (!active) return <LoadError title={t("preferences.loadError.profiles")} error={new Error(t("preferences.loadError.noProfile"))} onRetry={() => void profiles.refetch()} />;

  const missingAuthor = !active.authorName.trim() || !active.authorEmail.trim();

  return (
    <section>
      <SectionHeader title={t("preferences.profiles.title")}>{t("preferences.profiles.intro")}</SectionHeader>

      {missingAuthor ? (
        <div className="mb-3 overflow-hidden rounded-md" data-state="no-author">
          <Banner tone="warning" title={t("preferences.profiles.noAuthor.title")}>
            {!active.authorName.trim() && !active.authorEmail.trim()
              ? t("preferences.profiles.noAuthor.both")
              : !active.authorName.trim()
                ? t("preferences.profiles.noAuthor.name")
                : t("preferences.profiles.noAuthor.email")}{" "}
            {t("preferences.profiles.noAuthor.hint")}
          </Banner>
        </div>
      ) : null}

      <div className="flex items-center gap-3 rounded-md border border-border bg-surface-raised p-3" aria-label={t("preferences.profiles.preview")} role="group">
        {active.authorName.trim() ? (
          <Avatar name={active.authorName} email={active.authorEmail || undefined} size={40} />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-pill border border-dashed border-border-input text-text-muted" aria-hidden>
            <UserRound className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-md font-medium", active.authorName.trim() ? "text-text" : "text-text-muted")} title={active.authorName}>
            {active.authorName.trim() || t("preferences.profiles.noName")}
          </p>
          <p className="truncate text-sm text-text-muted" title={active.authorEmail}>
            {active.authorEmail.trim() || t("preferences.profiles.noEmail")}
          </p>
        </div>
        <Badge tone="accent" icon={<Check className="size-3" aria-hidden />} title={t("preferences.profiles.activeTitle")}>
          {active.name}
        </Badge>
      </div>

      <SettingRow title={t("preferences.profiles.name.title")} description={t("preferences.profiles.name.description")}>
        {(ids) => (
          <CommitText
            key={active.id}
            id={ids.id}
            describedBy={ids.descriptionId}
            className="w-64"
            value={active.name}
            validate={(value) => (value ? null : t("preferences.profiles.name.empty"))}
            onCommit={(value) => saveField(active.id, { name: value })}
          />
        )}
      </SettingRow>
      <SettingRow title={t("preferences.profiles.authorName.title")} description={t("preferences.profiles.authorName.description")}>
        {(ids) => (
          <CommitText
            key={active.id}
            id={ids.id}
            describedBy={ids.descriptionId}
            className="w-64"
            placeholder={t("preferences.profiles.authorName.placeholder")}
            value={active.authorName}
            onCommit={(value) => saveField(active.id, { authorName: value })}
          />
        )}
      </SettingRow>
      <SettingRow title={t("preferences.profiles.email.title")} description={t("preferences.profiles.email.description")}>
        {(ids) => (
          <CommitText
            key={active.id}
            id={ids.id}
            describedBy={ids.descriptionId}
            className="w-64"
            type="email"
            placeholder={t("preferences.profiles.email.placeholder")}
            value={active.authorEmail}
            validate={checkEmail}
            onCommit={(value) => saveField(active.id, { authorEmail: value })}
          />
        )}
      </SettingRow>
      <SettingRow
        title={t("preferences.profiles.syncGitconfig.title")}
        description={t("preferences.profiles.syncGitconfig.description")}
      >
        {(ids) => (
          <Switch
            id={ids.id}
            ariaDescribedBy={ids.descriptionId}
            checked={active.syncGitconfig}
            onCheckedChange={(checked) => void saveProfile(active.id, { syncGitconfig: checked })}
          />
        )}
      </SettingRow>

      <div className="mt-6 mb-2 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <GroupTitle flush id="prefs-profile-list">
            {t("preferences.profiles.list")}
          </GroupTitle>
          <p className="text-sm text-text-muted">{t("preferences.profiles.listIntro")}</p>
        </div>
        <Button icon={<Plus className="size-icon" aria-hidden />} onClick={() => setCreating(true)}>
          {t("preferences.profiles.new")}
        </Button>
      </div>
      <ul aria-labelledby="prefs-profile-list" className="overflow-hidden rounded-md border border-border">
        {list.map((profile) => (
          <ProfileRow key={profile.id} profile={profile} onlyOne={list.length < 2} />
        ))}
      </ul>

      {creating ? <NewProfileDialog onClose={() => setCreating(false)} /> : null}
    </section>
  );
}

function ProfileRow({ profile, onlyOne }: { profile: Profile; onlyOne: boolean }) {
  const blocked = profile.isActive
    ? onlyOne
      ? t("preferences.profiles.lastBlocked")
      : t("preferences.profiles.activeBlocked")
    : null;

  const activate = () => void switchProfile(profile);

  const remove = async () => {
    if (blocked) return;
    const ok = await confirm({
      title: t("preferences.profiles.delete.title", { name: profile.name }),
      body: t("preferences.profiles.delete.body"),
      confirmLabel: t("preferences.profiles.delete.confirm"),
      danger: true,
    });
    if (!ok) return;
    const result = await runAction(t("preferences.profiles.delete.action"), () => core.profileDelete({ id: profile.id }), {
      success: t("preferences.profiles.delete.done", { name: profile.name }),
    });
    if (result.ok) queryClient.setQueryData(qk.profiles, result.value);
  };

  const author = profile.authorName.trim() || profile.authorEmail.trim() ? [profile.authorName.trim(), profile.authorEmail.trim() && `<${profile.authorEmail.trim()}>`].filter(Boolean).join(" ") : t("preferences.profiles.noAuthorSet");

  return (
    <li data-profile={profile.name} className="flex h-12 items-center gap-3 border-b border-border px-3 last:border-b-0">
      {profile.authorName.trim() ? (
        <Avatar name={profile.authorName} email={profile.authorEmail || undefined} size={28} />
      ) : (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-pill border border-dashed border-border-input text-text-muted" aria-hidden>
          <UserRound className="size-icon" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-base", profile.isActive && "font-semibold")} title={profile.name}>
          {profile.name}
        </p>
        <p className="truncate text-sm text-text-muted" title={author}>
          {author}
        </p>
      </div>
      {profile.isActive ? (
        <Badge tone="accent" icon={<Check className="size-3" aria-hidden />}>
          {t("preferences.profiles.active")}
        </Badge>
      ) : (
        <Button size="sm" aria-label={t("preferences.profiles.switchLabel", { name: profile.name })} onClick={() => void activate()}>
          {t("preferences.profiles.switch")}
        </Button>
      )}
      <Tip label={blocked ?? t("preferences.profiles.delete.label", { name: profile.name })}>
        <button
          type="button"
          aria-label={t("preferences.profiles.delete.label", { name: profile.name })}
          aria-disabled={blocked ? true : undefined}
          onClick={() => void remove()}
          className={cn(
            "inline-flex size-control-sm shrink-0 items-center justify-center rounded-md text-text-muted",
            blocked ? "cursor-default text-text-disabled" : "hover:bg-surface-raised hover:text-danger",
          )}
        >
          <Trash2 className="size-icon" aria-hidden />
        </button>
      </Tip>
    </li>
  );
}

function NewProfileDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const next: typeof errors = {};
    if (!name.trim()) next.name = t("preferences.profiles.name.missing");
    const emailProblem = checkEmail(authorEmail.trim());
    if (emailProblem) next.email = emailProblem;
    setErrors(next);
    if (next.name || next.email) return;
    setBusy(true);
    const result = await runAction(
      t("preferences.profiles.create.action"),
      () => core.profileSave({ id: null, name: name.trim(), authorName: authorName.trim(), authorEmail: authorEmail.trim(), syncGitconfig: false, color: null }),
      { quiet: ["invalid_name", "name_exists", "not_allowed"] },
    );
    setBusy(false);
    if (result.ok) {
      queryClient.setQueryData(qk.profiles, result.value);
      toast({ tone: "success", title: t("preferences.profiles.create.done", { name: name.trim() }), description: t("preferences.profiles.create.doneHint") });
      onClose();
    } else if (result.error.code === "not_allowed") {
      setErrors({ email: result.error.message });
    } else if (result.error.code === "invalid_name" || result.error.code === "name_exists") {
      setErrors({ name: result.error.message });
    }
  };

  return (
    <Dialog
      open
      size="sm"
      title={t("preferences.profiles.create.title")}
      description={t("preferences.profiles.create.description")}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{t("preferences.profiles.create.cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {t("preferences.profiles.create.submit")}
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField autoFocus data-autofocus label={t("preferences.profiles.name.title")} value={name} error={errors.name} autoComplete="off" onChange={(event) => setName(event.target.value)} />
        <TextField label={t("preferences.profiles.authorName.title")} value={authorName} placeholder={t("preferences.profiles.authorName.placeholder")} autoComplete="off" onChange={(event) => setAuthorName(event.target.value)} />
        <TextField
          label={t("preferences.profiles.email.title")}
          type="email"
          value={authorEmail}
          placeholder={t("preferences.profiles.email.placeholder")}
          error={errors.email}
          autoComplete="off"
          onChange={(event) => setAuthorEmail(event.target.value)}
        />
        {/* Enter in the field submits the form. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
