/**
 * More than one commit selected – or a commit against the working directory:
 * comparison of two revisions, combined diff of a contiguous sequence, or the explanation
 * why there is no combined diff.
 */
import { useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUpDown, FolderOpen } from "lucide-react";
import { EMPTY_TREE_SHA, type Id, type Sha } from "../../core";
import { formatDate, formatDateTime, shortSha } from "../../app/format";
import { useCommitDetails, useSettings } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/Feedback";
import { Avatar } from "../../ui/Git";
import { useCommitBriefs, type CommitBriefs } from "./briefs";
import { FilesSection } from "./FilesSection";
import { analyzeSelection, orderNewestFirst, type CommitBrief } from "./logic";
import { errorParts, HeaderSkeleton, PanelBar, PanelError, SectionLabel } from "./parts";
import { VirtualList } from "./VirtualList";
import { Trans } from "react-i18next";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// Gemeinsame Teile
// ---------------------------------------------------------------------------

function BriefsProblem({ tabId, briefs, title }: { tabId: Id; briefs: CommitBriefs; title: string }) {
  if (briefs.loading || !briefs.error) {
    return (
      <>
        <PanelBar title={title} />
        <HeaderSkeleton label={t("commitDetails.compare.loading")} />
      </>
    );
  }
  const { code, text, hint } = errorParts(briefs.error);
  const gone = code === "not_found";
  return (
    <>
      <PanelBar title={title} />
      <PanelError
        title={gone ? t("commitDetails.compare.gone") : t("commitDetails.compare.loadFailed")}
        detail={text}
        onRetry={briefs.retry}
        action={{ label: t("commitDetails.compare.clearSelection"), onClick: () => useAppStore.getState().clearSelection(tabId) }}
      >
        {gone ? t("commitDetails.compare.goneHint") : hint || undefined}
      </PanelError>
    </>
  );
}

interface SideProps {
  tabId: Id;
  /** Which side; `data-side` stays “From”/“To”. */
  side: "from" | "to";
  sha: Sha | null;
  brief: CommitBrief | undefined;
  /** “older” / “newer”, if known. */
  age?: string;
}

/** One side of the comparison: a commit or the working directory. */
function Side({ tabId, side, sha, brief, age }: SideProps) {
  const label = side === "from" ? t("commitDetails.compare.from") : t("commitDetails.compare.to");
  const dataSide = side === "from" ? "Von" : "Nach";
  const { data: settings } = useSettings();
  const frame = "flex w-full min-w-0 items-start gap-2 rounded-md border border-border bg-surface-sunken px-2 py-1.5 text-left";
  const tag = <span className="mt-0.5 w-9 shrink-0 text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</span>;
  if (sha === null) {
    return (
      <div data-side={dataSide} className={frame}>
        {tag}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium text-text">
            <FolderOpen className="size-3.5 shrink-0 text-text-muted" aria-hidden />
            {t("commitDetails.compare.workingDirectory")}
          </span>
          <span className="block text-sm text-text-muted">{t("commitDetails.compare.workingDirectoryHint")}</span>
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      data-side={dataSide}
      data-sha={sha}
      title={t("commitDetails.compare.showOnly")}
      onClick={() => useAppStore.getState().revealCommit(tabId, sha)}
      className={cn(frame, "hover:border-border-input")}
    >
      {tag}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <code className="shrink-0 font-mono text-code text-accent">{shortSha(sha)}</code>
          {age ? <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-text-muted">{age}</span> : null}
        </span>
        <span className="block truncate font-medium text-text" title={brief?.summary}>
          {brief?.summary || t("commitDetails.noMessage")}
        </span>
        {brief ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-text-muted">
            <span className="truncate">{brief.authorName}</span>
            {brief.authoredAt ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0" title={formatDateTime(brief.authoredAt)}>
                  {formatDate(brief.authoredAt, settings?.dateFormat ?? "relative")}
                </span>
              </>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** List of selected commits. Enter or double-click shows the commit on its own. */
function CommitRows({ tabId, shas, briefs, rows }: { tabId: Id; shas: Sha[]; briefs: Map<Sha, CommitBrief>; rows?: number }) {
  const [active, setActive] = useState(-1);
  const visible = Math.min(shas.length, rows ?? shas.length);
  return (
    <div data-testid="selected-commits" className={rows ? "shrink-0" : "min-h-0 flex-1"} style={rows ? { height: `calc(var(--gc-size-row) * ${visible})` } : undefined}>
      <VirtualList
        count={shas.length}
        active={active}
        onActiveChange={setActive}
        onActivate={(index) => {
          const sha = shas[index];
          if (sha) useAppStore.getState().revealCommit(tabId, sha);
        }}
        ariaLabel={t("commitDetails.compare.selectedCommits")}
        getKey={(index) => shas[index] ?? index}
        renderRow={(index) => {
          const sha = shas[index] ?? "";
          const brief = briefs.get(sha);
          return (
            <span className="flex min-w-0 flex-1 items-center gap-2 px-3 text-base" title={brief?.summary}>
              <Avatar name={brief?.authorName || "?"} email={brief?.authorEmail} size={18} />
              <span className="min-w-0 flex-1 truncate">{brief?.summary || t("commitDetails.noMessage")}</span>
              <code className="shrink-0 font-mono text-code text-text-muted">{shortSha(sha)}</code>
            </span>
          );
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comparison of two revisions
// ---------------------------------------------------------------------------

export interface CompareViewProps {
  repoId: Id;
  tabId: Id;
  from: Sha;
  /** null = Arbeitsverzeichnis. */
  to: Sha | null;
  /** Which of the two sides is the older one, if known. */
  older?: Sha | null;
  onSwap?: () => void;
  /** Back to the commit's details (when comparing with the working directory). */
  onBack?: () => void;
}

export function CompareView({ repoId, tabId, from, to, older, onSwap, onBack }: CompareViewProps) {
  const source = { kind: "range", from, to } as const;
  const shas = to ? [from, to] : [from];
  const briefs = useCommitBriefs(repoId, shas);
  const query = useCommitDetails(repoId, source);
  const reason = query.data?.notCombinableReason ?? null;
  const age = (sha: Sha) => (older ? (sha === older ? t("commitDetails.compare.older") : t("commitDetails.compare.newer")) : undefined);

  return (
    <>
      <PanelBar title={t("commitDetails.compare.title")}>
        <span className="flex-1" />
        {onBack ? (
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="size-3.5" aria-hidden />} onClick={onBack}>
            {t("commitDetails.compare.toCommit")}
          </Button>
        ) : null}
      </PanelBar>
      <div data-testid="compare-head" className="flex shrink-0 flex-col gap-1 px-3 py-3">
        <Side tabId={tabId} side="from" sha={from} brief={briefs.briefs.get(from)} age={age(from)} />
        <div className="flex h-control-sm items-center gap-2 pl-3">
          <ArrowDown className="size-icon shrink-0 text-text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
            {to ? t("commitDetails.compare.direction") : t("commitDetails.compare.sinceCommit")}
          </span>
          {onSwap ? <IconButton size="sm" label={t("commitDetails.compare.swap")} icon={<ArrowUpDown className="size-icon" aria-hidden />} onClick={onSwap} /> : null}
        </div>
        <Side tabId={tabId} side="to" sha={to} brief={to ? briefs.briefs.get(to) : undefined} age={to ? age(to) : undefined} />
      </div>
      {reason ? (
        <div data-testid="not-combinable" className="border-t border-border">
          <Banner tone="warning" title={t("commitDetails.compare.notPossible")}>
            {reason}
          </Banner>
        </div>
      ) : (
        <FilesSection
          repoId={repoId}
          tabId={tabId}
          source={source}
          details={query.data}
          loading={query.isPending}
          error={query.isError ? query.error : null}
          onRetry={() => void query.refetch()}
          listLabel={to ? t("commitDetails.compare.listLabel", { from: shortSha(from), to: shortSha(to) }) : t("commitDetails.compare.listLabelWorking", { from: shortSha(from) })}
          emptyText={to ? t("commitDetails.compare.noDifference") : t("commitDetails.compare.workingMatches")}
        />
      )}
    </>
  );
}

/** Exactly two commits: comparison, older side first; swappable. */
export function TwoCommits({ repoId, tabId, shas }: { repoId: Id; tabId: Id; shas: [Sha, Sha] }) {
  const briefs = useCommitBriefs(repoId, shas);
  const [swapped, setSwapped] = useState(false);
  if (!briefs.ready) return <BriefsProblem tabId={tabId} briefs={briefs} title={t("commitDetails.compare.title")} />;
  const [newer, older] = orderNewestFirst(shas, briefs.briefs) as [Sha, Sha];
  return (
    <CompareView
      repoId={repoId}
      tabId={tabId}
      from={swapped ? newer : older}
      to={swapped ? older : newer}
      older={older}
      onSwap={() => setSwapped((value) => !value)}
    />
  );
}

// ---------------------------------------------------------------------------
// More than two commits
// ---------------------------------------------------------------------------

export function MultiCommits({ repoId, tabId, shas }: { repoId: Id; tabId: Id; shas: Sha[] }) {
  const briefs = useCommitBriefs(repoId, shas);
  if (!briefs.ready) return <BriefsProblem tabId={tabId} briefs={briefs} title={t("commitDetails.compare.selection")} />;
  const analysis = analyzeSelection(shas, briefs.briefs);
  // If the sequence reaches back to the first commit, there is no revision before it: the comparison is against the empty tree.
  if (analysis.kind !== "gap") {
    return <RangeView repoId={repoId} tabId={tabId} chain={analysis.chain} base={analysis.kind === "chain" ? analysis.base : null} briefs={briefs.briefs} />;
  }
  const ordered = analysis.ordered;
  return (
    <>
      <PanelBar title={t("commitDetails.compare.selection")}>
        <span data-testid="selection-count" className="ml-1 text-sm text-text-muted">
          {t("commitDetails.commitCount", { count: shas.length })}
        </span>
      </PanelBar>
      <div data-testid="not-combinable" data-reason={analysis.kind} className="shrink-0">
        <Banner tone="info" title={t("commitDetails.compare.gapTitle")}>
          {t("commitDetails.compare.gapText")}
        </Banner>
      </div>
      <div className="flex h-control-lg shrink-0 items-center justify-between gap-2 border-y border-border px-3">
        <SectionLabel>{t("commitDetails.compare.selectedCommits")}</SectionLabel>
        <span className="truncate text-sm text-text-muted">{t("commitDetails.compare.enterHint")}</span>
      </div>
      <CommitRows tabId={tabId} shas={ordered} briefs={briefs.briefs} />
    </>
  );
}

/**
 * Contiguous sequence: combined diff from the revision before the oldest up to the newest commit.
 * `base: null`: the sequence starts at the repository's first commit – the comparison is against the empty tree.
 */
function RangeView({ repoId, tabId, chain, base, briefs }: { repoId: Id; tabId: Id; chain: Sha[]; base: Sha | null; briefs: Map<Sha, CommitBrief> }) {
  const newest = chain[0] ?? "";
  const oldest = chain[chain.length - 1] ?? newest;
  const source = { kind: "range", from: base ?? EMPTY_TREE_SHA, to: newest } as const;
  const query = useCommitDetails(repoId, source);
  const reason = query.data?.notCombinableReason ?? null;
  return (
    <>
      <PanelBar title={t("commitDetails.compare.range")}>
        <span data-testid="selection-count" className="ml-1 text-sm text-text-muted">
          {t("commitDetails.commitCount", { count: chain.length })}
        </span>
      </PanelBar>
      <div data-testid="range-note" data-from={base ?? "root"} data-to={newest} className="flex shrink-0 flex-col gap-0.5 px-3 pt-3 pb-2">
        <p className="font-medium text-text">
          <Trans
            i18nKey="commitDetails.compare.rangeTitle"
            values={{ from: shortSha(oldest), to: shortSha(newest) }}
            components={{ code: <code className="font-mono text-code font-normal text-accent" /> }}
          />
        </p>
        <p className="text-sm text-text-muted">
          {base ? (
            <Trans i18nKey="commitDetails.compare.rangeBase" values={{ base: shortSha(base) }} components={{ code: <code className="font-mono text-code" /> }} />
          ) : (
            t("commitDetails.compare.rangeRoot")
          )}
        </p>
      </div>
      <div className="shrink-0 pb-1">
        <CommitRows tabId={tabId} shas={chain} briefs={briefs} rows={4} />
      </div>
      {reason ? (
        <div data-testid="not-combinable" className="border-t border-border">
          <Banner tone="warning" title={t("commitDetails.compare.combinedNotPossible")}>
            {reason}
          </Banner>
        </div>
      ) : (
        <FilesSection
          repoId={repoId}
          tabId={tabId}
          source={source}
          details={query.data}
          loading={query.isPending}
          error={query.isError ? query.error : null}
          onRetry={() => void query.refetch()}
          listLabel={t("commitDetails.compare.rangeListLabel", { count: chain.length })}
          emptyText={t("commitDetails.compare.rangeEmpty")}
        />
      )}
    </>
  );
}
