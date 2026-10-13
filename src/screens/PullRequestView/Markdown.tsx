/**
 * Markdown from the host (description and comments of a pull request) – untrusted.
 * Rendered through the same sanitising as the README preview and the file view:
 * no scripts, no event attributes, no images from the network (placeholder with the alt text),
 * links without a target in the document. A link opens in the system browser only after a prompt.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { ImageOff } from "lucide-react";
import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { confirm } from "../../app/dialogs";
import { t } from "../../i18n";
import { runAction } from "../../app/run";
import { cn } from "../../ui/cn";
import { externalTarget, renderReadme } from "../RepoManagement/markdown";

/** Typography – tokens only; set tighter than a whole README. */
const prose = cn(
  "selectable text-base break-words text-text",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-md [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-semibold [&_h5]:mt-3 [&_h5]:font-medium [&_h6]:mt-3 [&_h6]:font-medium [&_h6]:text-text-muted",
  "[&_p]:my-2 [&_strong]:font-semibold",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li>p]:my-1",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-input [&_blockquote]:pl-3 [&_blockquote]:text-text-muted",
  "[&_code]:rounded-sm [&_code]:bg-surface-raised [&_code]:px-1 [&_code]:font-mono [&_code]:text-code",
  "[&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:bg-surface-raised [&_kbd]:px-1 [&_kbd]:font-mono [&_kbd]:text-code",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-sunken [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_hr]:my-3 [&_hr]:border-border",
  "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:border-collapse [&_table]:overflow-x-auto",
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

async function openLink(target: string, origin: string) {
  const ok = await confirm({
    title: t("pullRequest.view.markdown.confirmTitle"),
    body: (
      <>
        {t("pullRequest.view.markdown.confirmBody", { origin })}
        <span className="selectable mt-2 block font-mono text-code break-all text-text">{target}</span>
      </>
    ),
    confirmLabel: t("pullRequest.view.markdown.openLink"),
  });
  if (!ok) return;
  await runAction(t("pullRequest.view.markdown.openLink"), async () => {
    if (import.meta.env.DEV && window.__gcTestOpened) window.__gcTestOpened.push(target);
    else await openUrl(target);
  });
}

function linkTarget(element: EventTarget | null): string | null {
  if (!(element instanceof Element)) return null;
  const href = element.closest("[data-href]")?.getAttribute("data-href");
  // Check once more: only http, https and mailto leave the app.
  return href ? externalTarget(href) : null;
}

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

  const onClick = (event: MouseEvent) => {
    const target = linkTarget(event.target);
    // Links without an allowed target never navigate either.
    if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
    if (target) void openLink(target, origin);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    const target = linkTarget(event.target);
    if (!target) return;
    event.preventDefault();
    void openLink(target, origin);
  };

  if (!rendered.html.trim()) {
    return (
      <p data-markdown="empty" className={cn("text-base text-text-muted italic", className)}>
        {empty ?? t("pullRequest.view.markdown.empty")}
      </p>
    );
  }

  return (
    <div className={className}>
      <div
        data-markdown=""
        className={prose}
        onClick={onClick}
        onKeyDown={onKeyDown}
        // Sanitised in RepoManagement/markdown.ts (DOMPurify + post-processing).
        dangerouslySetInnerHTML={{ __html: rendered.html }}
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
