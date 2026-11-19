import { RefreshCw, TriangleAlert } from "lucide-react";
import { describeError } from "../app/errors";
import { t } from "../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

/** A list or section could not be loaded: the sentence, the core's reason and "Try again". */
export function LoadError({
  title,
  error,
  onRetry,
  className,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const { text, hint } = describeError(error);
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-2 px-2 py-2 text-sm", className)} data-load-error>
      <p className="flex items-start gap-1.5 font-medium text-text">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-danger" aria-hidden />
        {title}
      </p>
      <p className="selectable break-words text-text-muted">
        {text}
        {hint ? ` ${hint}` : ""}
      </p>
      <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
        {t("ui.retry")}
      </Button>
    </div>
  );
}
