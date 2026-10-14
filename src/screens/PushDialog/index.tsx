/**
 * “Push …”: the branch plus further branches and tags in ONE push. “All or nothing” (`--atomic`) is
 * on as soon as more than one ref goes along. The result per ref is shown by the action afterwards.
 */
import { useMemo, useState } from "react";
import type { Id, PushExtra } from "../../core";
import { showDialog } from "../../app/dialogs";
import { useRefs, useRemotes } from "../../app/queries";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Checkbox, TextField } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { t } from "../../i18n";
import { atomicByDefault, filterCandidates, pushCandidates, toExtras } from "./model";

export interface PushPlan {
  remote: string;
  extras: PushExtra[];
  atomic: boolean;
}

function PushDialog({ repoId, branch, preselected, onDone }: { repoId: Id; branch: string; preselected: string[]; onDone: (plan: PushPlan | null) => void }) {
  const { data: refs } = useRefs(repoId);
  const { data: remotes } = useRemotes(repoId);
  const primary = refs?.locals.find((ref) => ref.name === branch);
  const upstreamRemote = primary?.upstream ? (refs?.remotes.find((ref) => ref.name === primary.upstream)?.remote ?? null) : null;
  const fallback = remotes?.find((item) => item.name === "origin")?.name ?? remotes?.[0]?.name ?? "";
  const [remote, setRemote] = useState<string | null>(null);
  const chosenRemote = remote ?? upstreamRemote ?? fallback;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(preselected);
  const [atomic, setAtomic] = useState<boolean | null>(null);
  const candidates = useMemo(() => (refs ? pushCandidates(refs, branch) : []), [refs, branch]);
  const shown = filterCandidates(candidates, query);
  const atomicOn = atomic ?? atomicByDefault(selected.length);
  const ready = Boolean(refs) && Boolean(chosenRemote) && selected.length > 0;
  const toggle = (key: string) => setSelected((list) => (list.includes(key) ? list.filter((item) => item !== key) : [...list, key]));
  const submit = () => {
    if (refs && ready) onDone({ remote: chosenRemote, extras: toExtras(selected, refs, chosenRemote), atomic: atomicOn });
  };

  return (
    <Dialog
      open
      size="md"
      title={t("pushMany.title", { branch })}
      description={t("pushMany.description")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" data-action="push-many" disabled={!ready} onClick={submit}>
            {t("pushMany.submit", { count: selected.length + 1 })}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        data-screen="push-many"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {remotes && remotes.length > 1 ? (
          <Select label={t("pushMany.remote")} value={chosenRemote} options={remotes.map((item) => ({ value: item.name, label: item.name }))} onValueChange={setRemote} />
        ) : null}
        <TextField label={t("pushMany.filter")} value={query} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        <div role="group" aria-label={t("pushMany.listLabel")} className="flex max-h-64 flex-col gap-1 overflow-auto rounded-md border border-border bg-surface-sunken p-2">
          {shown.length === 0 ? (
            <p className="m-0 text-sm text-text-muted">{t("pushMany.none")}</p>
          ) : (
            shown.map((item) => (
              <Checkbox
                key={item.key}
                label={`${item.kind === "tag" ? t("pushMany.tag") : t("pushMany.branch")} ${item.label}`}
                hint={item.hint ?? undefined}
                checked={selected.includes(item.key)}
                onCheckedChange={() => toggle(item.key)}
              />
            ))
          )}
        </div>
        <Checkbox label={t("pushMany.atomic")} hint={t("pushMany.atomicHint")} checked={atomicOn} onCheckedChange={setAtomic} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function openPushDialog(repoId: Id, branch: string, preselected: string[]): Promise<PushPlan | null> {
  return showDialog<PushPlan>((done) => <PushDialog repoId={repoId} branch={branch} preselected={preselected} onDone={done} />);
}
