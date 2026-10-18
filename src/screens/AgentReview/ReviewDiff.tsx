/**
 * The diff of one file between the agent's base and its state, with line check marks: `LineView` in
 * mode "pick" on the range diff – always without “Ignore whitespace”, so the hunks are the real ones
 * and the diff carries a `rangeToken`. Files that cannot be taken over line by line show what they are.
 */
import { FileCheck, FileWarning } from "lucide-react";
import { useMemo, useState } from "react";
import type { DiffSource, Id, TextDiff } from "../../core";
import { toCoreError } from "../../app/errors";
import { useDiff } from "../../app/queries";
import { useLineTokens } from "../../components/code/highlight";
import { codeVars, useCodeSettings } from "../../components/code/settings";
import { t } from "../../i18n";
import "../DiffView/diff.css";
import { LineView } from "../DiffView/LineView";
import { WordDiffCache, buildHunkRows } from "../DiffView/model";
import { BinaryDiffView, DiffError, DiffSkeleton, LfsDiffView, Notice, TooLargeView } from "../DiffView/OtherKinds";
import { keysOf, type FilePick } from "./model";

export interface ReviewDiffProps {
  repoId: Id;
  path: string;
  /** `rangeSource` of the pinned review. */
  source: DiffSource;
  pick: FilePick | undefined;
  /** The new line selection; the pane turns it into a pick. */
  onKeys: (keys: ReadonlySet<string>, diff: TextDiff) => void;
  /** “Close” of an error: back to the file lists. */
  onLeave: () => void;
}

export function ReviewDiff({ repoId, path, source, pick, onKeys, onLeave }: ReviewDiffProps) {
  const code = useCodeSettings();
  const [forced, setForced] = useState<string | null>(null);
  const query = useDiff(repoId, path, source, { force: forced === path, ignoreWhitespace: false });
  const diff = query.data;
  const text = diff?.kind === "text" ? diff : null;
  const model = useMemo(() => (text ? buildHunkRows(text, code.tabSize) : null), [text, code.tabSize]);
  const words = useMemo(() => (text ? new WordDiffCache(text) : null), [text]);
  const oldTokens = useLineTokens(text ? (text.oldPath ?? text.path) : null, text?.oldText);
  const newTokens = useLineTokens(text ? text.path : null, text?.newText);
  const selected = useMemo(() => (text ? keysOf(pick, text) : new Set<string>()), [pick, text]);

  let body;
  if (query.isPending) body = <DiffSkeleton />;
  else if (query.isError || !diff) body = <DiffError error={toCoreError(query.error)} path={path} retrying={query.isFetching} onRetry={() => void query.refetch()} onClose={onLeave} />;
  else if (diff.kind === "image") body = <Notice id="image" icon={<FileWarning className="size-8" aria-hidden />} title={t("agents.review.onlyMerge.binary")} />;
  else if (diff.kind === "binary") body = <BinaryDiffView diff={diff} />;
  else if (diff.kind === "lfs") body = <LfsDiffView diff={diff} />;
  else if (diff.kind === "too_large") body = <TooLargeView diff={diff} loading={query.isFetching} onForce={() => setForced(path)} />;
  else if (diff.hunks.length === 0 || !model || !words) body = <Notice id="empty" icon={<FileCheck className="size-8" aria-hidden />} title={t("agents.review.noLines")} />;
  else
    body = (
      <LineView
        key={`${path}|${diff.rangeToken ?? ""}`}
        diff={diff}
        model={model}
        mode="hunks"
        wrap={false}
        patchMode="pick"
        canPatch={Boolean(diff.rangeToken)}
        busy={false}
        code={code}
        oldTokens={oldTokens}
        newTokens={newTokens}
        words={words}
        selected={selected}
        onSelectedChange={(keys) => onKeys(keys, diff)}
        onPatch={() => undefined}
        onToggleFold={() => undefined}
        label={t("agents.review.diffLabel", { path })}
      />
    );

  return (
    <div data-review-diff={path} style={codeVars(code)} className="relative min-h-0 min-w-0 flex-1 bg-bg">
      {body}
    </div>
  );
}
