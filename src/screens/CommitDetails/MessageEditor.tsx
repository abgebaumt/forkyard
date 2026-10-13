/**
 * Edit the message of the last commit directly in the panel (F12). Saving calls `commitReword`;
 * the commit gets a new SHA, the selection follows.
 */
import { useRef, useState } from "react";
import { core, type CommitInfo, type Id, type Sha } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { runAction } from "../../app/run";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/Feedback";
import { TextArea, TextField } from "../../ui/Field";
import { t } from "../../i18n";

/** Common practice: summary at most 72 characters; from 50 on the field shows the length. */
const SUMMARY_NOTICE = 50;
const SUMMARY_LIMIT = 72;

export interface MessageEditorProps {
  repoId: Id;
  tabId: Id;
  commit: CommitInfo;
  /** Closes the editor; `savedSha` is set if it was saved. */
  onClose: (savedSha: Sha | null) => void;
}

export function MessageEditor({ repoId, tabId, commit, onClose }: MessageEditorProps) {
  const [summary, setSummary] = useState(commit.summary);
  const [description, setDescription] = useState(commit.description);
  const [touched, setTouched] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const busyKey = busyKeys.write(repoId, "reword");
  const busy = useBusy(busyKey);

  const cleanSummary = summary.trim();
  const unchanged = cleanSummary === commit.summary.trim() && description.trimEnd() === commit.description.trimEnd();
  const summaryError = touched && !cleanSummary ? t("commitDetails.reword.summaryEmpty") : undefined;
  const length = [...cleanSummary].length;

  const save = async () => {
    setTouched(true);
    if (!cleanSummary) {
      formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    if (unchanged) {
      onClose(null);
      return;
    }
    const result = await runAction(t("commitDetails.commit.editMessage"), () => core.commitReword({ repoId, summary: cleanSummary, description, sha: commit.sha }), {
      busyKey,
      success: t("commitDetails.reword.done"),
    });
    if (!result.ok) return;
    // The commit has a new SHA; the old one no longer exists on the branch.
    useAppStore.getState().selectCommits(tabId, [result.value.sha]);
    onClose(result.value.sha);
  };

  return (
    <form
      ref={formRef}
      aria-label={t("commitDetails.commit.editMessage")}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose(null);
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      {commit.isPushed ? (
        <div className="overflow-hidden rounded-md">
          <Banner tone="warning" title={t("commitDetails.reword.pushedTitle")}>
            {t("commitDetails.reword.pushedText")}
          </Banner>
        </div>
      ) : null}
      <TextField
        label={t("commitDetails.reword.summary")}
        value={summary}
        autoFocus
        maxLength={2000}
        error={summaryError}
        hint={length >= SUMMARY_NOTICE ? (length > SUMMARY_LIMIT ? t("commitDetails.reword.lengthOver", { length, limit: SUMMARY_LIMIT }) : t("commitDetails.reword.length", { length })) : undefined}
        onChange={(event) => setSummary(event.target.value.replace(/[\r\n]+/g, " "))}
      />
      <TextArea
        label={t("commitDetails.reword.description")}
        value={description}
        rows={Math.min(12, Math.max(4, description.split("\n").length + 1))}
        spellCheck={false}
        className="font-mono text-code"
        onChange={(event) => setDescription(event.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" onClick={() => onClose(null)}>
          {t("commitDetails.reword.cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          {t("commitDetails.reword.save")}
        </Button>
      </div>
    </form>
  );
}
