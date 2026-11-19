/**
 * Markdown from the host (description and comments of a pull request) – untrusted.
 * Rendered through the same sanitising as the README preview and the file view:
 * no scripts, no event attributes, no images from the network (placeholder with the alt text),
 * links without a target in the document. A link opens in the system browser only after a prompt.
 */
import { ImageOff } from "lucide-react";
import { useMemo } from "react";
import { t } from "../../i18n";
import { cn } from "../../ui/cn";
import { MarkdownHtml, proseCompact } from "./Markdown";
import { renderReadme } from "./render";

export interface SafeMarkdownProps {
  source: string;
  /** Where the text comes from, for the prompt before a link: "in the pull request's description". */
  origin: string;
  /** What is shown instead of an empty text. */
  empty?: string;
  className?: string;
}

/** Sanitised Markdown. Loads nothing from the network and never navigates. */
export function SafeMarkdown({ source, origin, empty, className }: SafeMarkdownProps) {
  const rendered = useMemo(() => renderReadme(source), [source]);

  if (!rendered.html.trim()) {
    return (
      <p data-markdown="empty" className={cn("text-base text-text-muted italic", className)}>
        {empty ?? t("pullRequest.view.markdown.empty")}
      </p>
    );
  }

  return (
    <div className={className}>
      <MarkdownHtml
        data-markdown=""
        className={proseCompact}
        html={rendered.html}
        prompt={{
          title: t("pullRequest.view.markdown.confirmTitle"),
          body: t("pullRequest.view.markdown.confirmBody", { origin }),
          confirmLabel: t("ui.openLink"),
        }}
      />
      {rendered.blockedImages > 0 || rendered.truncated ? (
        <p data-markdown-note="" className="mt-2 flex items-center gap-1.5 text-sm text-text-muted">
          <ImageOff className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            {[
              rendered.blockedImages > 0 ? t("pullRequest.view.markdown.blockedImages", { count: rendered.blockedImages }) : null,
              rendered.truncated ? t("pullRequest.view.markdown.truncated") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
      ) : null}
    </div>
  );
}
