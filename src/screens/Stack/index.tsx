/**
 * Stacked pull requests (Paket 8.1) in the centre.
 *
 * For a branch that is no part of a stack: its commits oldest first, grouped into the planned parts.
 * The user cuts with the keyboard (↑/↓, Home/End select · Space splits after the commit or joins
 * the parts) or with "Split after this commit" / "Join with the next part", optionally takes the
 * AI's suggestion, names each part and its pull request, checks every part with the repository's
 * test command in a temporary worktree and creates the branches (no checkout, one undo step).
 *
 * For a part of a stack: the parts with the branch their pull request goes into, "Restack" when a
 * lower part changed (with the parts Git leaves behind), "Push all parts …" (one atomic push) and
 * "Create pull requests …" (each onto the part below) – both marked as steps outside Forkyard that
 * can't be undone here and confirmed one by one. Esc goes back.
 */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { core, type Id, type StackCheckResult, type StackCheckState, type StackStatus } from "../../core";
import { hostKindLabels } from "../../app/actions/hostTypes";
import { cachedPrForBranch, hostLink, refreshPullRequests } from "../../app/actions/pullrequests";
import { confirm, hasOpenDialog } from "../../app/dialogs";
import { describeError, toCoreError } from "../../app/errors";
import { hasOpenMenu } from "../../app/menus/host";
import { qk, useRefs, useRepoSettings, useStackStatus } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { useAppStore } from "../../app/store";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/Field";
import { EmptyState, toast } from "../../ui/Feedback";
import { Select } from "../../ui/Select";
import { cn } from "../../ui/cn";
import { goBack } from "../FileView/nav";
import { BackButton, isPlainEscape, ownsKey } from "../FileView/parts";
import { t } from "../../i18n";
import {
  allPushed,
  baseOptions,
  checkTone,
  cutsOf,
  defaultBase,
  firstWithoutPr,
  isCutAfter,
  listKey,
  needsForce,
  prParts,
  prTargets,
  ranges,
  rejectedRefs,
  singlePart,
  titleOf,
  toggleCut,
  type CheckTone,
  type DraftPart,
} from "./model";
import { pushStack } from "./push";
import { useStackSuggest } from "./Suggest";

/** Titles typed before "Create", for the pull requests of that stack (in memory, per repository). */
const rememberedTitles = new Map<Id, Record<string, string>>();

const DOT: Record<CheckTone, string> = { accent: "bg-accent", success: "bg-success", danger: "bg-danger", warning: "bg-warning" };

const STATE_WORD: Record<StackCheckState | "running", () => string> = {
  running: () => t("pullRequest.stack.checkState.running"),
  passed: () => t("pullRequest.stack.checkState.passed"),
  failed: () => t("pullRequest.stack.checkState.failed"),
  timed_out: () => t("pullRequest.stack.checkState.timed_out"),
};

const shortRef = (name: string) => name.replace(/^refs\/(heads|remotes)\//, "");

export interface StackViewProps {
  repoId: Id;
  tabId: Id;
  branch: string;
}

export function StackView({ repoId, tabId, branch }: StackViewProps) {
  const refs = useRefs(repoId);
  const status = useStackStatus(repoId, branch);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlainEscape(event)) return;
      if (!ownsKey(event, hasOpenDialog() || hasOpenMenu() || Boolean(useAppStore.getState().overlay))) return;
      event.preventDefault();
      goBack(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabId]);

  const exists = refs.data ? refs.data.locals.some((ref) => ref.name === branch) : true;
  let body: ReactNode;
  if (!exists) {
    body = (
      <Centered>
        <div data-stack-gone="">
          <EmptyState title={t("pullRequest.stack.goneTitle")} action={<Button onClick={() => goBack(tabId)}>{t("pullRequest.stack.back")}</Button>}>
            {t("pullRequest.stack.goneBody")}
          </EmptyState>
        </div>
      </Centered>
    );
  } else if (status.isPending) {
    body = (
      <Centered>
        <p role="status" className="text-sm text-text-muted">
          {t("pullRequest.stack.loading")}
        </p>
      </Centered>
    );
  } else if (status.isError) {
    body = (
      <Centered>
        <EmptyState title={t("pullRequest.stack.errorTitle")} action={<Button onClick={() => void status.refetch()}>{t("pullRequest.stack.retry")}</Button>}>
          {describeError(status.error).text}
        </EmptyState>
      </Centered>
    );
  } else if (status.data) {
    body = <Existing repoId={repoId} tabId={tabId} status={status.data} />;
  } else {
    body = <Planner repoId={repoId} tabId={tabId} branch={branch} />;
  }

  return (
    <section aria-label={t("pullRequest.stack.ariaLabel")} data-screen="stack" className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <h2 className="min-w-0 truncate text-md font-medium text-text">{t("pullRequest.stack.title", { branch })}</h2>
        <div className="flex-1" />
        <BackButton tabId={tabId} />
      </header>
      {body}
    </section>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-sunken">{children}</div>;
}

function CheckLine({ state, result }: { state: StackCheckState | "running"; result?: StackCheckResult }) {
  return (
    <div data-stack-check-state={state} className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-sm text-text">
        <span className={cn("inline-flex size-2 shrink-0 rounded-full", DOT[checkTone(state)])} aria-hidden />
        {STATE_WORD[state]()}
        {result && result.exitCode !== null && state !== "passed" ? ` · ${t("pullRequest.stack.checkExit", { code: result.exitCode })}` : ""}
      </p>
      {result?.output ? (
        <pre tabIndex={0} aria-label={t("pullRequest.stack.checkOutput")} className="selectable max-h-32 overflow-auto rounded-sm bg-surface-sunken px-2 py-1 font-mono text-code whitespace-pre-wrap text-text">
          {result.output}
        </pre>
      ) : null}
    </div>
  );
}

function Planner({ repoId, tabId, branch }: StackViewProps) {
  const queryClient = useQueryClient();
  const refs = useRefs(repoId).data;
  const repoSettings = useRepoSettings(repoId).data;
  const link = hostLink(repoId);
  const hostRemote = link.state === "unknown" ? null : (link.repo?.remote ?? null);
  const hostDefault = link.state === "connected" ? link.repo.defaultBranch : null;
  const [chosenBase, setChosenBase] = useState<string | null>(null);
  const base = chosenBase ?? defaultBase(refs, hostRemote, hostDefault, branch);
  const [parts, setParts] = useState<DraftPart[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [checks, setChecks] = useState<StackCheckResult[] | null>(null);
  const [checkJob, setCheckJob] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const idBase = useId();

  const cuts = parts ? cutsOf(parts) : [];
  const plan = useQuery({
    queryKey: qk.stackPlan(repoId, branch, base ?? "", JSON.stringify(cuts)),
    queryFn: () => core.stackPlan({ repoId, branch, base: base!, cuts }),
    enabled: Boolean(base),
    placeholderData: keepPreviousData,
  });
  const data = plan.data;
  const commits = data?.commits ?? [];
  const loaded = Boolean(data);

  useEffect(() => {
    if (data && parts === null) setParts(singlePart(data.commits.length));
  }, [data, parts]);
  // The list gets the focus once it is there – unless a dialog, menu or overlay is open.
  useEffect(() => {
    if (loaded && viewMayTakeFocus()) listRef.current?.focus({ preventScroll: true });
  }, [loaded]);

  const suggest = useStackSuggest({
    repoId,
    branch,
    base,
    commitCount: commits.length,
    parts,
    onInsert: (next) => {
      setParts(next);
      setChecks(null);
    },
  });
  const edit = (next: DraftPart[]) => {
    setParts(next);
    setChecks(null);
    suggest.clearSuggested();
  };
  const toggle = (index: number) => {
    if (parts) edit(toggleCut(parts, index + 1, commits.length));
  };
  const change = (index: number, patch: Partial<DraftPart>) => {
    if (parts) setParts(parts.map((part, at) => (at === index ? { ...part, ...patch, why: null } : part)));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = listKey(event.key, event.ctrlKey || event.metaKey || event.altKey || event.shiftKey, selected, commits.length);
    if (!action) return;
    event.preventDefault();
    if (action.kind === "move") setSelected(action.index);
    else toggle(selected);
  };

  const check = async () => {
    if (!base) return;
    const jobId = newJobId();
    setCheckJob(jobId);
    setChecks(null);
    setCheckError(null);
    try {
      setChecks(await core.stackCheck({ repoId, jobId, branch, base, cuts }));
    } catch (error) {
      if (toCoreError(error).code !== "cancelled") setCheckError(describeError(error).text);
    } finally {
      setCheckJob(null);
    }
  };

  const create = async () => {
    if (!data || !parts || !base) return;
    const result = await runAction(
      t("pullRequest.stack.createAction"),
      () => core.stackCreate({ repoId, branch, base, cuts, expectedBase: data.baseSha, expectedTip: data.tip }),
      { busyKey: `${repoId}:stack:create`, success: (status) => t("pullRequest.stack.created", { count: status.parts.length }) },
    );
    if (!result.ok) {
      if (result.error.code === "stale_state") void plan.refetch();
      return;
    }
    const created = result.value;
    const firsts = ranges(parts);
    rememberedTitles.set(repoId, Object.fromEntries(created.parts.map((part, index) => [part.branch, parts[index] ? titleOf(parts[index]!, commits, firsts[index]!.first) : ""])));
    const top = created.parts[created.parts.length - 1]!.branch;
    queryClient.setQueryData(qk.stackStatus(repoId, top), created);
    // The view checks that its branch exists in the refs list: load the new branches first.
    await queryClient.refetchQueries({ queryKey: qk.refs(repoId) });
    useAppStore.getState().setCenter(tabId, { kind: "stack", branch: top });
  };

  if (!base) {
    return (
      <Centered>
        <EmptyState title={t("pullRequest.stack.noBase")}>{t("pullRequest.stack.noBaseHint")}</EmptyState>
      </Centered>
    );
  }
  if (!data && plan.isError) {
    return (
      <Centered>
        <EmptyState title={t("pullRequest.stack.errorTitle")} action={<Button onClick={() => void plan.refetch()}>{t("pullRequest.stack.retry")}</Button>}>
          {describeError(plan.error).text}
        </EmptyState>
      </Centered>
    );
  }
  if (!data || !parts) {
    return (
      <Centered>
        <p role="status" className="text-sm text-text-muted">
          {t("pullRequest.stack.loading")}
        </p>
      </Centered>
    );
  }

  const current = !plan.isPlaceholderData && data.parts.length === parts.length;
  const createBlock = parts.length < 2 ? t("pullRequest.stack.needTwo") : data.parts.some((part) => part.problem) ? t("pullRequest.stack.fixNames") : null;
  const testCommand = repoSettings?.testCommand?.trim() ?? "";
  const cutAtSelection = isCutAfter(parts, selected + 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="w-64 min-w-0">
          <Select
            ariaLabel={t("pullRequest.stack.base")}
            value={base}
            options={baseOptions(refs, branch)}
            onValueChange={(value) => {
              setChosenBase(value);
              setParts(null);
              setChecks(null);
            }}
          />
        </div>
        <Button size="sm" variant="ghost" data-stack-split="" disabled={!cutAtSelection && selected >= commits.length - 1} onClick={() => toggle(selected)}>
          {cutAtSelection ? t("pullRequest.stack.removeCut") : t("pullRequest.stack.cutHere")}
        </Button>
        {suggest.control}
        <div className="flex-1" />
        {checkJob ? (
          <Button size="sm" data-stack-check-cancel="" onClick={() => void core.jobCancel({ jobId: checkJob }).catch(() => undefined)}>
            {t("ai.state.cancel")}
          </Button>
        ) : (
          <Button size="sm" data-stack-check="" disabled={!testCommand || !current} title={testCommand ? t("pullRequest.stack.checkHint") : t("pullRequest.stack.checkNoCommand")} onClick={() => void check()}>
            {t("pullRequest.stack.check")}
          </Button>
        )}
        <Button size="sm" variant="primary" data-stack-create="" disabled={!current || Boolean(createBlock) || Boolean(checkJob)} onClick={() => void create()}>
          {t("pullRequest.stack.create")}
        </Button>
      </div>
      <div className="flex flex-col gap-1 border-b border-border bg-surface px-3 py-2">
        {suggest.notices}
        {suggest.suggested ? (
          <p data-stack-suggested="" className="text-sm text-text-muted">
            {t("pullRequest.stack.suggested")}
          </p>
        ) : null}
        <p className="text-sm text-text-muted">{createBlock ?? t("pullRequest.stack.createHint", { count: parts.length })}</p>
        <p id={`${idBase}-keys`} className="text-sm text-text-muted">
          {t("pullRequest.stack.keys")}
        </p>
        {testCommand ? null : <p className="text-sm text-text-muted">{t("pullRequest.stack.checkNoCommand")}</p>}
        <p role="status" aria-live="polite" className="text-sm text-text-muted">
          {checkJob ? t("pullRequest.stack.checkRunning") : ""}
        </p>
        {checkError ? (
          <p role="alert" className="text-sm text-danger">
            {checkError}
          </p>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <ol aria-label={t("pullRequest.stack.partsLabel")} className="w-80 shrink-0 overflow-y-auto border-r border-border bg-surface px-3 py-2">
          {data.parts.map((part, index) => {
            const draft = parts[index];
            if (!draft) return null;
            const result = checks?.find((item) => item.part === part.number);
            return (
              <li key={part.number} data-stack-part={part.number} className="flex flex-col gap-2 border-b border-border py-2 last:border-b-0">
                <p className="text-sm font-medium text-text">
                  {t("pullRequest.stack.part", { number: part.number })}{" "}
                  <span className="font-normal text-text-muted">{t("pullRequest.stack.commits", { count: part.end - part.first + 1 })}</span>
                </p>
                <code data-stack-branch="" className="selectable font-mono text-code break-all text-text-muted">
                  {part.branch}
                </code>
                <TextField
                  label={t("pullRequest.stack.partName", { number: part.number })}
                  value={draft.name}
                  placeholder={commits[part.first - 1]?.subject ?? ""}
                  data-stack-name={part.number}
                  onChange={(event) => change(index, { name: event.currentTarget.value })}
                />
                <TextField
                  label={t("pullRequest.stack.partTitle", { number: part.number })}
                  value={titleOf(draft, commits, part.first)}
                  data-stack-title={part.number}
                  onChange={(event) => change(index, { title: event.currentTarget.value })}
                />
                {draft.why ? <p className="text-sm text-text-muted">{draft.why}</p> : null}
                {part.problem ? (
                  <p role="alert" data-stack-problem={part.number} className="text-sm break-words text-danger">
                    {part.problem}
                  </p>
                ) : null}
                {checkJob ? <CheckLine state="running" /> : result ? <CheckLine state={result.state} result={result} /> : null}
              </li>
            );
          })}
        </ol>
        <div
          ref={listRef}
          role="listbox"
          aria-label={t("pullRequest.stack.listLabel")}
          aria-describedby={`${idBase}-keys`}
          aria-activedescendant={commits.length ? `${idBase}-${selected}` : undefined}
          tabIndex={0}
          data-stack-list=""
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {data.parts.map((part) => (
            <div key={part.number} role="group" aria-label={t("pullRequest.stack.part", { number: part.number })}>
              <div role="presentation" className="sticky top-0 bg-surface-sunken px-3 py-1 text-sm font-medium text-text-muted">
                {t("pullRequest.stack.part", { number: part.number })} · {part.branch}
              </div>
              {commits.slice(part.first - 1, part.end).map((commit, offset) => {
                const index = part.first - 1 + offset;
                return (
                  <div
                    key={commit.sha}
                    id={`${idBase}-${index}`}
                    role="option"
                    aria-selected={index === selected}
                    data-commit={index + 1}
                    onClick={() => setSelected(index)}
                    onDoubleClick={() => toggle(index)}
                    className={cn("flex items-center gap-2 px-3 py-1 text-sm text-text", index === selected && "bg-accent-surface")}
                  >
                    <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                    <span className="font-mono text-code text-text-muted">{commit.sha.slice(0, 7)}</span>
                    <span className="text-text-muted">{t("pullRequest.stack.stat", { added: commit.added, deleted: commit.deleted })}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Existing({ repoId, status }: { repoId: Id; tabId: Id; status: StackStatus }) {
  const refs = useRefs(repoId).data;
  const link = hostLink(repoId);
  const remote = (link.state === "unknown" ? null : link.repo?.remote) ?? "origin";
  const hostName = link.state !== "unknown" && link.repo?.kind ? hostKindLabels[link.repo.kind] : "";
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [prNote, setPrNote] = useState<string | null>(null);
  const locals = refs?.locals ?? [];
  const branches = status.parts.map((part) => part.branch);
  const force = needsForce(status, locals);
  const targets = prTargets(status);
  const from = firstWithoutPr(status, (name) => Boolean(cachedPrForBranch(repoId, name)));
  const restackIndex = status.parts.findIndex((part) => !part.containsParent);
  const prBlock =
    link.state !== "connected"
      ? t("pullRequest.stack.prsNoHost")
      : !allPushed(status, locals, remote)
        ? t("pullRequest.stack.prsNotPushed")
        : from >= status.parts.length
          ? t("pullRequest.stack.prsAllOpen")
          : null;

  const push = async () => {
    const ok = await confirm({
      title: t("pullRequest.stack.pushTitle", { count: branches.length, remote }),
      body: force ? t("pullRequest.stack.pushForceBody") : t("pullRequest.stack.pushBody"),
      confirmLabel: t("pullRequest.stack.pushConfirm"),
      details: branches,
      detailsLabel: t("pullRequest.stack.branchesLabel"),
      detailsWrap: true,
    });
    if (!ok) return;
    const result = await pushStack(repoId, branches, remote, force);
    if (!result.ok) return;
    const refused = rejectedRefs(result.value);
    setPushNote(refused.length ? t("pullRequest.stack.pushRejected", { reasons: refused.join("; ") }) : null);
    if (!refused.length) toast({ tone: "success", title: t("pullRequest.stack.pushed") });
  };

  const createPrs = async () => {
    const parts = prParts(status, rememberedTitles.get(repoId) ?? {});
    const ok = await confirm({
      title: t("pullRequest.stack.prsTitle", { count: parts.length - from, host: hostName }),
      body: t("pullRequest.stack.prsBody"),
      confirmLabel: t("pullRequest.stack.prsConfirm"),
      details: parts.slice(from).map((part, offset) => `${part.branch} → ${targets[from + offset]}: ${part.title}`),
      detailsLabel: t("pullRequest.stack.prsLabel"),
      detailsWrap: true,
    });
    if (!ok) return;
    const result = await runAction(t("pullRequest.stack.prsAction"), () => core.stackPrsCreate({ repoId, target: status.baseName, parts, from, remote }), {
      busyKey: `${repoId}:stack:prs`,
    });
    refreshPullRequests(repoId);
    if (!result.ok) return;
    const { created, failed } = result.value;
    if (created.length) toast({ tone: "success", title: t("pullRequest.stack.prsDone", { count: created.length }) });
    setPrNote(failed ? `${t("pullRequest.stack.prsFailed", { part: failed.part })} ${describeError(failed.error).text}` : null);
  };

  const restack = async () => {
    const step = status.restack;
    if (!step) return;
    await runAction(t("pullRequest.stack.restackAction"), () => core.stackRestack({ repoId, branch: status.parts[0]!.branch, expectedTop: step.topTip }), {
      busyKey: `${repoId}:stack:restack`,
    });
  };

  return (
    <div data-stack-existing="" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-surface px-3 py-2">
      <p className="text-sm text-text-muted">{t("pullRequest.stack.stackOn", { base: status.baseName })}</p>
      {status.restack ? (
        <div role="status" aria-live="polite" data-stack-restack-needed="" className="flex flex-col gap-1 rounded-md border border-border bg-warning-surface px-3 py-2">
          <p className="text-sm text-text">{t("pullRequest.stack.restack", { number: restackIndex + 1 })}</p>
          <p className="text-sm text-text-muted">{t("pullRequest.stack.restackHint", { top: status.restack.top, onto: shortRef(status.restack.onto) })}</p>
          {status.restack.leftBehind.length ? (
            <p data-stack-left-behind="" className="text-sm text-text">
              {t("pullRequest.stack.leftBehind", { branches: status.restack.leftBehind.join(", ") })}
            </p>
          ) : null}
          {status.restack.blocked ? (
            <p role="alert" className="text-sm text-danger">
              {status.restack.blocked}
            </p>
          ) : (
            <div>
              <Button size="sm" data-stack-restack="" onClick={() => void restack()}>
                {t("pullRequest.stack.restackAction")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p data-stack-up-to-date="" className="text-sm text-text-muted">
          {t("pullRequest.stack.upToDate")}
        </p>
      )}
      <ol aria-label={t("pullRequest.stack.partsLabel")} className="flex flex-col gap-2">
        {status.parts.map((part, index) => {
          const pr = cachedPrForBranch(repoId, part.branch);
          return (
            <li key={part.branch} data-stack-part={index + 1} className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2">
              <p className="text-sm font-medium text-text">
                {t("pullRequest.stack.part", { number: index + 1 })} · <span className="selectable font-mono text-code">{part.branch}</span>
              </p>
              <p className="text-sm text-text-muted">
                {t("pullRequest.stack.partTarget", { target: targets[index] })}
                {pr ? ` · ${t("pullRequest.stack.prOpen", { number: pr.number })}` : ""}
              </p>
              {part.containsParent ? null : <p className="text-sm text-text">{t("pullRequest.stack.needsRestack")}</p>}
              {part.worktreePath ? <p className="text-sm text-text-muted">{t("pullRequest.stack.checkedOut", { path: part.worktreePath })}</p> : null}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button data-stack-push="" onClick={() => void push()}>
          {t("pullRequest.stack.push")}
        </Button>
        <span className="text-sm text-text-muted">
          {t("pullRequest.stack.external")} · {t("pullRequest.stack.irreversible")}
        </span>
        <Button data-stack-prs="" disabled={Boolean(prBlock)} onClick={() => void createPrs()}>
          {t("pullRequest.stack.prs")}
        </Button>
        <span className="text-sm text-text-muted">{prBlock ?? `${t("pullRequest.stack.external")} · ${t("pullRequest.stack.irreversible")}`}</span>
      </div>
      {pushNote ? (
        <p role="alert" data-stack-push-error="" className="text-sm text-danger">
          {pushNote}
        </p>
      ) : null}
      {prNote ? (
        <p role="alert" data-stack-pr-error="" className="text-sm text-danger">
          {prNote}
        </p>
      ) : null}
    </div>
  );
}
