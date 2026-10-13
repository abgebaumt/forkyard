/**
 * Conflicts that cannot be resolved line by line: binary files, deleted versus modified,
 * renamed on both sides, very large files. Here one side is chosen as a whole – in words that
 * say what happens to the file (keep or delete).
 */
import { Binary, FileStack, FileX, Scale, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ConflictFile, Id } from "../../core";
import { useBusy } from "../../app/store";
import { CodeEditor } from "../../components/code/CodeEditor";
import { Button } from "../../ui/Button";
import { resolveBusyKey, resolveConflict } from "./actions";
import type { Side } from "./model";
import type { SideTitles } from "./titles";
import { locale, t } from "../../i18n";

interface WholeChoice {
  side: Side;
  label: string;
  /** What that means for the file. */
  detail: string;
  remove?: boolean;
}

interface WholeCase {
  id: string;
  icon: ReactNode;
  title: string;
  text: string;
  choices: WholeChoice[];
  /** Version shown as a preview. */
  preview: Side | null;
}

export type WholeReason = "kind" | "binary" | "large";

/** Does this file need the “whole side” choice – and why? null: resolvable line by line. */
export function wholeReason(file: ConflictFile): Exclude<WholeReason, "large"> | null {
  if (file.kind !== "both_modified" && file.kind !== "both_added") return "kind";
  if (file.isBinary || file.ours === null || file.theirs === null) return "binary";
  return null;
}

function describe(file: ConflictFile, titles: SideTitles, reason: WholeReason, lines: number): WholeCase {
  const ours = titles.ours.heading;
  const theirs = titles.theirs.heading;
  const keep = (side: Side): WholeChoice => ({ side, label: t("conflict.whole.keep"), detail: t("conflict.whole.keepDetail", { side: titles[side].heading }) });
  const remove = (side: Side): WholeChoice => ({ side, label: t("conflict.whole.delete"), detail: t("conflict.whole.deleteDetail", { side: titles[side].heading }), remove: true });
  const trash = <Trash2 className="size-8" aria-hidden />;

  if (reason === "large") {
    return {
      id: "large",
      icon: <Scale className="size-8" aria-hidden />,
      title: t("conflict.whole.large.title"),
      text: t("conflict.whole.large.text", { lines: lines.toLocaleString(locale()) }),
      choices: [
        { side: "ours", label: titles.ours.whole, detail: ours },
        { side: "theirs", label: titles.theirs.whole, detail: theirs },
      ],
      preview: null,
    };
  }

  switch (file.kind) {
    case "deleted_by_us":
      return {
        id: "deleted_by_us",
        icon: trash,
        title: t("conflict.whole.deletedByUs.title"),
        text: t("conflict.whole.deletedByUs.text", { ours, theirs }),
        choices: [keep("theirs"), remove("ours")],
        preview: "theirs",
      };
    case "deleted_by_them":
      return {
        id: "deleted_by_them",
        icon: trash,
        title: t("conflict.whole.deletedByThem.title"),
        text: t("conflict.whole.deletedByThem.text", { ours, theirs }),
        choices: [keep("ours"), remove("theirs")],
        preview: "ours",
      };
    case "both_deleted":
      return {
        id: "both_deleted",
        icon: <FileX className="size-8" aria-hidden />,
        title: t("conflict.whole.bothDeleted.title"),
        text: t("conflict.whole.bothDeleted.text"),
        choices: [{ side: "ours", label: t("conflict.whole.bothDeleted.confirm"), detail: t("conflict.whole.bothDeleted.detail"), remove: true }],
        preview: null,
      };
    case "added_by_us":
      return {
        id: "added_by_us",
        icon: <FileStack className="size-8" aria-hidden />,
        title: t("conflict.whole.addedOneSide.title"),
        text: t("conflict.whole.addedOneSide.text", { side: ours }),
        choices: [keep("ours"), remove("theirs")],
        preview: "ours",
      };
    case "added_by_them":
      return {
        id: "added_by_them",
        icon: <FileStack className="size-8" aria-hidden />,
        title: t("conflict.whole.addedOneSide.title"),
        text: t("conflict.whole.addedOneSide.text", { side: theirs }),
        choices: [keep("theirs"), remove("ours")],
        preview: "theirs",
      };
    default:
      return {
        id: "binary",
        icon: <Binary className="size-8" aria-hidden />,
        title: file.isBinary ? t("conflict.whole.binary.title") : t("conflict.whole.binary.noTextTitle"),
        text: t(`conflict.whole.binary.${file.kind === "both_added" ? "added" : "modified"}${file.isBinary ? "Binary" : "NoText"}`),
        choices: [
          { side: "ours", label: titles.ours.whole, detail: ours },
          { side: "theirs", label: titles.theirs.whole, detail: theirs },
        ],
        preview: null,
      };
  }
}

export interface WholeFileProps {
  repoId: Id;
  tabId: Id;
  path: string;
  file: ConflictFile;
  titles: SideTitles;
  reason: WholeReason;
  /** Only for “large”. */
  lines?: number;
  onForce?: () => void;
}

export function WholeFile({ repoId, tabId, path, file, titles, reason, lines = 0, onForce }: WholeFileProps) {
  const info = describe(file, titles, reason, lines);
  const busy = useBusy(resolveBusyKey(repoId, path));
  const preview = info.preview ? file[info.preview] : null;

  return (
    <div data-whole={info.id} className="flex min-h-0 flex-1 flex-col bg-surface-sunken">
      <div className="flex shrink-0 flex-col items-center gap-2 px-6 py-6 text-center">
        <span className="text-text-muted">{info.icon}</span>
        <h3 className="m-0 max-w-full text-md font-medium text-text">{info.title}</h3>
        <p className="selectable m-0 max-w-lg text-base text-text-muted">{info.text}</p>
        <div role="group" aria-label={t("conflict.whole.decision")} className="mt-2 flex flex-wrap justify-center gap-3">
          {info.choices.map((choice, index) => (
            <div key={choice.side} className="flex max-w-64 min-w-0 flex-col items-center gap-1">
              <Button
                variant={index === 0 ? "primary" : "secondary"}
                loading={busy}
                data-whole-side={choice.side}
                data-whole-remove={choice.remove || undefined}
                icon={choice.remove ? <Trash2 className="size-icon" aria-hidden /> : undefined}
                onClick={() => void resolveConflict(repoId, tabId, path, { side: choice.side })}
              >
                {choice.label}
              </Button>
              <span className="max-w-full truncate text-sm text-text-muted" title={choice.detail}>
                {choice.detail}
              </span>
            </div>
          ))}
        </div>
        {reason === "large" && onForce ? (
          <Button size="sm" className="mt-2" data-action="force" onClick={onForce}>
            {t("conflict.whole.force")}
          </Button>
        ) : null}
      </div>
      {info.preview && preview !== null ? (
        <section aria-label={t("conflict.whole.previewLabel", { side: titles[info.preview].heading })} className="flex min-h-0 flex-1 flex-col border-t border-border" data-whole-preview={info.preview}>
          <h3 className="m-0 flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border bg-surface px-3 text-sm font-normal">
            <span className="shrink-0 font-medium text-text">{titles[info.preview].role}</span>
            {titles[info.preview].name ? <span className="min-w-0 truncate font-mono text-code text-text-muted">({titles[info.preview].name})</span> : null}
            <span className="min-w-0 truncate text-text-muted">· {t("conflict.whole.previewKept")}</span>
          </h3>
          <div className="min-h-0 flex-1">
            <CodeEditor value={preview} path={path} readOnly ariaLabel={t("conflict.whole.previewEditor", { side: titles[info.preview].heading })} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
