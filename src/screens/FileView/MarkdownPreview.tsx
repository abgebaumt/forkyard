/**
 * Markdown preview of the file view. The content comes from the repository and is not
 * trustworthy; it is rendered through the same sanitisation as the README preview:
 * marked → DOMPurify with a short allow list → images from the network become placeholders,
 * links lose their target. A link only opens after a prompt in the system browser, never in the app.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { FileQuestion, ImageOff } from "lucide-react";
import { useDeferredValue, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { confirm } from "../../app/dialogs";
import { runAction } from "../../app/run";
import { cn } from "../../ui/cn";
import { EmptyState } from "../../ui/Feedback";
import { README_PREVIEW_LIMIT, externalTarget, renderReadme } from "../RepoManagement/markdown";
import { locale, t } from "../../i18n";

/** Typography – tokens only. */
const prose = cn(
  "selectable text-base break-words text-text",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-2 [&_h1]:text-xl [&_h1]:font-semibold",
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-md [&_h3]:font-semibold",
  "[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:mb-1 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:mb-1 [&_h6]:font-medium [&_h6]:text-text-muted",
  "[&_p]:my-2 [&_strong]:font-semibold",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li>p]:my-1",
  "[&_dt]:mt-2 [&_dt]:font-medium [&_dd]:pl-4 [&_dd]:text-text-muted",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border-input [&_blockquote]:pl-3 [&_blockquote]:text-text-muted",
  "[&_code]:rounded-sm [&_code]:bg-surface-raised [&_code]:px-1 [&_code]:font-mono [&_code]:text-code",
  "[&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:bg-surface-raised [&_kbd]:px-1 [&_kbd]:font-mono [&_kbd]:text-code",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-sunken [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:border-collapse [&_table]:overflow-x-auto",
  "[&_th]:border [&_th]:border-border [&_th]:bg-surface [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_summary]:font-medium [&_details]:my-2",
  "[&_a[data-href]]:cursor-pointer [&_a[data-href]]:rounded-sm [&_a[data-href]]:text-accent [&_a[data-href]]:underline [&_a[data-href]]:underline-offset-2",
  "[&_a[data-inert]]:text-text-muted [&_a[data-inert]]:underline [&_a[data-inert]]:decoration-dotted",
  "[&_img]:inline-block [&_img]:max-w-full",
  "[&_span[data-readme-image]]:inline-block [&_span[data-readme-image]]:max-w-full [&_span[data-readme-image]]:truncate [&_span[data-readme-image]]:rounded-sm",
  "[&_span[data-readme-image]]:border [&_span[data-readme-image]]:border-dashed [&_span[data-readme-image]]:border-border-input",
  "[&_span[data-readme-image]]:px-1.5 [&_span[data-readme-image]]:align-middle [&_span[data-readme-image]]:text-sm [&_span[data-readme-image]]:text-text-muted",
  "[&_span[data-readme-task]]:mr-1.5 [&_span[data-readme-task]]:inline-block [&_span[data-readme-task]]:size-3 [&_span[data-readme-task]]:rounded-sm [&_span[data-readme-task]]:border [&_span[data-readme-task]]:border-border-input [&_span[data-readme-task]]:align-middle",
  "[&_span[data-readme-task=done]]:border-accent [&_span[data-readme-task=done]]:bg-accent",
  "[&_li:has(>span[data-readme-task])]:list-none [&_li:has(>span[data-readme-task])]:-ml-5",
);

async function openLink(target: string) {
  const ok = await confirm({
    title: t("fileView.markdown.openLinkTitle"),
    body: (
      <>
        {t("fileView.markdown.openLinkBody")}
        <span className="selectable mt-2 block font-mono text-code break-all text-text">{target}</span>
      </>
    ),
    confirmLabel: t("fileView.markdown.openLink"),
  });
  if (!ok) return;
  await runAction(t("fileView.markdown.openLink"), async () => {
    if (import.meta.env.DEV && window.__gcTestOpened) window.__gcTestOpened.push(target);
    else await openUrl(target);
  });
}

function linkTarget(element: EventTarget | null): string | null {
  if (!(element instanceof Element)) return null;
  const href = element.closest("[data-href]")?.getAttribute("data-href");
  return href ? externalTarget(href) : null;
}

export function MarkdownPreview({ source, path }: { source: string; path: string }) {
  // While typing, the preview recomputes without holding up the input.
  const deferred = useDeferredValue(source);
  const rendered = useMemo(() => renderReadme(deferred), [deferred]);

  const onClick = (event: MouseEvent) => {
    const target = linkTarget(event.target);
    // Links without an allowed target never navigate either.
    if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
    if (target) void openLink(target);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    const target = linkTarget(event.target);
    if (!target) return;
    event.preventDefault();
    void openLink(target);
  };

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
        <article
          data-md-preview=""
          className={cn(prose, "mx-auto max-w-180 px-6 py-5")}
          onClick={onClick}
          onKeyDown={onKeyDown}
          // Bereinigt in RepoManagement/markdown.ts (DOMPurify + Nachbearbeitung).
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      </div>
    </div>
  );
}
