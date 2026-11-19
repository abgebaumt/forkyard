import { useMemo } from "react";
import { BookOpen, FileQuestion, FolderX, ImageOff, RefreshCw } from "lucide-react";
import type { Repo } from "../../core";
import { describeError } from "../../app/errors";
import { useReadme } from "../../app/queries";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/Feedback";
import { cn } from "../../ui/cn";
import { MarkdownHtml, proseDocument } from "../../components/markdown/Markdown";
import { README_PREVIEW_LIMIT, renderReadme } from "../../components/markdown/render";
import { displayName } from "./repoActions";
import { locale, t } from "../../i18n";

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
        <MarkdownHtml
          as="article"
          data-readme=""
          className={cn(proseDocument, "mx-auto max-w-180 px-6 py-5")}
          html={rendered.html}
          prompt={{ title: t("repos.readme.linkTitle"), body: t("repos.readme.linkBody"), confirmLabel: t("ui.openLink") }}
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
              {t("ui.retry")}
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
