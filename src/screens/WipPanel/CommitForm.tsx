import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useLayoutEffect, useState } from "react";
import { GitCommitHorizontal, Lock } from "lucide-react";
import { SUMMARY_LIMIT, type Id } from "../../core";
import { useAiStatus, useCommitDetails, useDraft, useRemotes, useRepoSettings, useSettings, useStatus } from "../../app/queries";
import { featureVisible } from "../../app/ai/visibility";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Checkbox, TextArea, TextField } from "../../ui/Field";
import { Tip } from "../../ui/Tooltip";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import { foreignStaged, foreignWarning, useLockIndex } from "../Lfs/locks";
import { amendHeadMoved, commitChanges, planCommit, pushAfterState, setAmend, wipBusy } from "./actions";
import { EMPTY_DRAFT, applyTemplate, flushDraft, getDraft, splitMessage, updateDraft, useCommitTemplate } from "./draft";
import { useWipStore, useWipTab } from "./state";
import { AiDraftStatus, AiWriteButton } from "./AiDraftControls";
import { cancelWriteMessage, noteEdited, settleAiDraft, undoInsertion } from "./aiDraftActions";

/** From here on the summary shows its counter, from `SUMMARY_LIMIT` in the warning colour. */
const SUMMARY_COUNTER_FROM = 50;

/** Shift pressed? Then the primary button offers "Stage all and commit". */
function useShiftHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const sync = (event: KeyboardEvent) => setHeld(event.shiftKey);
    const reset = () => setHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
}

/** Commit form below the lists: summary, description, options, primary button. */
export function CommitForm({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const { data: status } = useStatus(repoId);
  const { data: storedDraft } = useDraft(repoId);
  const { data: settings } = useSettings();
  const { data: remotes } = useRemotes(repoId);
  const template = useCommitTemplate(repoId);
  const wip = useWipTab(tabId);
  const patch = useWipStore.getState().patch;
  const committing = useBusy(wipBusy.commit(repoId));
  const continuing = useBusy(`${repoId}:operation`);
  const shift = useShiftHeld();
  const summaryId = useId();
  const descriptionId = useId();
  const { data: aiStatus } = useAiStatus();
  const { data: repoSettings } = useRepoSettings(repoId);
  // Hidden until the repository's settings are known: "AI off for this repository" must never flash.
  const aiShown = featureVisible(aiStatus, "commit_message", repoSettings?.aiOff ?? true);

  const draft = storedDraft ?? EMPTY_DRAFT;
  const operation = status?.operation ?? null;
  const head = status?.head;
  const headSha = head && head.kind !== "unborn" ? head.sha : null;
  const { data: headCommit } = useCommitDetails(repoId, draft.amend && headSha ? { kind: "commit", sha: headSha } : null);

  // "Amend" refers to the commit that was the last one when the box was checked. If the last commit
  // changes (commit in the terminal, pull), the untouched default follows the new one – or the box is unchecked.
  const amendSha = wip.amendSha;
  useEffect(() => {
    if (!draft.amend || !headSha) return;
    if (amendSha === null) {
      patch(tabId, { amendSha: headSha });
      return;
    }
    if (amendSha === headSha || committing) return;
    // A moment later: after our own "Amend commit" the last commit changes too –
    // then the draft (and with it the check box) is cleared right after.
    const timer = window.setTimeout(() => void amendHeadMoved(repoId, tabId, template), 80);
    return () => window.clearTimeout(timer);
  }, [draft.amend, headSha, amendSha, committing, repoId, tabId, template, patch]);

  // The fields keep their own text (otherwise a controlled field loses characters when typing fast,
  // because the query cache notifies its observers with a delay). The cache stays the source:
  // if it changes from outside (loaded, commit, amend, template), the fields follow.
  const [text, setText] = useState({ summary: draft.summary, description: draft.description });
  useEffect(() => {
    const fresh = getDraft(repoId);
    setText((current) => (current.summary === fresh.summary && current.description === fresh.description ? current : { summary: fresh.summary, description: fresh.description }));
  }, [repoId, storedDraft]);

  // Template as the initial value when there is no draft.
  useEffect(() => {
    if (storedDraft) applyTemplate(repoId, template);
  }, [repoId, storedDraft, template]);

  // On leaving (tab switch, other panel) save immediately whatever is still pending.
  useEffect(() => () => flushDraft(repoId), [repoId]);
  // After the commit (or once both fields were cleared) the hint about the AI draft goes away.
  useEffect(() => {
    if (!text.summary.trim() && !text.description.trim()) settleAiDraft(repoId);
  }, [repoId, text.summary, text.description]);
  // AI turned off (master switch, the function or this repository) while writing: the request ends at once (Grundregel 1).
  useEffect(() => {
    if (!aiShown) cancelWriteMessage(repoId);
  }, [aiShown, repoId]);

  // During a merge the prepared message is shown as long as the user has not touched it. After that
  // the field rules: whoever clears it to write anew does not get the default back.
  const mergeKey = operation?.kind === "merge" ? `merge:${headSha ?? ""}` : null;
  const prepared =
    mergeKey !== null && wip.mergeMessageTouched !== mergeKey && !text.summary && !text.description ? splitMessage(operation?.message ?? "") : null;
  const summary = prepared?.summary ?? text.summary;
  const description = prepared?.description ?? text.description;

  const plan = planCommit(status, draft, shift);
  const push = pushAfterState(wip.pushAfter, settings, status, remotes);
  const busy = committing || continuing;
  const locks = useLockIndex(repoId);
  const lockWarning = foreignWarning(foreignStaged(status?.staged ?? [], locks));

  const amendBlocked = operation
    ? t("wip.form.amendOperation")
    : head?.kind === "unborn"
      ? t("wip.form.amendUnborn")
      : null;
  const amendHint = amendBlocked ?? (draft.amend && headCommit?.commit?.isPushed ? t("wip.form.amendPushed") : undefined);

  // The description grows with the text, up to the limit from the class max-h-40.
  useLayoutEffect(() => {
    const area = document.getElementById(descriptionId);
    if (!(area instanceof HTMLTextAreaElement)) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + (area.offsetHeight - area.clientHeight)}px`;
  }, [description, descriptionId]);

  // If the summary is missing on a commit attempt, focus jumps into the field.
  const errorNonce = wip.summaryError?.nonce;
  useEffect(() => {
    if (errorNonce !== undefined) document.getElementById(summaryId)?.focus();
  }, [errorNonce, summaryId]);

  const edit = (next: { summary?: string; description?: string }) => {
    // Whoever edits the prepared merge message thereby takes it over into the draft.
    const patched = prepared ? { summary: prepared.summary, description: prepared.description, ...next } : next;
    if (mergeKey !== null && wip.mergeMessageTouched !== mergeKey) patch(tabId, { mergeMessageTouched: mergeKey });
    setText((current) => ({ ...current, ...patched }));
    updateDraft(repoId, patched);
    noteEdited(repoId);
    if (wip.summaryError && next.summary?.trim()) patch(tabId, { summaryError: null });
  };

  // Mod+Z right after an AI draft was inserted takes it back (the field's own history does not know
  // text that was set from outside); otherwise the field handles Mod+Z itself.
  const undoKey = (event: ReactKeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z" && undoInsertion(repoId)) event.preventDefault();
  };

  const length = [...summary].length;
  const overLimit = length > SUMMARY_LIMIT;

  return (
    <form
      aria-label={draft.amend ? t("wip.form.amendTitle") : t("wip.commit.action")}
      className="flex shrink-0 flex-col gap-2 border-t border-border p-2"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="relative">
        <TextField
          id={summaryId}
          data-commit-summary=""
          aria-label={t("wip.form.summary")}
          placeholder={draft.amend ? t("wip.form.summaryAmendPlaceholder") : t("wip.form.summaryPlaceholder")}
          value={summary}
          error={wip.summaryError?.text}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className={cn(aiShown ? (length >= SUMMARY_COUNTER_FROM ? "pr-36" : "pr-24") : length >= SUMMARY_COUNTER_FROM && "pr-14")}
          onChange={(event) => edit({ summary: event.target.value.replace(/[\r\n]+/g, " ") })}
          onKeyDown={(event) => {
            undoKey(event);
            if (event.defaultPrevented) return;
            // Enter jumps into the description; Ctrl+Enter commits.
            if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              document.getElementById(descriptionId)?.focus();
            }
          }}
        />
        <div className="absolute top-0 right-1 flex h-control-md items-center gap-1">
          {aiShown ? <AiWriteButton repoId={repoId} staged={status?.staged.length ?? 0} /> : null}
          {length >= SUMMARY_COUNTER_FROM ? (
            <span
              className={cn("pointer-events-none flex items-center pr-1 text-xs tabular-nums", overLimit ? "font-semibold text-warning" : "text-text-muted")}
              title={overLimit ? t("wip.form.overLimitTitle", { limit: SUMMARY_LIMIT }) : undefined}
            >
              <span aria-hidden>
                {length}/{SUMMARY_LIMIT}
              </span>
              <span className="sr-only" role="status">
                {overLimit ? t("wip.form.overLimitStatus", { length, limit: SUMMARY_LIMIT }) : t("wip.form.lengthStatus", { length, limit: SUMMARY_LIMIT })}
              </span>
            </span>
          ) : null}
        </div>
      </div>
      {aiShown ? <AiDraftStatus repoId={repoId} local={aiStatus?.local ?? false} staged={status?.staged.length ?? 0} provider={aiStatus?.provider ?? null} /> : null}
      <TextArea
        id={descriptionId}
        aria-label={t("wip.form.description")}
        placeholder={t("wip.form.descriptionPlaceholder")}
        rows={2}
        value={description}
        spellCheck={false}
        className="max-h-40 resize-none!"
        onChange={(event) => edit({ description: event.target.value })}
        onKeyDown={undoKey}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Checkbox
          label={t("wip.form.amendLabel")}
          checked={draft.amend && !amendBlocked}
          disabled={Boolean(amendBlocked)}
          hint={amendHint}
          onCheckedChange={(checked) => void setAmend(repoId, tabId, checked, template)}
        />
        <Checkbox
          label={t("wip.form.pushAfter")}
          checked={push.checked}
          disabled={Boolean(push.blocked)}
          hint={push.blocked ?? undefined}
          onCheckedChange={(checked) => patch(tabId, { pushAfter: checked })}
        />
        <Checkbox label={t("wip.form.skipHooks")} checked={wip.skipHooks} onCheckedChange={(checked) => patch(tabId, { skipHooks: checked })} />
      </div>
      {lockWarning ? (
        <p role="status" data-commit-lock-warning="" className="flex items-start gap-1.5 text-sm text-text-muted">
          <Lock className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 break-words">{lockWarning}</span>
        </p>
      ) : null}
      <Tip
        side="top"
        label={plan.blocked ?? (plan.stageAll ? t("wip.form.tipStageAll") : plan.mode === "commit" ? t("wip.form.tipCommit") : plan.label)}
        shortcut={plan.blocked ? undefined : plan.stageAll ? "Mod+Shift+Enter" : "Mod+Enter"}
      >
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          icon={<GitCommitHorizontal className="size-icon" aria-hidden />}
          data-action="commit"
          data-blocked={plan.blocked ? "" : undefined}
          {...(plan.blocked ? { "aria-disabled": true } : {})}
          className="w-full data-[blocked]:cursor-default data-[blocked]:bg-surface-raised data-[blocked]:text-text-disabled data-[blocked]:hover:brightness-100"
          onClick={(event) => void commitChanges(repoId, tabId, { stageAll: event.shiftKey })}
        >
          <span className="truncate">{plan.label}</span>
        </Button>
      </Tip>
    </form>
  );
}
