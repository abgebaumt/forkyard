/**
 * Markdown preview of the file view. The content comes from the repository and is not
 * trustworthy; it is rendered through the same sanitisation as the README preview:
 * marked → DOMPurify with a short allow list → images from the network become placeholders,
 * links lose their target. A link only opens after a prompt in the system browser, never in the app.
 */
import { FileQuestion, ImageOff } from "lucide-react";
import { useDeferredValue, useMemo } from "react";
import { cn } from "../../ui/cn";
import { EmptyState } from "../../ui/Feedback";
import { MarkdownHtml, proseDocument } from "../../components/markdown/Markdown";
import { README_PREVIEW_LIMIT, renderReadme } from "../../components/markdown/render";
import { locale, t } from "../../i18n";

export function MarkdownPreview({ source, path }: { source: string; path: string }) {
  // While typing, the preview recomputes without holding up the input.
  const deferred = useDeferredValue(source);
  const rendered = useMemo(() => renderReadme(deferred), [deferred]);

  if (!rendered.html.trim()) {
    return (
      <div className="flex h-full items-center justify-center bg-bg" data-md-preview="empty">
        <EmptyState icon={<FileQuestion className="size-6" aria-hidden />} title={t("fileView.markdown.emptyTitle")}>
          {t("fileView.markdown.emptyText")}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {rendered.blockedImages > 0 || rendered.truncated ? (
        <p data-md-note="" className="flex shrink-0 items-center gap-1.5 border-b border-border px-6 py-1.5 text-sm text-text-muted">
          <ImageOff className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {[
              rendered.blockedImages > 0 ? t("fileView.markdown.blockedImages", { count: rendered.blockedImages }) : null,
              rendered.truncated ? t("fileView.markdown.truncated", { limit: README_PREVIEW_LIMIT.toLocaleString(locale()) }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} aria-label={t("fileView.markdown.preview", { path })} role="region">
        <MarkdownHtml
          as="article"
          data-md-preview=""
          className={cn(proseDocument, "mx-auto max-w-180 px-6 py-5")}
          html={rendered.html}
          prompt={{
            title: t("fileView.markdown.openLinkTitle"),
            body: t("fileView.markdown.openLinkBody"),
            confirmLabel: t("fileView.markdown.openLink"),
          }}
        />
      </div>
    </div>
  );
}
