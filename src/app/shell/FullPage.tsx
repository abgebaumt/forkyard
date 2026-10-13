import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { t } from "../../i18n";

/** Full-page message for states in which the shell cannot work. */
export function FullPage({
  icon,
  title,
  children,
  actions,
  details,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Technical details, selectable. */
  details?: string | null;
}) {
  return (
    <main data-shell="fullpage" className="flex h-full items-center justify-center bg-bg p-8 text-text">
      <div role="alert" className="flex max-w-xl flex-col items-center gap-3 text-center">
        {icon ? <span className="text-text-muted">{icon}</span> : null}
        <h1 className="text-xl font-semibold">{title}</h1>
        {children ? <div className="flex flex-col gap-2 text-md text-text-muted">{children}</div> : null}
        {details ? (
          <pre className="selectable max-h-48 w-full overflow-auto rounded-md bg-surface-sunken p-3 text-left font-mono text-code whitespace-pre-wrap text-text-muted">
            {details}
          </pre>
        ) : null}
        {actions ? <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </main>
  );
}

export function StartupScreen() {
  return (
    <main data-shell="starting" className="flex h-full items-center justify-center bg-bg text-text-muted" aria-busy="true">
      <span role="status" className="flex items-center gap-2 text-md">
        <Loader2 className="size-icon animate-spin" aria-hidden />
        {t("shell.starting")}
      </span>
    </main>
  );
}
