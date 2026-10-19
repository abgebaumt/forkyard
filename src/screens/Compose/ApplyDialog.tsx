/**
 * Creating the commits of "Compose commits": "Commit n of m" with the state of every commit and its
 * hooks, then "Undo" / "Done" – or, when a hook or a check stopped the run, what happened (the core
 * took every commit of the run back). Before that, the question for a commit that doesn't build on
 * its own: "Go to the problem" / "Create anyway".
 */
import { useEffect, useState } from "react";
import type { CoreError } from "../../core";
import { core } from "../../core";
import { showDialog } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { useAppStore } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { cn, laneColor } from "../../ui/cn";
import { t } from "../../i18n";
import { progressOf } from "./model";

export type Settled<T> = { ok: true; value: T } | { ok: false; error: CoreError };

export interface ApplyStep {
  title: string;
}

export interface ApplyDialogProps {
  jobId: string;
  steps: ApplyStep[];
  /** Commit hooks of the repository (empty: none). */
  hooks: string[];
  skipHooks: boolean;
  settled: Promise<Settled<{ steps: { hooks: string[] }[] }>>;
  onDone: (value: "undo" | "done" | null) => void;
}

const list = (names: string[]) => names.join(", ");

export function ApplyDialog({ jobId, steps, hooks, skipHooks, settled, onDone }: ApplyDialogProps) {
  const line = useAppStore((store) => store.jobs[jobId]?.line);
  const [outcome, setOutcome] = useState<Settled<{ steps: { hooks: string[] }[] }> | null>(null);
  // The last commit the core reported: on failure that is the one that stopped.
  const [reached, setReached] = useState(1);
  const progress = progressOf(line);
  useEffect(() => {
    if (progress) setReached(progress.current);
  }, [progress?.current]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    void settled.then((value) => {
      if (alive) setOutcome(value);
    });
    return () => {
      alive = false;
    };
  }, [settled]);

  const total = steps.length;
  const running = outcome === null;
  const current = running ? (progress?.current ?? 1) : reached;
  const hooksRun = !skipHooks && hooks.length > 0;
  const title = running ? t("wip.compose.run.progress", { current, total }) : outcome.ok ? t("wip.compose.run.created", { count: total }) : t("wip.compose.run.failed");
  const note = [skipHooks ? t("wip.compose.run.hooksSkipped") : hooks.length > 0 ? t("wip.compose.run.hooks", { hooks: list(hooks) }) : t("wip.compose.run.noHooks"), t("wip.compose.run.untouched")].join(" ");

  const stateOf = (index: number): { text: string; tone: "done" | "run" | "wait" | "failed" } => {
    const number = index + 1;
    if (outcome?.ok) {
      const ran = outcome.value.steps[index]?.hooks ?? [];
      return { text: ran.length > 0 ? t("wip.compose.run.doneHooks", { hooks: list(ran) }) : t("wip.compose.run.done"), tone: "done" };
    }
    if (outcome && !outcome.ok) {
      if (number === current) return { text: outcome.error.code === "hook_failed" ? t("wip.compose.run.rejected") : describeError(outcome.error).text, tone: "failed" };
      return { text: t("wip.compose.run.waiting"), tone: "wait" };
    }
    if (number < current) return { text: t("wip.compose.run.done"), tone: "done" };
    if (number === current) return { text: hooksRun ? t("wip.compose.run.hooksRunning") : t("wip.compose.run.creating"), tone: "run" };
    return { text: t("wip.compose.run.waiting"), tone: "wait" };
  };

  const footer = running ? (
    <Button data-compose-run-cancel="" onClick={() => void core.jobCancel({ jobId })}>
      {t("wip.compose.run.cancel")}
    </Button>
  ) : outcome.ok ? (
    <>
      <Button data-compose-run-undo="" onClick={() => onDone("undo")}>
        {t("wip.compose.run.undo")}
      </Button>
      <Button variant="primary" data-compose-run-done="" data-autofocus autoFocus onClick={() => onDone("done")}>
        {t("wip.compose.run.finish")}
      </Button>
    </>
  ) : (
    <Button variant="primary" data-compose-run-close="" data-autofocus autoFocus onClick={() => onDone(null)}>
      {t("wip.compose.run.close")}
    </Button>
  );

  return (
    <Dialog
      open
      size="sm"
      title={title}
      onOpenChange={(open) => {
        // While the commits are being created the dialog stays; Esc afterwards is "Done".
        if (!open && !running) onDone(outcome.ok ? "done" : null);
      }}
      footer={footer}
    >
      <div data-compose-run="" data-state={running ? "running" : outcome.ok ? "done" : "failed"} className="grid gap-3">
        <p className="sr-only" aria-live="polite">
          {title}
        </p>
        <ul className="m-0 grid list-none gap-2 p-0">
          {steps.map((step, index) => {
            const state = stateOf(index);
            return (
              <li key={index} data-compose-run-step={String(index)} data-state={state.tone} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 text-sm">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: laneColor(index) }} aria-hidden />
                <span className="truncate text-text">{step.title}</span>
                <span className={cn("text-xs", state.tone === "done" ? "text-success" : state.tone === "run" ? "text-accent" : state.tone === "failed" ? "text-danger" : "text-text-muted")}>{state.text}</span>
              </li>
            );
          })}
        </ul>
        {outcome && !outcome.ok ? (
          <div className="grid gap-2" role="alert">
            <p className="m-0 text-sm text-text">{describeError(outcome.error).text}</p>
            {outcome.error.gitOutput?.trim() ? (
              <pre className="selectable m-0 max-h-40 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-code whitespace-pre-wrap text-text-muted">{outcome.error.gitOutput.trim()}</pre>
            ) : null}
            <p className="m-0 text-xs text-text-muted">{t("wip.compose.run.rolledBack")}</p>
          </div>
        ) : (
          <p className="m-0 text-xs text-text-muted">{note}</p>
        )}
      </div>
    </Dialog>
  );
}

export function showApply(props: Omit<ApplyDialogProps, "onDone">): Promise<"undo" | "done" | null> {
  return showDialog<"undo" | "done">((done) => <ApplyDialog {...props} onDone={(value) => done(value)} />);
}

/** "A commit doesn't build on its own": go to the problem or create the commits anyway. */
export function askBroken(text: string): Promise<"fix" | "go" | null> {
  return showDialog<"fix" | "go">((done) => (
    <Dialog
      open
      size="sm"
      title={t("wip.compose.broken.title")}
      description={`${text} ${t("wip.compose.broken.why")}`}
      onOpenChange={(open) => {
        if (!open) done(null);
      }}
      footer={
        <>
          <Button data-compose-broken-fix="" data-autofocus autoFocus onClick={() => done("fix")}>
            {t("wip.compose.broken.fix")}
          </Button>
          <Button variant="primary" data-compose-broken-go="" onClick={() => done("go")}>
            {t("wip.compose.broken.anyway")}
          </Button>
        </>
      }
    />
  ));
}
