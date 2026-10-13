import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BookOpen, FileQuestion, FolderX, ImageOff, RefreshCw } from "lucide-react";
import type { Repo } from "../../core";
import { confirm } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { useReadme } from "../../app/queries";
import { runAction } from "../../app/run";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/Feedback";
import { cn } from "../../ui/cn";
import { README_PREVIEW_LIMIT, externalTarget, renderReadme } from "./markdown";
import { displayName } from "./repoActions";
import { locale, t } from "../../i18n";

/** Typography of the rendered README – tokens only. */
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
  "[&_img]:inline-block [&_img]:max-w-full",
  "[&_span[data-readme-image]]:inline-block [&_span[data-readme-image]]:max-w-full [&_span[data-readme-image]]:truncate [&_span[data-readme-image]]:rounded-sm",
  "[&_span[data-readme-image]]:border [&_span[data-readme-image]]:border-dashed [&_span[data-readme-image]]:border-border-input",
  "[&_span[data-readme-image]]:px-1.5 [&_span[data-readme-image]]:align-middle [&_span[data-readme-image]]:text-sm [&_span[data-readme-image]]:text-text-muted",
  "[&_span[data-readme-task]]:mr-1.5 [&_span[data-readme-task]]:inline-block [&_span[data-readme-task]]:size-3 [&_span[data-readme-task]]:rounded-sm [&_span[data-readme-task]]:border [&_span[data-readme-task]]:border-border-input [&_span[data-readme-task]]:align-middle",
  "[&_span[data-readme-task=done]]:border-accent [&_span[data-readme-task=done]]:bg-accent",
  "[&_li:has(>span[data-readme-task])]:list-none [&_li:has(>span[data-readme-task])]:-ml-5",
);

/** Asks first and hands the link to the system browser. The app itself never navigates. */
async function openExternalLink(target: string) {
  const ok = await confirm({
    title: t("repos.readme.linkTitle"),
    body: (
      <>
        {t("repos.readme.linkBody")}
        <span className="selectable mt-2 block font-mono text-code break-all text-text">{target}</span>
      </>
    ),
    confirmLabel: t("repos.readme.linkOpen"),
  });
  if (!ok) return;
  await runAction(t("repos.readme.linkOpen"), async () => {
    // For automated tests (like `__gcTestPicks` for the folder dialog): no browser should start there.
    if (import.meta.env.DEV && window.__gcTestOpened) window.__gcTestOpened.push(target);
    else await openUrl(target);
  });
}

declare global {
  interface Window {
    /** If a list is set here, confirmed README links land in it instead of the system browser. */
    __gcTestOpened?: string[];
  }
}

function linkTarget(element: EventTarget | null): string | null {
  if (!(element instanceof Element)) return null;
  const href = element.closest("[data-href]")?.getAttribute("data-href");
  // Check once more: only http, https and mailto leave the app.
  return href ? externalTarget(href) : null;
}

function Skeleton() {
  const widths = ["w-2/5", "w-full", "w-11/12", "w-4/5", "w-full", "w-3/5", "w-full", "w-5/6", "w-2/3"];
  return (
    <div role="status" aria-label={t("repos.readme.loading")} className="flex flex-col gap-3 p-6">
      {widths.map((width, index) => (
        <div key={index} className={cn("animate-pulse rounded-sm bg-surface-raised", index === 0 ? "h-6" : "h-3", width)} />
      ))}
    </div>
  );
}

function ReadmeBody({ source }: { source: string }) {
  const rendered = useMemo(() => renderReadme(source), [source]);

  const onClick = (event: MouseEvent) => {
    const target = linkTarget(event.target);
    if (!target) return;
    event.preventDefault();
    void openExternalLink(target);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    const target = linkTarget(event.target);
    if (!target) return;
    event.preventDefault();
    void openExternalLink(target);
  };

  if (!rendered.html.trim()) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<FileQuestion className="size-6" aria-hidden />} title={t("repos.readme.empty")} />
      </div>
    );
  }

  return (
    <>
      {rendered.blockedImages > 0 || rendered.truncated ? (
        <p data-readme-note className="flex items-center gap-1.5 border-b border-border px-6 py-1.5 text-sm text-text-muted">
          <ImageOff className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {[
              rendered.blockedImages > 0 ? t("repos.readme.blockedImages", { count: rendered.blockedImages }) : null,
              rendered.truncated ? t("repos.readme.truncated", { limit: README_PREVIEW_LIMIT.toLocaleString(locale()) }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto" tabIndex={-1}>
        {/* eslint-disable-next-line react/no-danger -- sanitised in markdown.ts */}
        <article
          data-readme
          className={cn(prose, "mx-auto max-w-180 px-6 py-5")}
          onClick={onClick}
          onKeyDown={onKeyDown}
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      </div>
    </>
  );
}

export interface ReadmePreviewProps {
  repo: Repo | null;
}

/** README of the selected repository. */
export function ReadmePreview({ repo }: ReadmePreviewProps) {
  const readme = useReadme(repo && !repo.missing && repo.trusted !== false ? repo.id : null);

  let body;
  if (!repo) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<BookOpen className="size-6" aria-hidden />} title={t("repos.readme.noneSelectedTitle")}>
          {t("repos.readme.noneSelectedBody")}
        </EmptyState>
      </div>
    );
  } else if (repo.missing) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState icon={<FolderX className="size-6" aria-hidden />} title={t("repos.list.missing")}>
          {t("repos.readme.missingBody")}
        </EmptyState>
      </div>
    );
  } else if (readme.isPending) {
    body = <Skeleton />;
  } else if (readme.isError) {
    body = (
      <div className="flex flex-1 items-center justify-center" data-readme-error>
        <EmptyState
          icon={<FileQuestion className="size-6" aria-hidden />}
          title={t("repos.readme.errorTitle")}
          action={
            <Button icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void readme.refetch()}>
              {t("repos.retry")}
            </Button>
          }
        >
          {describeError(readme.error).text}
        </EmptyState>
      </div>
    );
  } else if (readme.data === null) {
    body = (
      <div className="flex flex-1 items-center justify-center" data-readme-none>
        <EmptyState icon={<FileQuestion className="size-6" aria-hidden />} title={t("repos.readme.noneTitle")}>
          {t("repos.readme.noneBody")}
        </EmptyState>
      </div>
    );
  } else {
    body = <ReadmeBody source={readme.data} />;
  }

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-6">
        <BookOpen className="size-icon shrink-0 text-text-muted" aria-hidden />
        <h2 className="min-w-0 truncate text-md font-medium" title={repo ? repo.path : undefined}>
          {repo ? t("repos.readme.heading", { name: displayName(repo) }) : "README"}
        </h2>
      </header>
      {body}
    </>
  );
}
