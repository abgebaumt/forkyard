/**
 * “New coding agent”: template (only found ones can be chosen), task, branch `agent/<short name>`
 * (suggested from the task, editable, checked live), base (default: the checked-out branch), the
 * worktree folder as a preview, the agent configurations of the base commit as a notice and the
 * switch “without prompts” with its warning. Ctrl+Enter starts. The dialog stays open until the core
 * has started the agent and shows its error otherwise.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { core, type AgentSuggestion, type Id } from "../../core";
import { showDialog } from "../../app/dialogs";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { describeError } from "../../app/errors";
import { qk, queryClient, useAgentTemplates, useAgents, useRefs, useStatus } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { TextArea, TextField } from "../../ui/Field";
import { Select, type SelectOption } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { t } from "../../i18n";
import { agentCounts, defaultTemplateId, manyAgentsHint, startBlocker, startLabel, templateOptionLabel, templateSignIn, unattendedChoice, type StartDraft } from "./model";
import { startAgent } from "./session";

const CHECK_DELAY_MS = 250;

function StartDialog({ repoId, tabId, onDone }: { repoId: Id; tabId: Id; onDone: (value: true | null) => void }) {
  const formId = useId();
  const switchId = useId();
  const templates = useAgentTemplates();
  const agents = useAgents(repoId);
  const refs = useRefs(repoId);
  const { data: status } = useStatus(repoId);
  const list = useMemo(() => templates.data ?? [], [templates.data]);
  const current = status?.head.kind === "branch" ? status.head.branch : "HEAD";
  const [draft, setDraft] = useState<StartDraft>({ templateId: null, task: "", branch: "", base: "", unattended: false });
  const [branchTouched, setBranchTouched] = useState(false);
  const [suggestion, setSuggestion] = useState<AgentSuggestion | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const check = useRef(0);
  const base = draft.base || current;

  useEffect(() => {
    if (draft.templateId === null && templates.data) setDraft((d) => ({ ...d, templateId: defaultTemplateId(templates.data) }));
  }, [templates.data, draft.templateId]);

  useEffect(() => {
    const run = ++check.current;
    setChecking(true);
    const timer = window.setTimeout(() => {
      core
        .agentSuggest({ repoId, task: draft.task, branch: branchTouched ? draft.branch : null, base })
        .then((next) => {
          if (run !== check.current) return;
          setSuggestion(next);
          if (!branchTouched) setDraft((d) => (d.branch === next.branch ? d : { ...d, branch: next.branch }));
          setFailure(null);
        })
        .catch((error: unknown) => {
          if (run !== check.current) return;
          setSuggestion(null);
          setFailure(describeError(error).text);
        })
        .finally(() => {
          if (run === check.current) setChecking(false);
        });
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [repoId, draft.task, draft.branch, base, branchTouched]);

  const template = list.find((item) => item.id === draft.templateId);
  const unattended = unattendedChoice(template);
  const signIn = templateSignIn(template);
  const effective: StartDraft = { ...draft, base, unattended: draft.unattended && unattended.available };
  const blocker = startBlocker(effective, list, suggestion, checking);
  const running = agentCounts(agents.data ?? []).running;
  const templateOptions: SelectOption[] = list.map((item) => ({ value: item.id, label: templateOptionLabel(item), disabled: item.path === null }));
  const baseOptions: SelectOption[] = useMemo(() => {
    const names = (refs.data?.locals ?? []).map((ref) => ref.name);
    const all = names.includes(base) || base === "HEAD" ? names : [base, ...names];
    return [...(current === "HEAD" ? [{ value: "HEAD", label: "HEAD" }] : []), ...all.map((name) => ({ value: name, label: name }))];
  }, [refs.data, base, current]);

  const submit = async () => {
    if (blocker || busy || !suggestion || !effective.templateId) return;
    setBusy(true);
    setFailure(null);
    try {
      await startAgent({ repoId, tabId, templateId: effective.templateId, task: effective.task, branch: effective.branch.trim(), base, unattended: effective.unattended, shortName: suggestion.shortName });
      onDone(true);
    } catch (error) {
      setFailure(describeError(error).text);
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
      title={t("agents.start.title")}
      description={t("agents.start.description")}
      size="lg"
      footer={
        <>
          <span className="mr-auto text-sm text-text-muted">{t("agents.start.shortcutHint")}</span>
          <Button variant="ghost" disabled={busy} onClick={() => onDone(null)}>
            {t("agents.start.cancel")}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={Boolean(blocker)} title={blocker ?? undefined} data-action="start-agent">
            {startLabel(effective.unattended)}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {list.length > 0 && list.every((item) => item.path === null) ? <Banner tone="warning" title={t("agents.start.noTemplates")} /> : null}
        {draft.templateId ? (
          <Select
            label={t("agents.start.template")}
            value={draft.templateId}
            options={templateOptions}
            onValueChange={(templateId) => setDraft((d) => ({ ...d, templateId, unattended: false }))}
            hint={template?.path ? t("agents.start.where", { path: template.path }) : undefined}
          />
        ) : null}
        {template && signIn ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-text" data-field="sign-in">
            <span className="min-w-0 flex-1">{t("agents.start.signInHint", { name: template.name })}</span>
            <Button
              size="sm"
              data-agent-sign-in=""
              onClick={() => {
                // The terminal sits behind this dialog; the list is asked again once it opens next time.
                onDone(null);
                void queryClient.invalidateQueries({ queryKey: qk.agentTemplates });
                signInInTerminal(signIn);
              }}
            >
              {t("ai.setup.cli.signIn")}
            </Button>
          </div>
        ) : null}
        <TextArea
          label={t("agents.start.task")}
          hint={t("agents.start.taskHint")}
          value={draft.task}
          rows={4}
          autoFocus
          data-field="task"
          onChange={(event) => setDraft((d) => ({ ...d, task: event.target.value }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t("agents.start.branch")}
            value={draft.branch}
            mono
            data-field="branch"
            error={!checking && suggestion?.branchProblem ? suggestion.branchProblem : undefined}
            onChange={(event) => {
              setBranchTouched(true);
              setDraft((d) => ({ ...d, branch: event.target.value }));
            }}
          />
          <Select label={t("agents.start.base")} value={base} options={baseOptions} onValueChange={(next) => setDraft((d) => ({ ...d, base: next }))} />
        </div>
        <p className="text-sm text-text-muted">
          {t("agents.start.folder")}: <span className="selectable font-mono text-code break-all text-text" data-field="folder">{suggestion?.path ?? "…"}</span>
        </p>
        {suggestion && suggestion.configs.length > 0 ? (
          <p className="text-sm text-text-muted" data-field="configs">
            {t("agents.start.configs", { list: suggestion.configs.join(", ") })}
          </p>
        ) : null}
        <div className="flex items-start gap-3">
          <Switch
            id={switchId}
            checked={effective.unattended}
            disabled={!unattended.available}
            ariaDescribedBy={`${switchId}-hint`}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, unattended: checked }))}
          />
          <div className="min-w-0">
            <label htmlFor={switchId} className="text-base font-medium text-text">
              {t("agents.start.unattended")}
            </label>
            <p id={`${switchId}-hint`} className="text-sm text-text-muted">
              {unattended.reason ?? t("agents.start.unattendedHint")}
            </p>
          </div>
        </div>
        {effective.unattended ? (
          <div data-warning="unattended">
            <Banner tone="warning" title={t("agents.start.warning")}>
              {unattended.note}
            </Banner>
          </div>
        ) : null}
        {manyAgentsHint(running) ? <p className="text-sm text-warning">{manyAgentsHint(running)}</p> : null}
        {failure ? (
          <div role="alert">
            <Banner tone="danger" title={failure} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Opens the start dialog for the repository in the tab; resolves once an agent was started (or null). */
export function openAgentStart(repoId: Id, tabId: Id): Promise<true | null> {
  useAppStore.getState().closeOverlay();
  return showDialog<true>((done) => <StartDialog repoId={repoId} tabId={tabId} onDone={done} />);
}
