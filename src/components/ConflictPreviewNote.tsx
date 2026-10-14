/**
 * One line in a dialog or tool: “Checking …” → “No conflicts expected” or “Conflicts in n files”
 * (expandable list; in a series “from commit x”). Purely informative – the action stays possible.
 */
import { useId, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { previewText, type PreviewState } from "../app/conflictPreview";
import { shortSha } from "../app/format";
import { cn } from "../ui/cn";
import { t } from "../i18n";

export function ConflictPreviewNote({ preview }: { preview: PreviewState }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const text = previewText(preview, shortSha);
  if (!text) return null;
  const files = preview.state === "done" && preview.result.status === "conflicts" ? preview.result.files : null;
  const clean = preview.state === "done" && preview.result.status === "clean";
  const state = preview.state === "done" ? preview.result.status : preview.state;
  return (
    <div data-conflict-preview={state} aria-live="polite" className="flex min-w-0 flex-col gap-1 text-sm">
      {files ? (
        <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)} className="flex min-w-0 items-center gap-1.5 text-left text-warning">
          <ChevronRight className={cn("size-icon shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
          <span className="min-w-0 truncate">{text}</span>
        </button>
      ) : (
        <span role="status" className={cn("flex min-w-0 items-center gap-1.5", clean ? "text-success" : "text-text-muted")}>
          {preview.state === "checking" ? <Loader2 className="size-icon shrink-0 animate-spin" aria-hidden /> : null}
          <span className="min-w-0 truncate" title={text}>
            {text}
          </span>
        </span>
      )}
      {files && open ? (
        <ul id={listId} aria-label={t("conflictPreview.filesLabel")} className="m-0 flex max-h-32 list-none flex-col overflow-auto pl-6 font-mono text-code text-text">
          {files.map((file) => (
            <li key={file} className="truncate" title={file}>
              {file}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
