/**
 * The inline error line of a compose suggestion (spec "Zustände jedes KI-Elements"): role alert, never
 * a toast; each state offers its own way on ("Retry", "Again", "What was sent", the setup, the limit
 * choice, "Sign in in the terminal" for a signed-out command-line tool). A cancelled request shows nothing.
 */
import { useState, type ReactNode } from "react";
import type { AiProviderKind } from "../../core";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { openAiSettings, openAiSetup } from "../../app/ai/open";
import type { AiErrorView } from "../../app/ai/requestState";
import { Button } from "../../ui/Button";
import { t } from "../../i18n";
import { isCli } from "../Preferences/ai/model";

export function RequestError({
  error,
  provider,
  onAgain,
  onShowSent,
}: {
  error: AiErrorView;
  provider: AiProviderKind | null;
  onAgain: () => void;
  onShowSent: () => void;
}) {
  // Without an open repository tab there is no terminal for the sign-in: say so instead.
  const [noTerminal, setNoTerminal] = useState(false);
  if (error.kind === "cancelled") return null;
  let actions: ReactNode = null;
  switch (error.kind) {
    case "setup":
      actions = (
        <Button size="sm" onClick={() => void openAiSetup()}>
          {t("ai.state.setup")}
        </Button>
      );
      break;
    case "unavailable":
      actions = (
        <Button size="sm" onClick={onAgain}>
          {t("ai.state.retry")}
        </Button>
      );
      break;
    case "notLoggedIn":
      actions = (
        <>
          {provider && isCli(provider) ? (
            <Button size="sm" data-compose-sign-in="" onClick={() => setNoTerminal(!signInInTerminal(provider))}>
              {t("ai.setup.cli.signIn")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onAgain}>
            {t("ai.state.again")}
          </Button>
        </>
      );
      break;
    case "invalid":
      actions = (
        <>
          <Button size="sm" onClick={onAgain}>
            {t("ai.state.again")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onShowSent}>
            {t("ai.state.showSent")}
          </Button>
        </>
      );
      break;
    case "tooLarge":
      actions = (
        <Button size="sm" variant="ghost" onClick={onShowSent}>
          {t("ai.state.showSent")}
        </Button>
      );
      break;
    case "limit":
      actions = (
        <>
          <Button size="sm" onClick={onAgain}>
            {t("ai.state.limitSend")}
          </Button>
          <Button size="sm" variant="ghost" onClick={openAiSettings}>
            {t("ai.state.limitChange")}
          </Button>
        </>
      );
      break;
    default:
      break;
  }
  return (
    <div role="alert" data-compose-error={error.kind} className="flex flex-col gap-1 border-b border-border px-3 py-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-danger">{error.text}</span>
        {actions}
      </div>
      {noTerminal ? <p className="m-0 break-words text-text-muted">{t("ai.settings.signInNoRepo")}</p> : null}
    </div>
  );
}
