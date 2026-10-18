/**
 * Settings › AI (global, the same for every profile): master switch, provider, address, key,
 * model, price, functions, exclusions, "What is sent?", confirmations, costs. Teilpaket 1b adds
 * the setup dialog with detection; until then provider, model and key are set up here directly.
 */
import { useEffect, useState } from "react";
import { core, type AiModelInfo, type AiProviderKind, type AiStatus, type Id, type Settings } from "../../../core";
import { qk, queryClient, useAiStatus, useAiUsage } from "../../../app/queries";
import { newJobId, runAction } from "../../../app/run";
import { showWhatIsSent } from "../../../app/ai/gate";
import { openAiSetup } from "../../../app/ai/open";
import { signInInTerminal } from "../../../app/ai/cliLogin";
import { formatUsd } from "../../../app/ai/preview";
import { Button } from "../../../ui/Button";
import { TextArea, TextField } from "../../../ui/Field";
import { toast } from "../../../ui/Feedback";
import { Select } from "../../../ui/Select";
import { Switch } from "../../../ui/Switch";
import { CommitText, SectionHeader, SettingRow, SettingsCard } from "../parts";
import { applySettings, fieldError } from "../settings";
import { acceptsKey, CLI_PROVIDERS, cliPathField, FEATURES, featureToggle, isCli, isLocal, parsePatterns, parsePricePair, parseUsd, patternsText, pricePairText, PROVIDERS, usesBaseUrl, withCliPath, withOwnPrice } from "../ai/model";
import { AiSearchCard } from "./AiSearch";
import { locale, t } from "../../../i18n";

const providerOptions = PROVIDERS.map((value) => ({ value: value as string, label: t(`ai.providers.${value}`) }));

const LOCAL_DEFAULTS: Partial<Record<AiProviderKind, string>> = { ollama: "http://127.0.0.1:11434", lmstudio: "http://127.0.0.1:1234/v1" };

export function AiSection({ settings, repoId }: { settings: Settings; repoId: Id | null }) {
  // This month's usage changes with every request: read it fresh when the section opens.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: qk.aiUsage });
  }, []);
  return (
    <section data-ai-settings>
      <SectionHeader title={t("ai.settings.title")}>{t("ai.settings.intro")}</SectionHeader>
      <SettingsCard title={t("ai.settings.masterCard")}>
        <SettingRow title={t("ai.settings.master.title")} description={settings.aiEnabled === null ? t("ai.settings.master.unset") : t("ai.settings.master.description")}>
          {(ids) => (
            <Switch
              id={ids.id}
              ariaDescribedBy={ids.descriptionId}
              checked={settings.aiEnabled === true}
              onCheckedChange={(checked) => {
                // Spec 1.3: switching on without a provider opens the setup; Cancel there changes nothing.
                if (checked && !settings.aiProvider) void openAiSetup();
                else void applySettings({ aiEnabled: checked });
              }}
            />
          )}
        </SettingRow>
        <SettingRow title={t("ai.settings.setup.title")} description={t("ai.settings.setup.description")}>
          {() => (
            <Button data-ai-setup-open onClick={() => void openAiSetup()}>
              {t("ai.settings.setup.button")}
            </Button>
          )}
        </SettingRow>
      </SettingsCard>
      <ProviderCard settings={settings} />
      <CliPathsCard settings={settings} />
      <SettingsCard title={t("ai.settings.featuresCard")}>
        {FEATURES.map((feature) => (
          <SettingRow key={feature} title={t(`ai.features.${feature}`)} description={t(`ai.featureHints.${feature}`)}>
            {(ids) => (
              <Switch
                id={ids.id}
                ariaDescribedBy={ids.descriptionId}
                checked={!settings.aiFeaturesOff.includes(feature)}
                onCheckedChange={(on) => void applySettings({ aiFeaturesOff: featureToggle(settings.aiFeaturesOff, feature, on) })}
              />
            )}
          </SettingRow>
        ))}
      </SettingsCard>
      <PrivacyCard settings={settings} repoId={repoId} />
      <AiSearchCard settings={settings} repoId={repoId} />
      <CostCard settings={settings} />
    </section>
  );
}

function priceText(status: AiStatus | undefined, provider: AiProviderKind): string {
  if (isLocal(provider)) return t("ai.settings.price.local");
  if (isCli(provider)) return t("ai.settings.cliPrice", { name: t(`ai.names.${provider}`) });
  const price = status?.price;
  if (!price) return t("ai.settings.price.unknown");
  const numbers = new Intl.NumberFormat(locale(), { maximumFractionDigits: 4 });
  const values = { input: numbers.format(price.inputUsdPerMtok), output: numbers.format(price.outputUsdPerMtok) };
  return price.source === "own" ? t("ai.settings.price.own", values) : t("ai.settings.price.known", { ...values, asOf: price.asOf ?? "" });
}

function ProviderCard({ settings }: { settings: Settings }) {
  const { data: status } = useAiStatus();
  const provider = settings.aiProvider;
  const [models, setModels] = useState<AiModelInfo[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkSignIn, setCheckSignIn] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  // Another provider: the models and the typed key of the previous one no longer apply.
  useEffect(() => {
    setModels(null);
    setCheckResult(null);
    setCheckError(null);
    setKeyDraft("");
    setCheckSignIn(false);
  }, [provider]);

  const check = async () => {
    if (!provider) return;
    setChecking(true);
    setCheckError(null);
    setCheckResult(null);
    const typedKey = keyDraft.trim() || null;
    const result = await runAction(
      t("ai.settings.check.action"),
      () => core.aiModels({ jobId: newJobId(), provider, baseUrl: settings.aiBaseUrl, key: typedKey, model: settings.aiModel }),
      { quiet: ["ai_not_configured", "ai_provider_unavailable", "ai_not_logged_in", "ai_unsupported_version", "offline", "timeout", "not_allowed", "unknown"] },
    );
    setChecking(false);
    // A signed-out command-line tool: offer its own sign-in in the terminal of the open repository.
    setCheckSignIn(!result.ok && result.error.code === "ai_not_logged_in" && isCli(provider));
    if (!result.ok) {
      setCheckError(result.error.message || t(`errors.${result.error.code}.text`));
      return;
    }
    setModels(result.value.models);
    setCheckResult(isCli(provider) ? t("ai.settings.cliCheckOk", { name: t(`ai.names.${provider}`) }) : t("ai.settings.check.ok", { count: result.value.models.length }));
    // The key is stored only after the provider accepted it.
    if (typedKey && acceptsKey(provider)) {
      const saved = await runAction(t("ai.settings.key.save"), () => core.aiKeySet({ provider, key: typedKey }));
      if (saved.ok) {
        setKeyDraft("");
        queryClient.setQueryData(qk.aiStatus, saved.value);
      }
    }
  };

  const removeKey = async () => {
    if (!provider) return;
    const result = await runAction(t("ai.settings.key.remove"), () => core.aiKeyRemove({ provider }));
    if (result.ok) {
      queryClient.setQueryData(qk.aiStatus, result.value);
      toast({ tone: "success", title: t("ai.settings.key.removed") });
    }
  };

  const modelOptions = (models ?? []).map((model) => ({ value: model.id, label: model.label === model.id ? model.id : `${model.label} (${model.id})` }));
  if (settings.aiModel && models && !models.some((model) => model.id === settings.aiModel)) modelOptions.unshift({ value: settings.aiModel, label: settings.aiModel });
  const own = settings.aiPrices.find((price) => price.model === settings.aiModel);

  return (
    <SettingsCard title={t("ai.settings.providerCard")}>
      <SettingRow title={t("ai.settings.provider.title")} description={t("ai.settings.provider.description")}>
        {(ids) => (
          <div className="w-72" data-ai-provider>
            <Select<string>
              id={ids.id}
              value={provider ?? ""}
              placeholder={t("ai.settings.provider.placeholder")}
              options={providerOptions}
              onValueChange={(value) => void applySettings({ aiProvider: value as AiProviderKind, aiModel: null })}
            />
          </div>
        )}
      </SettingRow>
      {provider && usesBaseUrl(provider) ? (
        <SettingRow title={t("ai.settings.baseUrl.title")} description={isLocal(provider) ? t("ai.settings.baseUrl.descriptionLocal") : t("ai.settings.baseUrl.description")}>
          {(ids) => (
            <CommitText
              id={ids.id}
              describedBy={ids.descriptionId}
              className="w-72"
              mono
              value={settings.aiBaseUrl ?? ""}
              placeholder={LOCAL_DEFAULTS[provider] ?? "https://"}
              onCommit={async (value) => fieldError(await applySettings({ aiBaseUrl: value.trim() || null }, { atField: true }))}
            />
          )}
        </SettingRow>
      ) : null}
      {provider && acceptsKey(provider) ? (
        <SettingRow stacked title={t("ai.settings.key.title")} description={t("ai.settings.key.description")}>
          {(ids) => (
            <div className="flex flex-wrap items-center gap-2">
              <span data-ai-key-hint className="text-sm text-text-muted">
                {status?.keyHint ? t("ai.settings.key.stored", { hint: status.keyHint }) : t("ai.settings.key.none")}
              </span>
              <div className="w-72">
                <TextField
                  id={ids.id}
                  type="password"
                  autoComplete="off"
                  aria-label={t("ai.settings.key.title")}
                  placeholder={t("ai.settings.key.placeholder")}
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
              </div>
              {status?.keyHint ? (
                <Button size="sm" variant="ghost" onClick={() => void removeKey()}>
                  {t("ai.settings.key.remove")}
                </Button>
              ) : null}
            </div>
          )}
        </SettingRow>
      ) : null}
      {provider ? (
        <SettingRow title={t("ai.settings.check.title")} description={t("ai.settings.check.description")}>
          {() => (
            <div className="flex flex-col items-end gap-1">
              <Button data-ai-check loading={checking} onClick={() => void check()}>
                {t("ai.settings.check.button")}
              </Button>
              {checkError ? (
                <p role="alert" className="max-w-72 text-right text-sm text-danger">
                  {checkError}
                </p>
              ) : null}
              {checkError && checkSignIn ? (
                <Button
                  size="sm"
                  data-ai-sign-in
                  onClick={() => {
                    // Without an open repository tab there is no terminal: say so instead.
                    if (!signInInTerminal(provider)) setCheckError(t("ai.settings.signInNoRepo"));
                  }}
                >
                  {t("ai.setup.cli.signIn")}
                </Button>
              ) : null}
              {!checkError && checkResult ? (
                <p role="status" aria-live="polite" className="text-sm text-success">
                  {checkResult}
                </p>
              ) : null}
            </div>
          )}
        </SettingRow>
      ) : null}
      {provider ? (
        <SettingRow title={t("ai.settings.model.title")} description={t("ai.settings.model.description")}>
          {(ids) =>
            models && modelOptions.length && !isCli(provider) ? (
              <div className="w-72" data-ai-model>
                <Select<string> id={ids.id} value={settings.aiModel ?? ""} placeholder={t("ai.settings.model.placeholder")} options={modelOptions} onValueChange={(value) => void applySettings({ aiModel: value })} />
              </div>
            ) : (
              <CommitText
                id={ids.id}
                describedBy={ids.descriptionId}
                className="w-72"
                mono
                value={settings.aiModel ?? ""}
                placeholder={isCli(provider) ? t("ai.settings.cliModel") : t("ai.settings.model.placeholder")}
                onCommit={async (value) => fieldError(await applySettings({ aiModel: value.trim() || null }, { atField: true }))}
              />
            )
          }
        </SettingRow>
      ) : null}
      {provider && (settings.aiModel || isCli(provider)) ? (
        <SettingRow title={t("ai.settings.price.title")} description={priceText(status, provider)}>
          {() => null}
        </SettingRow>
      ) : null}
      {provider && settings.aiModel && !isLocal(provider) && !isCli(provider) ? (
        <SettingRow title={t("ai.settings.ownPrice.title")} description={t("ai.settings.ownPrice.description")}>
          {(ids) => (
            <CommitText
              id={ids.id}
              describedBy={ids.descriptionId}
              className="w-32"
              mono
              value={pricePairText(own)}
              placeholder="2 / 10"
              validate={(value) => (parsePricePair(value) === "invalid" ? t("ai.settings.invalidAmount") : null)}
              onCommit={async (value) => {
                const pair = parsePricePair(value);
                if (pair === "invalid" || !settings.aiModel) return t("ai.settings.invalidAmount");
                return fieldError(await applySettings({ aiPrices: withOwnPrice(settings.aiPrices, settings.aiModel, pair) }, { atField: true }));
              }}
            />
          )}
        </SettingRow>
      ) : null}
    </SettingsCard>
  );
}

/** Own paths of Claude Code, Codex and opencode (spec 1.3: „Pfade der CLIs“); empty = found automatically. */
function CliPathsCard({ settings }: { settings: Settings }) {
  return (
    <div data-ai-cli-paths>
      <SettingsCard title={t("ai.settings.cliCard")}>
        {CLI_PROVIDERS.map((provider) => (
          <SettingRow
            key={provider}
            title={t(`ai.names.${provider}`)}
            description={provider === "opencode" ? `${t("ai.settings.cliPath.description")} ${t("ai.settings.opencodeNote")}` : t("ai.settings.cliPath.description")}
          >
            {(ids) => (
              <CommitText
                id={ids.id}
                describedBy={ids.descriptionId}
                className="w-72"
                mono
                value={settings.aiCliPaths[cliPathField(provider)] ?? ""}
                placeholder={t("ai.settings.cliPath.placeholder")}
                onCommit={async (value) => fieldError(await applySettings({ aiCliPaths: withCliPath(settings.aiCliPaths, provider, value) }, { atField: true }))}
              />
            )}
          </SettingRow>
        ))}
      </SettingsCard>
    </div>
  );
}

function PrivacyCard({ settings, repoId }: { settings: Settings; repoId: Id | null }) {
  const [draft, setDraft] = useState(patternsText(settings.aiExclude));
  useEffect(() => setDraft(patternsText(settings.aiExclude)), [settings.aiExclude]);
  const saveDraft = () => {
    const next = parsePatterns(draft);
    if (JSON.stringify(next) !== JSON.stringify(settings.aiExclude)) void applySettings({ aiExclude: next });
  };
  const askAgain = async () => {
    const result = await runAction(t("ai.settings.askAgain.button"), () => core.aiPreviewReset());
    if (result.ok) toast({ tone: "success", title: t("ai.settings.askAgain.done") });
  };
  return (
    <SettingsCard title={t("ai.settings.privacyCard")}>
      <SettingRow stacked title={t("ai.settings.exclude.title")} description={t("ai.settings.exclude.description")}>
        {(ids) => <TextArea id={ids.id} data-ai-exclude aria-label={t("ai.settings.exclude.title")} rows={4} spellCheck={false} className="font-mono text-code" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={saveDraft} />}
      </SettingRow>
      <SettingRow title={t("ai.settings.whatIsSent.title")} description={repoId ? t("ai.settings.whatIsSent.description") : t("ai.settings.whatIsSent.noRepo")}>
        {() => (
          <Button
            data-ai-what-is-sent
            disabled={!repoId}
            onClick={() => {
              if (repoId) void showWhatIsSent(repoId, "commit_message");
            }}
          >
            {t("ai.settings.whatIsSent.button")}
          </Button>
        )}
      </SettingRow>
      <SettingRow title={t("ai.settings.costThreshold.title")} description={t("ai.settings.costThreshold.description")}>
        {(ids) => (
          <CommitText
            id={ids.id}
            describedBy={ids.descriptionId}
            className="w-32"
            mono
            value={String(settings.aiConfirmCostUsd)}
            validate={(value) => (typeof parseUsd(value) === "number" ? null : t("ai.settings.invalidAmount"))}
            onCommit={async (value) => {
              const amount = parseUsd(value);
              return typeof amount === "number" ? fieldError(await applySettings({ aiConfirmCostUsd: amount }, { atField: true })) : t("ai.settings.invalidAmount");
            }}
          />
        )}
      </SettingRow>
      <SettingRow title={t("ai.settings.askAgain.title")} description={t("ai.settings.askAgain.description")}>
        {() => <Button onClick={() => void askAgain()}>{t("ai.settings.askAgain.button")}</Button>}
      </SettingRow>
    </SettingsCard>
  );
}

function CostCard({ settings }: { settings: Settings }) {
  const { data: usage } = useAiUsage();
  const numbers = new Intl.NumberFormat(locale());
  const usageText =
    !usage || usage.requests === 0
      ? t("ai.settings.usage.none")
      : t("ai.settings.usage.summary", { count: usage.requests, input: numbers.format(usage.inputTokens), output: numbers.format(usage.outputTokens), cost: formatUsd(usage.costUsd) });
  return (
    <SettingsCard title={t("ai.settings.costCard")}>
      <SettingRow title={t("ai.settings.limit.title")} description={t("ai.settings.limit.description")}>
        {(ids) => (
          <CommitText
            id={ids.id}
            describedBy={ids.descriptionId}
            className="w-32"
            mono
            placeholder={t("ai.settings.limit.placeholder")}
            value={settings.aiMonthlyLimitUsd === null ? "" : String(settings.aiMonthlyLimitUsd)}
            validate={(value) => (parseUsd(value) === "invalid" ? t("ai.settings.invalidAmount") : null)}
            onCommit={async (value) => {
              const amount = parseUsd(value);
              return amount === "invalid" ? t("ai.settings.invalidAmount") : fieldError(await applySettings({ aiMonthlyLimitUsd: amount }, { atField: true }));
            }}
          />
        )}
      </SettingRow>
      <SettingRow title={t("ai.settings.usage.title")} description={usageText}>
        {() => null}
      </SettingRow>
    </SettingsCard>
  );
}
