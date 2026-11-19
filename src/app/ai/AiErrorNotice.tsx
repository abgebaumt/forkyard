import { useState, type ReactNode } from "react";
import type { AiProviderKind } from "../../core";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { isCli } from "./providers";
import { signInInTerminal } from "./cliLogin";
import { openAiSettings, openAiSetup } from "./open";
import type { AiFailure } from "./useAiJob";

/**
 * The inline error of an AI element (role alert, never a toast) with its actions. "Too large" and
 * "unusable" offer "Show what was sent". A signed-out command-line tool gets "Sign in in the
 * terminal" (1b's helper); without an open repository tab the line says how to sign in instead.
 * `name` makes the attribute `data-<name>` carrying the error kind.
 */
export function AiErrorNotice({
  view,
  provider,
  onAgain,
  onShowSent,
  name,
}: {
  view: AiFailure;
  provider: AiProviderKind | null;
  onAgain: () => void;
  onShowSent: () => void;
  name: string;
}) {
  const [noTerminal, setNoTerminal] = useState(false);
  const again = (label: string) => (
    <Button size="sm" onClick={onAgain}>
      {label}
    </Button>
  );
  let actions: ReactNode;
  switch (view.kind) {
    case "setup":
      actions = (
        <Button size="sm" onClick={() => void openAiSetup()}>
          {t("ai.state.setup")}
        </Button>
      );
      break;
    case "limit":
      actions = (
        <>
          {again(t("ui.sendThisTime"))}
          <Button size="sm" variant="ghost" onClick={openAiSettings}>
            {t("ai.state.limitChange")}
          </Button>
        </>
      );
      break;
    case "invalid":
    case "tooLarge":
      actions = (
        <>
          {again(t("ai.state.again"))}
          <Button size="sm" variant="ghost" onClick={onShowSent}>
            {t("ai.state.showSent")}
          </Button>
        </>
      );
      break;
    case "unavailable":
      actions = again(t("ui.retry"));
      break;
    case "notLoggedIn":
      actions = (
        <>
          {provider && isCli(provider) ? (
            <Button size="sm" data-ai-sign-in="" onClick={() => setNoTerminal(!signInInTerminal(provider))}>
              {t("ai.setup.cli.signIn")}
            </Button>
          ) : null}
          {again(t("ai.state.again"))}
        </>
      );
      break;
    default:
      actions = again(t("ai.state.again"));
  }
  return (
    <div
      role="alert"
      {...{ [`data-${name}`]: view.kind }}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm break-words text-text">{view.text}</p>
        {actions}
      </div>
      {noTerminal ? <p className="text-sm break-words text-text-muted">{t("ai.settings.signInNoRepo")}</p> : null}
    </div>
  );
}
