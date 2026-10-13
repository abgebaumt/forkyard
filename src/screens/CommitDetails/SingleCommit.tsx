/**
 * A single commit: message, author, date, SHA, parents, labels, signature – its files below.
 */
import { useEffect, useRef, useState } from "react";
import { CloudOff, GitCompareArrows, GitMerge, Pencil, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { CommitInfo, Id, Person, Sha, SignatureStatus } from "../../core";
import { shortSha } from "../../app/format";
import { useCommitDetails, useRefs, useRemotes, useSettings, useStatus } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { RefLabel } from "../../ui/Git";
import { Tip } from "../../ui/Tooltip";
import { useCommitBriefs } from "./briefs";
import { CompareView } from "./Compare";
import { FilesSection } from "./FilesSection";
import { MessageEditor } from "./MessageEditor";
import { Trans } from "react-i18next";
import { t } from "../../i18n";
import { CopyButton, DateText, errorParts, HeaderSkeleton, PanelBar, PanelError, PersonRow, ShaLink, ShaText, SkeletonRows } from "./parts";

/** After saving a message: the “Edit message” button of the new commit gets the focus back. */
let refocusEditFor: Sha | null = null;

const signatureMeta: Record<Exclude<SignatureStatus, "none">, { label: string; hint: string; icon: typeof ShieldCheck; className: string }> = {
  good: { label: t("commitDetails.signature.good"), hint: t("commitDetails.signature.goodHint"), icon: ShieldCheck, className: "text-success" },
  bad: { label: t("commitDetails.signature.bad"), hint: t("commitDetails.signature.badHint"), icon: ShieldAlert, className: "text-danger" },
  unknown: {
    label: t("commitDetails.signature.unknown"),
    hint: t("commitDetails.signature.unknownHint"),
    icon: ShieldQuestion,
    className: "text-warning",
  },
};

function SignatureMark({ status }: { status: SignatureStatus }) {
  if (status === "none") return null;
  const meta = signatureMeta[status];
  const Icon = meta.icon;
  return (
    <Tip
      label={
        <span className="flex flex-col">
          <span className="font-medium">{meta.label}</span>
          <span className="text-text-muted">{meta.hint}</span>
        </span>
      }
    >
      <span tabIndex={0} role="img" aria-label={meta.label} data-signature={status} className={cn("inline-flex size-control-sm items-center justify-center rounded-md", meta.className)}>
        <Icon className="size-icon" aria-hidden />
      </span>
    </Tip>
  );
}

const samePerson = (a: Person, b: Person) => a.name === b.name && a.email === b.email;

/** The trailers are already shown as people; in the displayed description they would appear twice. */
function withoutCoAuthorLines(description: string): string {
  return description
    .split("\n")
    .filter((line) => !/^co-authored-by:/i.test(line.trim()))
    .join("\n")
    .trim();
}

/** This many ref labels are shown in the header of the commit details before “+N more” sums up the rest. */
const REF_LIMIT = 8;

export interface SingleCommitProps {
  repoId: Id;
  tabId: Id;
  sha: Sha;
}

export function SingleCommit({ repoId, tabId, sha }: SingleCommitProps) {
  const source = { kind: "commit", sha } as const;
  const query = useCommitDetails(repoId, source);
  const refs = useRefs(repoId);
  const [editing, setEditing] = useState(false);
  const [againstWorktree, setAgainstWorktree] = useState(false);
  const store = useAppStore.getState;

  // Labels, “last commit” and “pushed” depend on the refs: if they changed since the details were
  // loaded (push, fetch, new commit), the details of this commit are fetched again.
  const refsAt = refs.dataUpdatedAt;
  const detailsAt = query.dataUpdatedAt;
  const refetch = query.refetch;
  useEffect(() => {
    if (refsAt > 0 && detailsAt > 0 && refsAt > detailsAt) void refetch();
  }, [refsAt, detailsAt, refetch]);

  if (againstWorktree) {
    return <CompareView repoId={repoId} tabId={tabId} from={sha} to={null} onBack={() => setAgainstWorktree(false)} />;
  }

  if (query.isPending) {
    return (
      <>
        <PanelBar title="Commit" />
        <HeaderSkeleton label={t("commitDetails.commit.loading")} />
        <div className="border-t border-border pt-1">
          <SkeletonRows count={5} label={t("commitDetails.files.loading")} />
        </div>
      </>
    );
  }

  if (query.isError || !query.data.commit) {
    const { code, text, hint } = errorParts(query.error);
    const gone = code === "not_found";
    return (
      <>
        <PanelBar title="Commit" />
        <PanelError
          title={gone ? t("commitDetails.commit.gone") : t("commitDetails.commit.loadFailed")}
          detail={gone ? t("commitDetails.commit.notFound", { sha: shortSha(sha) }) : text}
          onRetry={() => void query.refetch()}
          action={{ label: t("commitDetails.compare.clearSelection"), onClick: () => store().clearSelection(tabId) }}
        >
          {gone ? t("commitDetails.commit.goneHint") : hint || undefined}
        </PanelError>
      </>
    );
  }

  const details = query.data;
  const commit = query.data.commit;
  return (
    <>
      <CommitHeader
        repoId={repoId}
        tabId={tabId}
        commit={commit}
        editing={editing}
        onEdit={setEditing}
        onCompareWorktree={() => setAgainstWorktree(true)}
      />
      <FilesSection
        repoId={repoId}
        tabId={tabId}
        source={source}
        details={details}
        loading={false}
        error={null}
        onRetry={() => void query.refetch()}
        treeSha={sha}
        listLabel={t("commitDetails.commit.listLabel")}
        emptyText={commit.parents.length > 1 ? t("commitDetails.commit.mergeEmpty") : t("commitDetails.commit.empty")}
        note={
          commit.parents.length > 1 && commit.parents[0] ? (
            <p data-testid="merge-note" className="flex items-start gap-2 border-b border-border px-3 py-1.5 text-sm text-text-muted">
              <GitMerge className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                <Trans
                  i18nKey="commitDetails.commit.mergeNote"
                  values={{ sha: shortSha(commit.parents[0]) }}
                  components={{ code: <code className="font-mono text-code text-text" /> }}
                />
              </span>
            </p>
          ) : undefined
        }
      />
    </>
  );
}

interface CommitHeaderProps {
  repoId: Id;
  tabId: Id;
  commit: CommitInfo;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onCompareWorktree: () => void;
}

function CommitHeader({ repoId, tabId, commit, editing, onEdit, onCompareWorktree }: CommitHeaderProps) {
  const { data: settings } = useSettings();
  const { data: status } = useStatus(repoId);
  const { data: remotes } = useRemotes(repoId);
  const { laneOf } = useCommitBriefs(repoId, [commit.sha]);
  const editWrap = useRef<HTMLDivElement>(null);
  const store = useAppStore.getState;
  const dateFormat = settings?.dateFormat ?? "relative";

  // “Last commit” according to the current status, not according to the time of loading.
  const headSha = status && status.head.kind !== "unborn" ? status.head.sha : null;
  const isHead = headSha ? headSha === commit.sha : commit.isHead;
  const operation = status?.operation ?? null;
  const canEdit = isHead && !operation;

  useEffect(() => {
    if (refocusEditFor === commit.sha && canEdit && !editing) {
      refocusEditFor = null;
      editWrap.current?.querySelector("button")?.focus();
    }
  }, [commit.sha, canEdit, editing]);

  // The commit is no longer the last one (new commit, reset from outside): editing ends.
  useEffect(() => {
    if (editing && !canEdit) onEdit(false);
  }, [editing, canEdit, onEdit]);

  // Without a remote there is nowhere to push to – the hint on every commit would then be mere noise.
  const showNotPushed = !commit.isPushed && remotes?.length !== 0;
  const description = withoutCoAuthorLines(commit.description);
  const lane = laneOf(commit.sha) ?? 0;
  const showCommitter = !samePerson(commit.author, commit.committer);

  // If very many branches and tags point at the commit, only the first ones are shown – summary and author stay in view.
  const [allRefs, setAllRefs] = useState(false);
  useEffect(() => setAllRefs(false), [commit.sha]);

  return (
    <header className={cn("flex shrink-0 flex-col", editing ? "max-h-4/5" : "max-h-3/5")}>
      <PanelBar title="Commit">
        <ShaText sha={commit.sha} className="ml-1" />
        <CopyButton text={commit.sha} label={t("commitDetails.commit.copySha")} copiedLabel={t("commitDetails.commit.shaCopied")} />
        <SignatureMark status={commit.signature} />
        <span className="flex-1" />
        <IconButton
          size="sm"
          label={t("commitDetails.commit.compareWorktree")}
          icon={<GitCompareArrows className="size-icon" aria-hidden />}
          onClick={onCompareWorktree}
        />
      </PanelBar>

      <div data-testid="commit-meta" className="flex min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto px-3 py-3">
        {commit.refs.length > 0 || showNotPushed ? (
          <div className="flex flex-wrap items-center gap-1">
            {(allRefs ? commit.refs : commit.refs.slice(0, REF_LIMIT)).map((ref) => (
              <RefLabel key={ref.fullName} kind={ref.kind} name={ref.name} head={ref.isHead} lane={lane} />
            ))}
            {commit.refs.length > REF_LIMIT ? (
              <button
                type="button"
                aria-expanded={allRefs}
                onClick={() => setAllRefs((shown) => !shown)}
                className="inline-flex h-5 items-center rounded-sm border border-border px-1.5 text-xs font-medium text-text-muted hover:bg-surface-raised hover:text-text"
              >
                {allRefs ? t("commitDetails.commit.showLess") : t("commitDetails.commit.moreRefs", { count: commit.refs.length - REF_LIMIT })}
              </button>
            ) : null}
            {showNotPushed ? (
              <Tip label={t("commitDetails.commit.notPushedTip")}>
                <span tabIndex={0} data-testid="not-pushed" className="inline-flex h-5 items-center gap-1 rounded-sm border border-border px-1.5 text-xs font-medium text-text-muted">
                  <CloudOff className="size-3" aria-hidden />
                  {t("commitDetails.commit.notPushed")}
                </span>
              </Tip>
            ) : null}
          </div>
        ) : null}

        {editing ? (
          <MessageEditor
            repoId={repoId}
            tabId={tabId}
            commit={commit}
            onClose={(savedSha) => {
              refocusEditFor = savedSha ?? commit.sha;
              onEdit(false);
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <h2 data-testid="commit-summary" className="selectable text-lg font-semibold wrap-anywhere whitespace-pre-wrap text-text">
              {commit.summary || t("commitDetails.noMessage")}
            </h2>
            {description ? (
              <p data-testid="commit-description" className="selectable text-base wrap-anywhere whitespace-pre-wrap text-text">
                {description}
              </p>
            ) : null}
            {canEdit ? (
              <div ref={editWrap}>
                <Button size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => onEdit(true)}>
                  {t("commitDetails.commit.editMessage")}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <PersonRow
            person={commit.author}
            role={t("commitDetails.commit.author")}
            trailing={
              <>
                <span aria-hidden>·</span>
                <DateText value={commit.authoredAt} format={dateFormat} offsetMinutes={commit.authorOffsetMinutes} className="shrink-0" />
              </>
            }
          />
          {showCommitter ? (
            <PersonRow
              person={commit.committer}
              role={t("commitDetails.commit.committer")}
              size={20}
              trailing={
                <>
                  <span aria-hidden>·</span>
                  <DateText value={commit.committedAt} format={dateFormat} className="shrink-0" />
                </>
              }
            />
          ) : null}
          {commit.coAuthors.map((person) => (
            <PersonRow key={`${person.name}<${person.email}>`} person={person} role={t("commitDetails.commit.coAuthor")} size={20} />
          ))}
        </div>

        <p data-testid="commit-parents" className="flex flex-wrap items-center gap-x-1 text-sm text-text-muted">
          {commit.parents.length === 0 ? (
            <span>{t("commitDetails.commit.root")}</span>
          ) : (
            <>
              <span>{commit.parents.length === 1 ? t("commitDetails.commit.parent") : t("commitDetails.commit.parents")}</span>
              {commit.parents.map((parent, index) => (
                <ShaLink
                  key={parent}
                  sha={parent}
                  label={commit.parents.length === 1 ? t("commitDetails.commit.jumpParent") : t("commitDetails.commit.jumpNthParent", { n: index + 1 })}
                  onOpen={(target) => store().revealCommit(tabId, target)}
                />
              ))}
            </>
          )}
        </p>
      </div>
    </header>
  );
}
