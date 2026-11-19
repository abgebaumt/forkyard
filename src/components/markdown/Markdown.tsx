/**
 * Shared rendering of sanitised Markdown (README preview, file view, pull requests and issues).
 * The HTML comes from `renderReadme` in render.ts; this file only adds typography and links:
 * a link opens in the system browser only after a prompt, the app itself never navigates.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import type { HTMLAttributes, KeyboardEvent, MouseEvent } from "react";
import { confirm } from "../../app/dialogs";
import { runAction } from "../../app/run";
import { cn } from "../../ui/cn";
import { externalTarget } from "./render";

declare global {
  interface Window {
    /** If a list is set here, confirmed Markdown links land in it instead of the system browser. */
    __gcTestOpened?: string[];
  }
}

const proseShared = [
  "selectable text-base break-words text-text",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2 [&_strong]:font-semibold",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_li>p]:my-1",
  "[&_code]:rounded-sm [&_code]:bg-surface-raised [&_code]:px-1 [&_code]:font-mono [&_code]:text-code",
  "[&_kbd]:rounded-sm [&_kbd]:border [&_kbd]:border-border [&_kbd]:bg-surface-raised [&_kbd]:px-1 [&_kbd]:font-mono [&_kbd]:text-code",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-sunken [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:block [&_table]:max-w-full [&_table]:border-collapse [&_table]:overflow-x-auto",
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
];

/** Typography for comments and descriptions – tokens only; tighter than a whole document. */
export const proseCompact = cn(
  proseShared,
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-md [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-semibold [&_h5]:mt-3 [&_h5]:font-medium [&_h6]:mt-3 [&_h6]:font-medium [&_h6]:text-text-muted",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-input [&_blockquote]:pl-3 [&_blockquote]:text-text-muted",
  "[&_pre]:my-2 [&_hr]:my-3 [&_hr]:border-border [&_table]:my-2",
);

/** Typography for whole documents (README, Markdown files) – tokens only. */
export const proseDocument = cn(
  proseShared,
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-2 [&_h1]:text-xl [&_h1]:font-semibold",
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-md [&_h3]:font-semibold",
  "[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:mb-1 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:mb-1 [&_h6]:font-medium [&_h6]:text-text-muted",
  "[&_dt]:mt-2 [&_dt]:font-medium [&_dd]:pl-4 [&_dd]:text-text-muted",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border-input [&_blockquote]:pl-3 [&_blockquote]:text-text-muted",
  "[&_pre]:my-3 [&_hr]:my-4 [&_hr]:border-border [&_table]:my-3",
);

/** Texts of the prompt before a link opens; each place says where the link comes from. */
export interface LinkPrompt {
  title: string;
  body: string;
  confirmLabel: string;
}

async function openLink(target: string, prompt: LinkPrompt) {
  const ok = await confirm({
    title: prompt.title,
    body: (
      <>
        {prompt.body}
        <span className="selectable mt-2 block font-mono text-code break-all text-text">{target}</span>
      </>
    ),
    confirmLabel: prompt.confirmLabel,
  });
  if (!ok) return;
  await runAction(prompt.confirmLabel, async () => {
    // For automated tests (like `__gcTestPicks` for the folder dialog): no browser should start there.
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

export interface MarkdownHtmlProps extends HTMLAttributes<HTMLElement> {
  /** Output of `renderReadme` – never anything else. */
  html: string;
  prompt: LinkPrompt;
  as?: "div" | "article";
  [data: `data-${string}`]: string | undefined;
}

/** Sanitised Markdown HTML with prompted links. Loads nothing from the network and never navigates. */
export function MarkdownHtml({ html, prompt, as: Tag = "div", ...rest }: MarkdownHtmlProps) {
  const onClick = (event: MouseEvent) => {
    const target = linkTarget(event.target);
    // Links without an allowed target never navigate either.
    if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
    if (target) void openLink(target, prompt);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    const target = linkTarget(event.target);
    if (!target) return;
    event.preventDefault();
    void openLink(target, prompt);
  };
  return (
    <Tag
      {...rest}
      onClick={onClick}
      onKeyDown={onKeyDown}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised in components/markdown/render.ts (DOMPurify + post-processing).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
