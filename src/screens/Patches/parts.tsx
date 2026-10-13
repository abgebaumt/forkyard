/** Building blocks of the patch dialogs: file list with a result per file, preview of the patch text, skeleton. */
import { Check, X } from "lucide-react";
import { StatusBadge } from "../../ui/Git";
import { cn } from "../../ui/cn";
import { locale, t } from "../../i18n";
import type { PatchFile, PatchInfo, PatchLineKind } from "./model";

/** The preview draws no more lines than this; the patch itself stays complete. */
export const PREVIEW_LIMIT = 400;
/** The list does not show more files than this individually. */
const FILE_LIMIT = 200;

const lineClass: Record<PatchLineKind, string> = {
  mail: "text-text-muted",
  meta: "font-medium text-text-muted",
  hunk: "text-accent",
  add: "bg-diff-added text-text",
  remove: "bg-diff-removed text-text",
  context: "text-text",
};

/** The patch text, coloured line by line; the signs are in the text itself (nothing by colour alone). */
export function PatchPreview({ info, className }: { info: PatchInfo; className?: string }) {
  const shown = info.lines.slice(0, PREVIEW_LIMIT);
  const rest = info.lines.length - shown.length;
  return (
    <div
      role="region"
      aria-label={t("patches.parts.preview")}
      tabIndex={0}
      data-patch-preview
      className={cn("selectable overflow-auto rounded-md border border-border bg-surface-sunken py-1 font-mono text-code", className)}
    >
      <div className="w-max min-w-full">
        {shown.map((line, index) => (
          <div key={index} className={cn("px-3 whitespace-pre", lineClass[info.kinds[index] ?? "context"])}>
            {line || " "}
          </div>
        ))}
        {rest > 0 ? (
          <p className="px-3 pt-1 font-sans text-sm text-text-muted">
            {t("patches.parts.previewMore", { count: rest.toLocaleString(locale()) })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Files of a patch. With `reasons` (check result) each file says whether it applies – as a word
 * and an icon, not only as a colour.
 */
export function PatchFileList({ files, reasons, checked, label, className }: { files: PatchFile[]; reasons?: Map<string, string>; checked?: boolean; label: string; className?: string }) {
  const shown = files.slice(0, FILE_LIMIT);
  const rest = files.length - shown.length;
  return (
    <ul aria-label={label} tabIndex={0} data-patch-files className={cn("overflow-auto rounded-md border border-border bg-surface-sunken py-1", className)}>
      {shown.map((file) => {
        const reason = reasons?.get(file.path) ?? (file.oldPath ? reasons?.get(file.oldPath) : undefined);
        const slash = file.path.lastIndexOf("/");
        return (
          <li key={`${file.oldPath ?? ""}→${file.path}`} data-patch-file={file.path} data-fits={reason ? "no" : checked ? "yes" : undefined} className="flex h-row items-center gap-2 px-2 text-base">
            <StatusBadge status={file.status} />
            <span className="min-w-0 flex-1 truncate" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
              <span className={cn(file.status === "deleted" && "line-through")}>{file.path.slice(slash + 1)}</span>
              {slash >= 0 ? <span className="ml-1 text-sm text-text-muted"> {file.path.slice(0, slash + 1)}</span> : null}
            </span>
            {reason ? (
              <span className="flex max-w-1/2 shrink-0 items-center gap-1 text-sm font-medium text-danger" title={reason}>
                <X className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{reason}</span>
              </span>
            ) : checked ? (
              <span className="flex shrink-0 items-center gap-1 text-sm text-success">
                <Check className="size-3.5" aria-hidden />
                {t("patches.parts.fits")}
              </span>
            ) : null}
            <span className="w-16 shrink-0 text-right font-mono text-xs">
              {file.binary ? <span className="text-text-muted">{t("patches.parts.binary")}</span> : null}
              {file.added ? <span className="text-success">+{file.added}</span> : null}
              {file.added && file.removed ? " " : null}
              {file.removed ? <span className="text-danger">−{file.removed}</span> : null}
            </span>
          </li>
        );
      })}
      {rest > 0 ? <li className="px-2 text-sm text-text-muted">{t("patches.parts.moreFiles", { count: rest.toLocaleString(locale()) })}</li> : null}
    </ul>
  );
}

/** Placeholder while the patch is being created. */
export function PatchSkeleton() {
  return (
    <div role="status" aria-label={t("patches.parts.loading")} data-patch-loading className="flex animate-pulse flex-col gap-3">
      <div className="h-4 w-56 rounded-sm bg-surface-raised" />
      <div className="flex h-56 flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3">
        {["w-72", "w-96", "w-48", "w-80", "w-64", "w-88", "w-40"].map((width, index) => (
          <div key={index} className={cn("h-3 max-w-full rounded-sm bg-surface-raised", width)} />
        ))}
      </div>
    </div>
  );
}
