/**
 * "Open review comments" in the pull request view (8.2): per open thread file, lines and comments.
 * "Suggest fix" (only while AI is on for this function and repository) asks for a replacement of the
 * commented lines, shown as a small diff with the reason; "Take over as fixup" commits it as
 * `fixup! <target>` on the checked-out pull request branch ("Check out branch" first otherwise). "Reply"
 * posts an editable answer – never automatically. After a takeover the section offers to squash the
 * fixups in the interactive rebase (autosquash). AI errors stay inline; a late answer never moves focus.
 */
import { useEffect, useRef, useState } from "react";
import { core, type AiPreview, type AiReviewFix, type Id, type ReviewFixApplied, type ReviewThread } from "../../core";
import { confirmSend } from "../../app/ai/gate";
import { openAiSettings } from "../../app/ai/open";
import { showAiPreview } from "../../app/ai/PreviewDialog";
import { errorView, loadingView, type AiErrorView } from "../../app/ai/requestState";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { describeHostError, hostApi, type HostCapabilities, type PrDetails } from "../../app/actions/hostTypes";
import { runHostAction } from "../../app/actions/hosts";
import { checkoutPr, prBusyKeys } from "../../app/actions/pullrequests";
import { shortSha } from "../../app/format";
import { qk, queryClient, useAiStatus, usePrReviewThreads, useRepoSettings } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Banner, toast } from "../../ui/Feedback";
import { TextArea } from "../../ui/Field";
import { Avatar } from "../../ui/Git";
import { Select } from "../../ui/Select";
import { cn } from "../../ui/cn";
import { locale, t } from "../../i18n";
import { SafeMarkdown } from "./Markdown";
import { BlockTitle, When, userName } from "./parts";
import { REVIEW_FEATURE, fixAvailability, replyDraft, splitThreads, targetHint, threadLines } from "./reviewModel";

type FailedView = Exclude<AiErrorView, { kind: "cancelled" }>;
type Run = { kind: "idle" } | { kind: "running"; startedAt: number } | { kind: "failed"; view: FailedView } | { kind: "error"; text: string };
type Ai = { visible: boolean; opensSetup: boolean; local: boolean };

/** The hunk of a suggestion; the sign and a hidden word say what a line is, not only the colour. */
function DiffLines({ fix }: { fix: AiReviewFix }) {
  return (
    <pre data-review-fix-diff="" className="selectable m-0 overflow-x-auto rounded-sm border border-border bg-surface-sunken py-1 font-mono text-code">
      {fix.lines.map((line, index) => (
        <div key={index} data-review-fix-line={line.kind} className={cn("flex gap-2 px-2", line.kind === "added" && "bg-diff-added", line.kind === "removed" && "bg-diff-removed")}>
          <span aria-hidden className="w-10 shrink-0 text-right text-text-muted">
            {line.kind === "added" ? line.new : line.old}
          </span>
          <span aria-hidden className="w-3 shrink-0 text-text-muted">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
          </span>
          {line.kind === "added" ? <span className="sr-only">{t("pullRequest.view.reviewThreads.added")}</span> : null}
          {line.kind === "removed" ? <span className="sr-only">{t("pullRequest.view.reviewThreads.removed")}</span> : null}
          <span className="whitespace-pre">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

function FailedNote({ view, onAgain, onLook }: { view: FailedView; onAgain: () => void; onLook: () => void }) {
  return (
    <div role="alert" data-review-error={view.kind} className="flex flex-wrap items-center gap-2 px-3 pb-2 text-sm text-text">
      <span className="min-w-0 flex-1">{view.text}</span>
      {view.kind === "invalid" ? (
        <>
          <Button size="sm" onClick={onAgain}>
            {t("pullRequest.view.reviewThreads.again")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onLook}>
            {t("pullRequest.view.reviewThreads.lookSent")}
          </Button>
        </>
      ) : null}
      {view.kind === "unavailable" ? (
        <Button size="sm" onClick={onAgain}>
          {t("pullRequest.view.reviewThreads.retry")}
        </Button>
      ) : null}
      {view.kind === "setup" || view.kind === "limit" ? (
        <Button size="sm" onClick={openAiSettings}>
          {t("pullRequest.view.reviewThreads.openSettings")}
        </Button>
      ) : null}
    </div>
  );
}

function ThreadCard({ repoId, pr, thread, ai, quotes, hostName, onApplied }: { repoId: Id; pr: PrDetails; thread: ReviewThread; ai: Ai; quotes: boolean; hostName: string; onApplied: (applied: ReviewFixApplied) => void }) {
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [clock, setClock] = useState(() => Date.now());
  const [fix, setFix] = useState<AiReviewFix | null>(null);
  const [target, setTarget] = useState("");
  const [lastPreview, setLastPreview] = useState<AiPreview | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [applying, setApplying] = useState(false);
  /** Job of the running request; null = none (the late answer of a cancelled one is dropped). */
  const active = useRef<string | null>(null);
  const posting = useBusy(prBusyKeys.write(repoId, pr.number));
  const availability = fixAvailability(thread, { visible: ai.visible && pr.state === "open", opensSetup: ai.opensSetup });
  const running = run.kind === "running";
  const lines = threadLines(thread);
  const input = { kind: "review_fix" as const, number: pr.number, threadId: thread.id };

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Leaving the view cancels a running request; its answer is dropped.
  useEffect(
    () => () => {
      const jobId = active.current;
      active.current = null;
      if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
    },
    [],
  );

  const fail = (error: unknown) => {
    const view = errorView(error);
    setRun(view.kind === "cancelled" ? { kind: "idle" } : { kind: "failed", view });
  };

  const suggest = async () => {
    if (availability === "setup") {
      openAiSettings();
      return;
    }
    if (availability !== "ready" || active.current) return;
    setRun({ kind: "idle" });
    let preview: AiPreview;
    try {
      preview = await core.aiPreview({ repoId, feature: REVIEW_FEATURE, input, locale: locale() });
    } catch (error) {
      fail(error);
      return;
    }
    setLastPreview(preview);
    if (!(await confirmSend(repoId, REVIEW_FEATURE, preview))) return;
    const jobId = newJobId();
    active.current = jobId;
    setClock(Date.now());
    setRun({ kind: "running", startedAt: Date.now() });
    try {
      const answer = await core.aiReviewFix({ repoId, jobId, number: pr.number, threadId: thread.id, locale: locale() });
      if (active.current !== jobId) return;
      setFix(answer);
      setTarget(answer.target?.sha ?? "");
      setReply(replyDraft(answer.why, null));
      setRun({ kind: "idle" });
    } catch (error) {
      if (active.current === jobId) fail(error);
    } finally {
      if (active.current === jobId) active.current = null;
    }
  };

  const cancel = () => {
    const jobId = active.current;
    active.current = null;
    setRun({ kind: "idle" });
    if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
  };

  const whatIsSent = async () => {
    try {
      await showAiPreview(lastPreview ?? (await core.aiPreview({ repoId, feature: REVIEW_FEATURE, input, locale: locale() })), "look");
    } catch (error) {
      fail(error);
    }
  };

  const checkout = async () => {
    if (fix && (await checkoutPr(repoId, pr))) setFix({ ...fix, onBranch: true });
  };

  const apply = async () => {
    if (!fix || !target || applying) return;
    setApplying(true);
    const result = await runAction(
      t("pullRequest.view.reviewThreads.apply"),
      () => core.reviewFixApply({ repoId, number: pr.number, fix: { path: fix.path, startLine: fix.startLine, endLine: fix.endLine, newText: fix.newText, headSha: fix.headSha }, target }),
      { quiet: ["not_allowed", "dirty_worktree", "stale_state", "conflict", "operation_in_progress", "hook_failed", "signing_failed", "not_found"] },
    );
    setApplying(false);
    if (!result.ok) {
      setRun({ kind: "error", text: result.error.message });
      return;
    }
    setFix(null);
    setRun({ kind: "idle" });
    setReply(replyDraft(fix.why, result.value.commit));
    onApplied(result.value);
    toast({ tone: "success", title: t("pullRequest.view.reviewThreads.applied", { sha: shortSha(result.value.commit), summary: result.value.summary }), description: t("pullRequest.view.reviewThreads.undoHint") });
  };

  const postReply = async () => {
    const body = reply.trim();
    if (!body || posting) return;
    const result = await runHostAction(t("pullRequest.view.reviewThreads.replyPost"), () => hostApi.reviewReply(repoId, pr.number, thread.id, body), { busyKey: prBusyKeys.write(repoId, pr.number) });
    if (!result.ok) return;
    setReplyOpen(false);
    setReply("");
    toast({ tone: "success", title: t("pullRequest.view.reviewThreads.replyPosted") });
    void queryClient.invalidateQueries({ queryKey: qk.prReviewThreads(repoId, pr.number) });
  };

  const loading = run.kind === "running" ? loadingView(clock - run.startedAt, ai.local, t("pullRequest.view.reviewThreads.writing")) : null;
  const options = [
    ...(target ? [] : [{ value: "none", label: t("pullRequest.view.reviewThreads.chooseTarget"), disabled: true }]),
    ...(fix?.candidates ?? []).map((candidate) => ({ value: candidate.sha, label: `${shortSha(candidate.sha)} ${candidate.summary}` })),
  ];
  return (
    <li data-review-thread={thread.id} className="rounded-md border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1.5 text-sm text-text-muted">
        <span className="selectable min-w-0 truncate font-mono text-code text-text" title={thread.path}>
          {thread.path}
        </span>
        {lines ? <span>{lines}</span> : null}
        {thread.outdated ? <span data-review-outdated="">{t("pullRequest.view.reviewThreads.outdated")}</span> : thread.side === "old" ? <span>{t("pullRequest.view.reviewThreads.oldSide")}</span> : null}
      </header>
      <ol className="flex flex-col gap-2 px-3 py-2">
        {thread.comments.map((comment) => (
          <li key={comment.id} data-review-comment={comment.id}>
            <p className="flex items-center gap-2 text-sm text-text-muted">
              <Avatar name={userName(comment.author)} size={18} />
              <span className="selectable font-medium text-text">{userName(comment.author)}</span>
              <When value={comment.createdAt} />
            </p>
            <SafeMarkdown source={comment.body} origin={t("pullRequest.view.commentOrigin", { name: userName(comment.author) })} empty={t("pullRequest.view.markdown.empty")} className="mt-1" />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-1.5">
        {availability === "ready" || availability === "setup" ? (
          running ? (
            <Button size="sm" data-review-fix-cancel="" onClick={cancel}>
              {t("pullRequest.view.reviewThreads.cancel")}
            </Button>
          ) : (
            <Button size="sm" data-review-fix-suggest="" onClick={() => void suggest()}>
              {t("pullRequest.view.reviewThreads.suggest")}
            </Button>
          )
        ) : null}
        {availability === "ready" ? (
          <Button size="sm" variant="ghost" data-review-what-is-sent="" onClick={() => void whatIsSent()}>
            {t("pullRequest.view.reviewThreads.whatIsSent")}
          </Button>
        ) : null}
        {availability === "unavailable" ? <span className="text-sm text-text-muted">{t("pullRequest.view.reviewThreads.unavailable")}</span> : null}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-expanded={replyOpen} data-review-reply-open="" onClick={() => setReplyOpen((open) => !open)}>
          {t("pullRequest.view.reviewThreads.reply")}
        </Button>
      </div>
      <p aria-live="polite" data-review-status="" className="px-3 text-sm text-text-muted">
        {loading ? `${loading.text}${loading.slow ? ` ${loading.slow}` : ""}` : ""}
      </p>
      {run.kind === "failed" ? <FailedNote view={run.view} onAgain={() => void suggest()} onLook={() => void whatIsSent()} /> : null}
      {run.kind === "error" ? (
        <p role="alert" data-review-error="apply" className="px-3 pb-2 text-sm text-text">
          {run.text}
        </p>
      ) : null}
      {fix ? (
        <div data-review-fix="" className="flex flex-col gap-2 border-t border-border px-3 py-2">
          <p className="text-sm font-medium text-text">{t("pullRequest.view.reviewThreads.proposal")}</p>
          <DiffLines fix={fix} />
          <p className="selectable text-base text-text" data-review-fix-why="">
            <span className="font-medium">{t("pullRequest.view.reviewThreads.why")}:</span> {fix.why}
          </p>
          {fix.candidates.length > 0 ? (
            <Select
              label={t("pullRequest.view.reviewThreads.target")}
              hint={targetHint(fix, target)}
              value={target || "none"}
              options={options}
              onValueChange={(value) => setTarget(value === "none" ? "" : value)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {fix.onBranch ? (
              <Button size="sm" variant="primary" data-review-fix-apply="" disabled={!target} loading={applying} onClick={() => void apply()}>
                {t("pullRequest.view.reviewThreads.apply")}
              </Button>
            ) : (
              <>
                <Button size="sm" variant="primary" data-review-fix-checkout="" onClick={() => void checkout()}>
                  {t("pullRequest.view.reviewThreads.checkout")}
                </Button>
                <span className="text-sm text-text-muted">{t("pullRequest.view.reviewThreads.checkoutHint", { branch: fix.branch })}</span>
              </>
            )}
            <Button size="sm" variant="ghost" data-review-fix-discard="" onClick={() => setFix(null)}>
              {t("pullRequest.view.reviewThreads.discard")}
            </Button>
          </div>
        </div>
      ) : null}
      {replyOpen ? (
        <form
          data-review-reply=""
          className="flex flex-col gap-2 border-t border-border px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void postReply();
          }}
        >
          {quotes ? (
            <p className="text-sm text-text-muted" data-review-reply-quoted="">
              {t("pullRequest.view.reviewThreads.replyQuoted", { host: hostName })}
            </p>
          ) : null}
          <TextArea
            label={t("pullRequest.view.reviewThreads.replyLabel")}
            name="reply"
            rows={3}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void postReply();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReplyOpen(false)}>
              {t("pullRequest.view.reviewThreads.cancel")}
            </Button>
            <Button type="submit" size="sm" variant="primary" data-review-reply-post="" disabled={!reply.trim()} loading={posting}>
              {t("pullRequest.view.reviewThreads.replyPost")}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

/** The section; nothing where the host reports no review threads. */
export function ReviewThreads({ repoId, tabId, pr, capabilities, hostName }: { repoId: Id; tabId: Id; pr: PrDetails; capabilities: HostCapabilities; hostName: string }) {
  const query = usePrReviewThreads(repoId, pr.number, capabilities.reviewThreads);
  const status = useAiStatus();
  const repoSettings = useRepoSettings(repoId);
  const [squash, setSquash] = useState<ReviewFixApplied | null>(null);
  if (!capabilities.reviewThreads) return null;
  const ai: Ai = {
    visible: featureVisible(status.data, REVIEW_FEATURE, repoSettings.data?.aiOff ?? false),
    opensSetup: aiVisibility(status.data).elementsOpenSetup,
    local: status.data?.local ?? false,
  };
  const { open, resolved } = splitThreads(query.data ?? []);
  return (
    <section aria-label={t("pullRequest.view.reviewThreads.title")} data-review-threads="">
      <BlockTitle count={open.length || undefined}>{t("pullRequest.view.reviewThreads.title")}</BlockTitle>
      {squash && squash.fixups > 0 ? (
        <div data-review-squash="" className="mb-3">
          <Banner
            tone="info"
            title={t("pullRequest.view.reviewThreads.squashTitle", { count: squash.fixups })}
            actions={
              <>
                <Button size="sm" variant="primary" data-review-squash-open="" onClick={() => useAppStore.getState().openRebase(tabId, squash.base, "interactive", [], { autosquash: true })}>
                  {t("pullRequest.view.reviewThreads.squashNow")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSquash(null)}>
                  {t("pullRequest.view.reviewThreads.later")}
                </Button>
              </>
            }
          >
            {t("pullRequest.view.reviewThreads.squashBody")}
          </Banner>
        </div>
      ) : null}
      {query.isPending ? (
        <p role="status" className="text-base text-text-muted">
          {t("pullRequest.view.reviewThreads.loading")}
        </p>
      ) : query.isError ? (
        <p role="alert" data-review-error="load" className="text-base text-text-muted">
          {t("pullRequest.view.reviewThreads.loadError")}: {describeHostError(query.error).text}
        </p>
      ) : open.length === 0 ? (
        <p className="text-base text-text-muted" data-review-none="">
          {t("pullRequest.view.reviewThreads.none")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((thread) => (
            <ThreadCard key={thread.id} repoId={repoId} pr={pr} thread={thread} ai={ai} quotes={capabilities.reviewReplyQuotes} hostName={hostName} onApplied={setSquash} />
          ))}
        </ul>
      )}
      {resolved > 0 ? (
        <p className="mt-2 text-sm text-text-muted" data-review-resolved="">
          {t("pullRequest.view.reviewThreads.resolved", { count: resolved })}
        </p>
      ) : null}
    </section>
  );
}
