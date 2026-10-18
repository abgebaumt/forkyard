/**
 * "Write release notes …" on a tag or a commit: the range (needs no AI), the writer, an editable
 * text and the targets. A commit has no version, so it only offers the clipboard; an existing
 * tag's annotation is not rewritten.
 */
import { useRef, useState } from "react";
import type { AiProviderKind, Id, Sha } from "../../core";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextArea } from "../../ui/Field";
import { cachedAiStatus, short } from "../../app/actions/context";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { openAiSettings } from "../../app/ai/open";
import { aiVisibility } from "../../app/ai/visibility";
import { showDialog } from "../../app/dialogs";
import { useAiStatus, useReleaseNotesRange } from "../../app/queries";
import { isCli } from "../Preferences/ai/model";
import { applyReleaseTargets } from "./apply";
import { availableTargets, rangeLine, type ReleaseTarget } from "./model";
import { ReleaseTargets } from "./Targets";
import { useReleaseNotesAvailability } from "./useAvailability";
import { useReleaseNotesWriter } from "./useWriter";
import { ReleaseNotesWriter } from "./Writer";

export type ReleaseNotesSubject = { kind: "tag"; name: string } | { kind: "commit"; sha: Sha };

export function openReleaseNotes(repoId: Id, subject: ReleaseNotesSubject): Promise<void> {
  if (aiVisibility(cachedAiStatus()).elementsOpenSetup) {
    openAiSettings();
    return Promise.resolve();
  }
  return showDialog<null>((done) => <ReleaseNotesDialog repoId={repoId} subject={subject} onDone={done} />).then(() => undefined);
}

/**
 * "Sign in in the terminal" for a CLI provider: the terminal sits behind this modal dialog, so the
 * dialog closes first. Other providers have no terminal sign-in (no button).
 */
export function signInFor(provider: AiProviderKind | null, close: () => void): (() => void) | undefined {
  if (!provider || !isCli(provider)) return undefined;
  return () => {
    close();
    signInInTerminal(provider);
  };
}

function ReleaseNotesDialog({ repoId, subject, onDone }: { repoId: Id; subject: ReleaseNotesSubject; onDone: (value: null) => void }) {
  const to = subject.kind === "tag" ? `refs/tags/${subject.name}` : subject.sha;
  const tag = subject.kind === "tag" ? subject.name : null;
  const title = subject.kind === "tag" ? t("actions.tags.releaseNotes.titleTag", { name: subject.name }) : t("actions.tags.releaseNotes.titleCommit", { sha: short(subject.sha) });
  const [notes, setNotes] = useState("");
  const notesRef = useRef("");
  const setText = (value: string) => {
    notesRef.current = value;
    setNotes(value);
  };
  const [targets, setTargets] = useState<ReleaseTarget[]>([]);
  const [busy, setBusy] = useState(false);
  const availability = useReleaseNotesAvailability(repoId);
  const range = useReleaseNotesRange(repoId, to);
  const writer = useReleaseNotesWriter({ repoId, to, current: () => notesRef.current, apply: setText });
  const provider = useAiStatus().data?.provider ?? null;
  const available = availableTargets(subject.kind, availability.hostReleases);

  const apply = async () => {
    const text = notes.trim();
    if (!text || targets.length === 0 || busy) return;
    setBusy(true);
    const done = await applyReleaseTargets({ repoId, tag, notes: text, targets });
    setBusy(false);
    if (done.length === targets.length) onDone(null);
  };

  return (
    <Dialog
      open
      size="lg"
      title={title}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("actions.tags.releaseNotes.close")}</Button>
          <Button variant="primary" loading={busy} disabled={!notes.trim() || targets.length === 0} onClick={() => void apply()}>
            {t("actions.tags.releaseNotes.apply")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-release-notes-dialog="">
        {range.data ? (
          <p className="text-sm text-text-muted" data-release-notes-range="">
            {rangeLine(range.data)}
          </p>
        ) : null}
        <ReleaseNotesWriter
          repoId={repoId}
          to={to}
          writer={writer}
          openSetup={availability.openSetup}
          local={availability.local}
          onSetup={() => {
            onDone(null);
            openAiSettings();
          }}
          onSignIn={signInFor(provider, () => onDone(null))}
        />
        <TextArea
          data-release-notes-text=""
          label={t("actions.tags.releaseNotes.notes")}
          value={notes}
          rows={12}
          onChange={(event) => {
            setText(event.target.value);
            writer.edited();
          }}
        />
        <ReleaseTargets available={available} selected={targets} onChange={setTargets} hostName={availability.hostName} remote={availability.remote} />
      </div>
    </Dialog>
  );
}
