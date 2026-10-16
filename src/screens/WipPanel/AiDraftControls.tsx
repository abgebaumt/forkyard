/**
 * "Write" in the summary field and the line below it (spec 3.1). The button reads "Write", becomes
 * "Cancel" while the request runs and "New" afterwards; without staged changes it is blocked with the
 * reason "Nothing staged". The line counts seconds from 3 s (role status = polite), names the draft,
 * offers a suggestion without replacing the user's text, or shows an error inline (role alert, never
 * a toast). Nothing here moves the focus. The views take their state as props (rendered in tests);
 * the wrappers read the store.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { AiProviderKind, Id } from "../../core";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { showWhatIsSent } from "../../app/ai/gate";
import { openAiSettings, openAiSetup } from "../../app/ai/open";
import { loadingView, type AiErrorView } from "../../app/ai/requestState";
import { Button } from "../../ui/Button";
import { Tip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { isCli } from "../Preferences/ai/model";
import { writeBlocked, writeLabel, type AiDraftPhase } from "./aiDraft";
import { acceptOffer, toggleWriteMessage, useAiDraft, writeMessage } from "./aiDraftActions";

const labelText = (label: "write" | "cancel" | "again") => (label === "cancel" ? t("ai.state.cancel") : label === "again" ? t("wip.ai.again") : t("wip.ai.write"));

export function AiWriteButtonView({ phase, staged, onToggle }: { phase: AiDraftPhase["kind"]; staged: number; onToggle: () => void }) {
  const label = writeLabel(phase);
  const blocked = label === "cancel" ? null : writeBlocked(staged);
  return (
    <Tip side="top" label={blocked ?? (label === "cancel" ? t("ai.state.cancel") : t("wip.ai.writeTip"))} shortcut={blocked ? undefined : "Mod+Shift+M"}>
      <Button
        size="sm"
        variant="ghost"
        data-ai-write=""
        data-blocked={blocked ? "" : undefined}
        {...(blocked ? { "aria-disabled": true } : {})}
        className="text-text-muted data-[blocked]:cursor-default data-[blocked]:text-text-disabled data-[blocked]:hover:bg-transparent"
        onClick={() => {
          if (!blocked) onToggle();
        }}
      >
        {labelText(label)}
      </Button>
    </Tip>
  );
}

export function AiWriteButton({ repoId, staged }: { repoId: Id; staged: number }) {
  const { phase } = useAiDraft(repoId);
  return <AiWriteButtonView phase={phase.kind} staged={staged} onToggle={() => void toggleWriteMessage(repoId)} />;
}

function WhatIsSent({ repoId, label }: { repoId: Id; label: string }) {
  return (
    <button
      type="button"
      data-ai-commit-preview=""
      className="rounded-sm text-text-muted underline-offset-2 hover:text-text hover:underline focus-visible:underline"
      onClick={() => void showWhatIsSent(repoId, "commit_message", { kind: "commit_message" })}
    >
      {label}
    </button>
  );
}

function ErrorLine({ repoId, view, provider }: { repoId: Id; view: Exclude<AiErrorView, { kind: "cancelled" }>; provider: AiProviderKind | null }) {
  // Without an open repository tab there is no terminal for the sign-in: say so instead.
  const [noTerminal, setNoTerminal] = useState(false);
  const again = (label: string) => (
    <Button size="sm" variant="ghost" onClick={() => void writeMessage(repoId)}>
      {label}
    </Button>
  );
  const setup = (label: string) => (
    <Button size="sm" variant="ghost" onClick={() => void openAiSetup()}>
      {label}
    </Button>
  );
  const actions: ReactNode =
    view.kind === "setup" ? (
      setup(t("ai.state.setup"))
    ) : view.kind === "unavailable" ? (
      again(t("ai.state.retry"))
    ) : view.kind === "notLoggedIn" && provider && isCli(provider) ? (
      <Button size="sm" variant="ghost" data-ai-sign-in="" onClick={() => setNoTerminal(!signInInTerminal(provider))}>
        {t("ai.setup.cli.signIn")}
      </Button>
    ) : view.kind === "invalid" ? (
      <>
        {again(t("ai.state.again"))}
        <WhatIsSent repoId={repoId} label={t("ai.state.showSent")} />
      </>
    ) : view.kind === "limit" ? (
      <>
        {again(t("ai.state.limitSend"))}
        <Button size="sm" variant="ghost" onClick={() => openAiSettings()}>
          {t("ai.state.limitChange")}
        </Button>
      </>
    ) : view.kind === "tooLarge" ? (
      <WhatIsSent repoId={repoId} label={t("wip.ai.whatIsSent")} />
    ) : null;
  return (
    <div role="alert" data-ai-error="" className="flex flex-col gap-1 text-sm">
      <p className="break-words text-danger">{view.text}</p>
      {noTerminal ? <p className="break-words text-text-muted">{t("ai.settings.signInNoRepo")}</p> : null}
      {actions ? <div className="flex flex-wrap items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function AiDraftStatusView({
  repoId,
  phase,
  local,
  elapsedMs,
  staged,
  provider = null,
}: {
  repoId: Id;
  phase: AiDraftPhase;
  local: boolean;
  elapsedMs: number;
  staged: number;
  provider?: AiProviderKind | null;
}) {
  switch (phase.kind) {
    case "idle":
      // Grundregel 4: the exact text can be looked at before anything is sent (no live region – nothing changed).
      return staged > 0 ? (
        <p data-ai-write-idle="" className="flex justify-end text-sm">
          <WhatIsSent repoId={repoId} label={t("wip.ai.whatIsSent")} />
        </p>
      ) : null;
    case "running": {
      const view = loadingView(elapsedMs, local);
      return (
        <p role="status" data-ai-write-status="" className="flex flex-wrap gap-x-2 text-sm text-text-muted">
          <span>{view.text}</span>
          {view.slow ? <span>{view.slow}</span> : null}
        </p>
      );
    }
    case "done":
      return (
        <p role="status" data-ai-write-status="" className="flex flex-wrap items-baseline gap-x-2 text-sm text-text-muted">
          {phase.inserted ? <span className="font-medium text-text">{t("ai.suggestion.draft")}</span> : null}
          <span>{t("wip.ai.hint")}</span>
          <WhatIsSent repoId={repoId} label={t("wip.ai.whatIsSent")} />
        </p>
      );
    case "offer":
      return (
        <div role="status" data-ai-offer="" className="flex flex-col gap-1 rounded-md bg-surface-sunken p-2 text-sm">
          <p className="text-text-muted">{phase.reason === "ready" ? t("ai.suggestion.ready") : t("wip.ai.offer")}</p>
          <p className="truncate font-medium text-text" title={phase.suggestion.summary}>
            {phase.suggestion.summary}
          </p>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" data-ai-offer-action="replace" onClick={() => acceptOffer(repoId, "replace")}>
              {t("ai.suggestion.replace")}
            </Button>
            <Button size="sm" variant="ghost" data-ai-offer-action="append" onClick={() => acceptOffer(repoId, "append")}>
              {t("ai.suggestion.append")}
            </Button>
            <Button size="sm" variant="ghost" data-ai-offer-action="discard" onClick={() => acceptOffer(repoId, "discard")}>
              {t("ai.suggestion.discard")}
            </Button>
          </div>
        </div>
      );
    case "error":
      return phase.view.kind === "cancelled" ? null : <ErrorLine repoId={repoId} view={phase.view} provider={provider} />;
  }
}

/** Milliseconds since `startedAt`, updated every second while it is set. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : now - startedAt;
}

export function AiDraftStatus({ repoId, local, staged, provider = null }: { repoId: Id; local: boolean; staged: number; provider?: AiProviderKind | null }) {
  const { phase } = useAiDraft(repoId);
  const elapsed = useElapsed(phase.kind === "running" ? phase.startedAt : null);
  return <AiDraftStatusView repoId={repoId} phase={phase} local={local} elapsedMs={elapsed} staged={staged} provider={provider} />;
}
