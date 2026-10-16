/**
 * “Set up AI” (spec 1.3, Teilpaket 1b): finds Claude Code, Codex, opencode, Ollama, LM Studio and stored
 * keys (`aiDetect` – nothing is sent) and turns AI on: with one click when exactly one signed-in tool is
 * there, otherwise step by step (provider → model → functions). Cancel changes neither the master switch
 * nor the AI state. Shown through `showDialog`, so focus handling knows it (src/app/viewFocus.ts); the
 * search result arriving later never moves the focus.
 */
import { useEffect, useState } from "react";
import { core, type AiCliFound, type AiDetection, type AiLocalFound, type AiProviderKind, type ErrorCode, type Id, type Tab } from "../../core";
import { applySettings } from "../../screens/Preferences/settings";
import { acceptsKey, FEATURES, featureToggle, isCli, PROVIDERS, usesBaseUrl } from "../../screens/Preferences/ai/model";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Dialog } from "../../ui/Dialog";
import { TextField } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { t } from "../../i18n";
import { openInBrowser } from "../actions/hosts";
import { showDialog } from "../dialogs";
import { toCoreError } from "../errors";
import { qk, queryClient } from "../queries";
import { newJobId, runAction } from "../run";
import { canLeaveModel, canLeaveProvider, draftFromPick, EMPTY_DRAFT, isUsableCli, pickId, primaryAction, settingsPatch, setupOverview, whereKind, type SetupDraft, type SetupStep } from "./setupModel";

export type SetupResult = { kind: "on" } | { kind: "whatIsSent"; repoId: Id } | { kind: "signIn"; provider: AiProviderKind } | { kind: "off" };

/** “Install a local model”: the download page of Ollama in the browser. */
const OLLAMA_DOWNLOAD = "https://ollama.com/download";
/** Shown in the dialog itself, not as a toast. */
const CHECK_QUIET: ErrorCode[] = ["ai_not_configured", "ai_provider_unavailable", "ai_not_logged_in", "ai_unsupported_version", "offline", "timeout", "not_allowed", "unknown"];
const LOGIN_DOT: Record<AiCliFound["login"], string> = { logged_in: "bg-success", logged_out: "bg-warning", unknown: "bg-text-muted" };

const nameOf = (provider: AiProviderKind) => t(`ai.names.${provider}`);
const providerOptions = PROVIDERS.map((value) => ({ value: value as string, label: t(`ai.providers.${value}`) }));

function loginText(cli: AiCliFound): string {
  if (cli.login === "logged_in") return cli.loginMethod ? t("ai.setup.cli.loggedInWith", { method: cli.loginMethod }) : t("ai.setup.cli.loggedIn");
  return cli.login === "logged_out" ? t("ai.setup.cli.loggedOut") : t("ai.setup.cli.unknown");
}

function activeRepoId(): Id | null {
  return queryClient.getQueryData<Tab[]>(qk.tabs)?.find((tab) => tab.isActive)?.repoId ?? null;
}

function PickRadio({ id, checked, disabled, onPick }: { id: string; checked: boolean; disabled: boolean; onPick: () => void }) {
  return <input id={id} type="radio" name="ai-setup-pick" className="mt-1 accent-accent" checked={checked} disabled={disabled} onChange={onPick} />;
}

function CliRow({ cli, checked, onPick, onSignIn }: { cli: AiCliFound; checked: boolean; onPick: () => void; onSignIn: (() => void) | null }) {
  const id = `ai-setup-cli-${cli.provider}`;
  return (
    <div data-ai-find={`cli:${cli.provider}`} data-login={cli.login} className="flex items-start gap-2 rounded-md border border-border p-3">
      <PickRadio id={id} checked={checked} disabled={!isUsableCli(cli)} onPick={onPick} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-text">
          {nameOf(cli.provider)}
        </label>
        <p className="text-sm text-text-muted">
          {cli.version ? t("ai.setup.cli.version", { version: cli.version }) : t("ai.setup.cli.noVersion")} · {t(`ai.setup.cli.source.${cli.source}`)}
        </p>
        <p className="font-mono text-code break-all text-text-muted">{cli.path}</p>
        <p className="flex items-center gap-1.5 text-sm text-text">
          <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", LOGIN_DOT[cli.login])} />
          {loginText(cli)}
        </p>
        {cli.usesEnvKey ? <p className="text-sm text-text-muted">{t("ai.setup.cli.envKey")}</p> : null}
        {!cli.supported ? <p className="text-sm text-danger">{t("ai.setup.cli.unsupported", { problem: cli.problem ?? "" })}</p> : null}
        {cli.supported && cli.login !== "logged_in" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-text-muted">{t("ai.setup.cli.signInHint", { command: cli.loginCommand })}</p>
            {onSignIn ? (
              <Button size="sm" data-ai-setup-sign-in onClick={onSignIn}>
                {t("ai.setup.cli.signIn")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LocalRow({ local, checked, onPick }: { local: AiLocalFound; checked: boolean; onPick: () => void }) {
  const id = `ai-setup-local-${local.provider}`;
  const address = local.baseUrl.replace(/^https?:\/\//, "");
  return (
    <div data-ai-find={`local:${local.provider}`} className="flex items-start gap-2 rounded-md border border-border p-3">
      <PickRadio id={id} checked={checked} disabled={local.models.length === 0} onPick={onPick} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-text">
          {nameOf(local.provider)}
        </label>
        <p className="text-sm text-text-muted">{local.models.length ? t("ai.setup.local.running", { address, count: local.models.length }) : t("ai.setup.local.noModels", { address })}</p>
      </div>
    </div>
  );
}

function KeyRow({ provider, checked, onPick }: { provider: AiProviderKind; checked: boolean; onPick: () => void }) {
  const id = `ai-setup-key-${provider}`;
  return (
    <div data-ai-find={`key:${provider}`} className="flex items-start gap-2 rounded-md border border-border p-3">
      <PickRadio id={id} checked={checked} disabled={false} onPick={onPick} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-text">
          {nameOf(provider)}
        </label>
        <p className="text-sm text-text-muted">{t("ai.setup.keyStored")}</p>
      </div>
    </div>
  );
}

function SetupDialog({ repoId, onDone }: { repoId: Id | null; onDone: (result: SetupResult | null) => void }) {
  const [step, setStep] = useState<SetupStep>("search");
  const [detection, setDetection] = useState<AiDetection | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<SetupDraft>(EMPTY_DRAFT);
  const [keyDraft, setKeyDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    core.aiDetect().then(
      (found) => {
        if (!alive) return;
        setDetection(found);
        const view = setupOverview(found);
        setSelected(view.preselected ? pickId(view.preselected) : null);
        setStep("found");
      },
      (error: unknown) => {
        if (!alive) return;
        setSearchError(toCoreError(error).message);
        setStep("found");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const overview = detection ? setupOverview(detection) : null;
  const pick = overview?.picks.find((entry) => pickId(entry) === selected) ?? null;
  const action = primaryAction(pick);
  const provider = draft.provider;
  const nothingUsable = !overview || overview.nothingUsable;

  const turnOn = async (next: SetupDraft) => {
    setBusy(true);
    const result = await applySettings(settingsPatch(next));
    setBusy(false);
    if (!result.ok) return;
    setDraft(next);
    setStep("done");
  };

  /** “Check”: asks the provider for its models with the entered values; a typed key is stored only after it worked. */
  const check = async (current: SetupDraft, typedKey: string | null): Promise<SetupDraft | null> => {
    const chosen = current.provider;
    if (!chosen) return null;
    setChecking(true);
    setCheckResult(null);
    const result = await runAction(t("ai.setup.provider.checkAction"), () => core.aiModels({ jobId: newJobId(), provider: chosen, baseUrl: current.baseUrl, key: typedKey, model: null }), { quiet: CHECK_QUIET });
    if (!result.ok) {
      setChecking(false);
      setCheckResult({ ok: false, text: result.error.message || t(`errors.${result.error.code}.text`) });
      return null;
    }
    if (typedKey && acceptsKey(chosen)) {
      const saved = await runAction(t("ai.settings.key.save"), () => core.aiKeySet({ provider: chosen, key: typedKey }));
      if (!saved.ok) {
        setChecking(false);
        return null;
      }
      queryClient.setQueryData(qk.aiStatus, saved.value);
      setKeyDraft("");
    }
    setChecking(false);
    const models = result.value.models.map((model) => model.id);
    const next: SetupDraft = { ...current, checked: true, models, model: current.model ?? (isCli(chosen) ? null : (models[0] ?? null)) };
    setDraft(next);
    setCheckResult({ ok: true, text: isCli(chosen) ? t("ai.setup.provider.cliOk", { name: nameOf(chosen) }) : t("ai.setup.provider.ok", { count: models.length }) });
    return next;
  };

  const continueWithPick = async () => {
    if (!pick) return;
    const next = draftFromPick(pick);
    if (pick.kind === "cli") {
      await turnOn(next);
      return;
    }
    if (pick.kind === "key") {
      setDraft(next);
      const checked = await check(next, null);
      setStep(checked ? "model" : "provider");
      return;
    }
    setDraft(next);
    setStep("model");
  };

  const cockpitOnly = async () => {
    setBusy(true);
    const result = await applySettings({ aiEnabled: false });
    setBusy(false);
    if (result.ok) onDone({ kind: "off" });
  };

  const otherChoice = () => {
    setDraft(EMPTY_DRAFT);
    setKeyDraft("");
    setCheckResult(null);
    setStep("provider");
  };

  const close = () => onDone(step === "done" ? { kind: "on" } : null);

  const body = (() => {
    switch (step) {
      case "search":
        // Announced by the live region below, which stays in place when the result arrives.
        return <p className="text-sm text-text-muted">{t("ai.setup.searching")}</p>;
      case "found":
        return (
          <div className="flex flex-col gap-3">
            {searchError ? (
              <p role="alert" className="text-sm text-danger">
                {t("ai.setup.failed", { message: searchError })}
              </p>
            ) : null}
            {detection && (detection.clis.length || detection.local.length || detection.keys.length) ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-text">{t("ai.setup.foundTitle")}</legend>
                {detection.clis.map((cli) => (
                  <CliRow
                    key={cli.provider}
                    cli={cli}
                    checked={selected === `cli:${cli.provider}`}
                    onPick={() => setSelected(`cli:${cli.provider}`)}
                    onSignIn={repoId ? () => onDone({ kind: "signIn", provider: cli.provider }) : null}
                  />
                ))}
                {detection.local.map((local) => (
                  <LocalRow key={local.provider} local={local} checked={selected === `local:${local.provider}`} onPick={() => setSelected(`local:${local.provider}`)} />
                ))}
                {detection.keys.map((key) => (
                  <KeyRow key={key} provider={key} checked={selected === `key:${key}`} onPick={() => setSelected(`key:${key}`)} />
                ))}
              </fieldset>
            ) : (
              <p className="text-sm text-text-muted">{t("ai.setup.none")}</p>
            )}
            {nothingUsable ? (
              <div data-ai-setup-nothing className="flex flex-col gap-2">
                <p className="text-sm font-medium text-text">{t("ai.setup.nothing.title")}</p>
                <div>
                  <Button data-ai-setup-nothing-option="key" onClick={otherChoice}>
                    {t("ai.setup.nothing.key")}
                  </Button>
                </div>
                <div className="flex flex-col items-start gap-0.5">
                  <Button variant="ghost" data-ai-setup-nothing-option="local" onClick={() => void openInBrowser(OLLAMA_DOWNLOAD, t("ai.setup.nothing.local"))}>
                    {t("ai.setup.nothing.local")}
                  </Button>
                  <p className="text-sm text-text-muted">{t("ai.setup.nothing.localHint")}</p>
                </div>
                <div className="flex flex-col items-start gap-0.5">
                  <Button variant="ghost" data-ai-setup-nothing-option="cockpit" loading={busy} onClick={() => void cockpitOnly()}>
                    {t("ai.setup.nothing.cockpit")}
                  </Button>
                  <p className="text-sm text-text-muted">{t("ai.setup.nothing.cockpitHint")}</p>
                </div>
              </div>
            ) : null}
          </div>
        );
      case "provider":
        return (
          <div className="flex flex-col gap-3">
            <div data-ai-setup-provider className="w-72">
              <Select<string>
                id="ai-setup-provider"
                label={t("ai.setup.provider.title")}
                value={provider ?? ""}
                placeholder={t("ai.settings.provider.placeholder")}
                options={providerOptions}
                onValueChange={(value) => {
                  setDraft({ ...EMPTY_DRAFT, provider: value as AiProviderKind, featuresOff: draft.featuresOff });
                  setKeyDraft("");
                  setCheckResult(null);
                }}
              />
            </div>
            {provider && usesBaseUrl(provider) ? (
              <TextField
                label={t("ai.settings.baseUrl.title")}
                hint={provider === "openai_compatible" ? t("ai.settings.baseUrl.description") : t("ai.settings.baseUrl.descriptionLocal")}
                mono
                value={draft.baseUrl ?? ""}
                onChange={(event) => {
                  setDraft({ ...draft, baseUrl: event.target.value || null, checked: false });
                  setCheckResult(null);
                }}
              />
            ) : null}
            {provider && acceptsKey(provider) ? (
              <TextField
                type="password"
                autoComplete="off"
                label={t("ai.settings.key.title")}
                hint={t("ai.settings.key.description")}
                placeholder={t("ai.settings.key.placeholder")}
                value={keyDraft}
                onChange={(event) => {
                  setKeyDraft(event.target.value);
                  setDraft({ ...draft, checked: false });
                  setCheckResult(null);
                }}
              />
            ) : null}
            {provider ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button data-ai-setup-check loading={checking} onClick={() => void check(draft, keyDraft.trim() || null)}>
                  {t("ai.setup.provider.check")}
                </Button>
                {checkResult ? (
                  <p role={checkResult.ok ? "status" : "alert"} aria-live={checkResult.ok ? "polite" : "assertive"} className={cn("text-sm", checkResult.ok ? "text-success" : "text-danger")}>
                    {checkResult.text}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      case "model":
        return (
          <div className="flex flex-col gap-3">
            {provider && isCli(provider) ? (
              <TextField
                label={t("ai.setup.model.title")}
                hint={t("ai.setup.model.cliHint")}
                mono
                placeholder={t("ai.setup.model.cliDefault", { name: nameOf(provider) })}
                value={draft.model ?? ""}
                onChange={(event) => setDraft({ ...draft, model: event.target.value || null })}
              />
            ) : draft.models.length ? (
              <div data-ai-setup-model className="w-72">
                <Select<string>
                  id="ai-setup-model"
                  label={t("ai.setup.model.title")}
                  value={draft.model ?? ""}
                  placeholder={t("ai.setup.model.placeholder")}
                  options={draft.models.map((model) => ({ value: model, label: model }))}
                  onValueChange={(value) => setDraft({ ...draft, model: value })}
                />
              </div>
            ) : (
              <TextField label={t("ai.setup.model.title")} mono placeholder={t("ai.setup.model.placeholder")} value={draft.model ?? ""} onChange={(event) => setDraft({ ...draft, model: event.target.value || null })} />
            )}
          </div>
        );
      case "features":
        return (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-muted">{t("ai.setup.features.hint")}</p>
            <ul className="flex flex-col gap-1.5">
              {FEATURES.map((feature) => (
                <li key={feature} data-ai-setup-feature={feature} className="flex items-center justify-between gap-3">
                  <span id={`ai-setup-feature-${feature}`} className="text-sm text-text">
                    {t(`ai.features.${feature}`)}
                  </span>
                  <Switch
                    ariaLabelledBy={`ai-setup-feature-${feature}`}
                    checked={!draft.featuresOff.includes(feature)}
                    onCheckedChange={(on) => setDraft({ ...draft, featuresOff: featureToggle(draft.featuresOff, feature, on) })}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      case "done":
        return (
          <div data-ai-setup-done className="flex flex-col gap-2">
            <p className="text-sm text-text">{provider ? t(`ai.setup.where.${whereKind(provider)}`, { name: nameOf(provider) }) : null}</p>
            {repoId ? (
              <div>
                <Button variant="ghost" data-ai-setup-what-is-sent onClick={() => onDone({ kind: "whatIsSent", repoId })}>
                  {t("ai.setup.done.whatIsSent")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-text-muted">{t("ai.setup.done.noRepo")}</p>
            )}
          </div>
        );
    }
  })();

  const footer = (() => {
    switch (step) {
      case "search":
        // The same fragment shape as "found": React keeps this button's DOM node when the result
        // arrives, so the focus stays on it (a later answer never moves the focus).
        return (
          <>
            <Button data-autofocus data-ai-setup-cancel onClick={() => onDone(null)}>
              {t("ai.setup.cancel")}
            </Button>
          </>
        );
      case "found":
        return (
          <>
            <Button data-autofocus data-ai-setup-cancel onClick={() => onDone(null)}>
              {t("ai.setup.cancel")}
            </Button>
            <Button data-ai-setup-other onClick={otherChoice}>
              {t("ai.setup.other")}
            </Button>
            <Button variant="primary" data-ai-setup-primary disabled={!pick} loading={busy || checking} onClick={() => void continueWithPick()}>
              {pick && action === "turnOn" ? t("ai.setup.turnOnWith", { name: nameOf(pick.provider) }) : t("ai.setup.continue")}
            </Button>
          </>
        );
      case "provider":
        return (
          <>
            <Button data-ai-setup-back onClick={() => setStep("found")}>
              {t("ai.setup.back")}
            </Button>
            <Button variant="primary" data-ai-setup-primary disabled={!canLeaveProvider(draft)} onClick={() => setStep("model")}>
              {t("ai.setup.continue")}
            </Button>
          </>
        );
      case "model":
        return (
          <>
            <Button data-ai-setup-back onClick={() => setStep("provider")}>
              {t("ai.setup.back")}
            </Button>
            <Button variant="primary" data-ai-setup-primary disabled={!canLeaveModel(draft)} onClick={() => setStep("features")}>
              {t("ai.setup.continue")}
            </Button>
          </>
        );
      case "features":
        return (
          <>
            <Button data-ai-setup-back onClick={() => setStep("model")}>
              {t("ai.setup.back")}
            </Button>
            <Button variant="primary" data-ai-setup-primary loading={busy} onClick={() => void turnOn(draft)}>
              {t("ai.setup.turnOn")}
            </Button>
          </>
        );
      case "done":
        return (
          <Button variant="primary" data-ai-setup-close onClick={close}>
            {t("ai.setup.close")}
          </Button>
        );
    }
  })();

  return (
    <Dialog
      open
      size="lg"
      title={t("ai.setup.title")}
      description={t("ai.setup.intro")}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={footer}
    >
      <div data-ai-setup data-step={step} className="flex min-h-0 flex-col gap-3 overflow-auto">
        <p role="status" aria-live="polite" className="sr-only">
          {step === "search" ? t("ai.setup.searching") : step === "found" && overview ? t("ai.setup.foundCount", { count: overview.picks.length }) : ""}
        </p>
        {body}
      </div>
    </Dialog>
  );
}

/** Shows “Set up AI”; `null` = cancelled (nothing changed). */
export function showAiSetup(): Promise<SetupResult | null> {
  const repoId = activeRepoId();
  return showDialog<SetupResult>((done) => <SetupDialog repoId={repoId} onDone={done} />);
}
