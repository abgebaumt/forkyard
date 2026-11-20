/** "What's new since …" above the commit graph: numbers, rows to jump to, mark as seen. Never takes focus. */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Id, RefsSnapshot } from "../../core";
import { showInGraph } from "../../app/backNav";
import { openPr } from "../../app/actions/pullrequests";
import { formatRelative } from "../../app/format";
import { hostKindLabels } from "../../app/hosts";
import { qk, queryClient, useDigest } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { t } from "../../i18n";
import { markDigestSeen } from "./actions";
import { digestNumbers, digestRows, ROW_LIMIT, type DigestRow } from "./model";

function openRow(repoId: Id, tabId: Id, row: DigestRow, base: string | null): void {
  switch (row.kind) {
    case "ref":
    case "commit":
      if (row.sha) showInGraph(tabId, row.sha);
      return;
    case "pr":
      openPr(tabId, row.number);
      return;
    case "file":
      useAppStore.getState().openHistory(tabId, row.path);
      return;
    case "behind": {
      // The base is a remote branch, or the local default branch when there is none.
      const refs = queryClient.getQueryData<RefsSnapshot>(qk.refs(repoId));
      const sha = [...(refs?.remotes ?? []), ...(refs?.locals ?? [])].find((ref) => ref.name === base)?.sha;
      if (sha) showInGraph(tabId, sha);
      return;
    }
  }
}

export function DigestCard({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const open = useAppStore((state) => Boolean(state.digestOpen[repoId]));
  const { data: digest, isError } = useDigest(repoId, open);
  const [showAll, setShowAll] = useState(false);
  const empty = digest === null || digest?.isEmpty === true || isError;
  useEffect(() => {
    if (open && empty) useAppStore.getState().closeDigest(repoId);
  }, [open, empty, repoId]);
  if (!open || !digest || empty) return null;

  const numbers = digestNumbers(digest);
  const rows = digestRows(digest);
  const shown = showAll ? rows : rows.slice(0, ROW_LIMIT);
  const seen = () => void markDigestSeen(repoId, digest.prMaxNumber);
  return (
    <section
      data-screen="digest-card"
      aria-label={t("digest.title", { time: formatRelative(digest.seenAt) })}
      className="shrink-0 border-b border-border bg-surface px-2 py-1.5 text-sm"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-medium">{t("digest.title", { time: formatRelative(digest.seenAt) })}</h2>
        <Button size="sm" variant="ghost" data-digest-seen onClick={seen}>
          {t("digest.markSeen")}
        </Button>
        <IconButton size="sm" label={t("ui.close")} icon={<X className="size-icon" aria-hidden />} data-digest-close onClick={seen} />
      </div>
      <p className="text-text-muted" aria-live="polite">
        <span data-digest-number="commits">{t("digest.numbers.commits", { count: numbers.commits })}</span>
        {" · "}
        <span data-digest-number="prs">{t("digest.numbers.prs", { count: numbers.prs })}</span>
        {" · "}
        <span data-digest-number="files">{t("digest.numbers.files", { count: numbers.files })}</span>
      </p>
      {digest.prDataMissing ? (
        <p data-digest-pr-missing className="text-text-muted">
          {t("digest.prMissing", { host: hostKindLabels[digest.prDataMissing] })}
        </p>
      ) : null}
      <ul aria-label={t("digest.rows")} className="mt-1 flex flex-col">
        {shown.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              data-digest-row={row.key}
              // A deleted ref has no target but stays reachable by keyboard.
              aria-disabled={row.kind === "ref" && !row.sha ? true : undefined}
              onClick={() => openRow(repoId, tabId, row, digest.behind?.base ?? null)}
              className="w-full truncate rounded-sm px-1 py-0.5 text-left hover:bg-surface-raised aria-disabled:text-text-muted aria-disabled:hover:bg-transparent"
            >
              {row.kind === "commit" ? <span className="pl-4">{row.label}</span> : row.label}
            </button>
          </li>
        ))}
      </ul>
      {!showAll && rows.length > ROW_LIMIT ? (
        <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
          {t("digest.showAll")}
        </Button>
      ) : null}
    </section>
  );
}
