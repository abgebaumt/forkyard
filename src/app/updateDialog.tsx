/**
 * Install dialog: ready (notes) → downloading (progress, cancel) → downloaded (restart) or error.
 * Nothing is downloaded before the click on "Install"; the restart goes through the close guard.
 * Only offered for installable builds (`primaryAction`); other builds keep "View release".
 */
import { useState } from "react";
import { core, type UpdateRelease } from "../core";
import { t } from "../i18n";
import { SafeMarkdown } from "../components/markdown/SafeMarkdown";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Banner } from "../ui/Feedback";
import { openInBrowser } from "./actions/hosts";
import { restartForUpdate } from "./closeGuard";
import { showDialog } from "./dialogs";
import { describeError } from "./errors";
import { newJobId } from "./run";
import { useAppStore } from "./store";

type Phase = "ready" | "downloading" | "downloaded" | "error";

function UpdateDialog({ release, done }: { release: UpdateRelease; done: () => void }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [jobId] = useState(newJobId);
  const [failure, setFailure] = useState<{ text: string; hint: string } | null>(null);
  const percent = useAppStore((state) => state.jobs[jobId]?.percent ?? null);
  const openPage = () => void openInBrowser(release.url, t("updates.page"));

  async function install() {
    setPhase("downloading");
    useAppStore.getState().startJob({ id: jobId, title: t("updates.dialog.title", { version: release.version }), repoId: null });
    try {
      await core.updateDownload({ jobId, version: release.version });
      setPhase("downloaded");
    } catch (error) {
      // A cancelled download is not an error: back to the start.
      if ((error as { code?: string })?.code === "cancelled") setPhase("ready");
      else {
        setFailure(describeError(error));
        setPhase("error");
      }
    } finally {
      useAppStore.getState().finishJob(jobId);
    }
  }

  const footer =
    phase === "ready" ? (
      <>
        <Button onClick={done}>{t("updates.dialog.later")}</Button>
        <Button onClick={openPage}>{t("updates.dialog.openPage")}</Button>
        <Button variant="primary" autoFocus onClick={() => void install()}>
          {t("updates.dialog.install")}
        </Button>
      </>
    ) : phase === "downloading" ? (
      <Button onClick={() => void core.jobCancel({ jobId })}>{t("updates.dialog.cancel")}</Button>
    ) : phase === "downloaded" ? (
      <>
        <Button onClick={done}>{t("updates.dialog.later")}</Button>
        <Button variant="primary" autoFocus onClick={() => void restartForUpdate()}>
          {t("updates.dialog.restartNow")}
        </Button>
      </>
    ) : (
      <>
        <Button onClick={done}>{t("ui.close")}</Button>
        <Button variant="primary" onClick={openPage}>
          {t("updates.dialog.openPage")}
        </Button>
      </>
    );

  return (
    <Dialog
      open
      size="md"
      title={t("updates.dialog.title", { version: release.version })}
      onOpenChange={(open) => {
        if (!open && phase !== "downloading") done();
      }}
      footer={footer}
    >
      <div data-update-dialog={phase} className="flex flex-col gap-3">
        {phase === "ready" ? (
          <SafeMarkdown source={release.notes} origin={t("updates.dialog.origin")} className="max-h-72 overflow-y-auto" />
        ) : null}
        <div aria-live="polite" className="text-base">
          {phase === "downloading" ? (
            <>
              <p>{percent === null ? t("updates.dialog.downloadingUnknown") : t("updates.dialog.downloading", { percent })}</p>
              <div
                role="progressbar"
                aria-label={t("updates.dialog.progress")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                className="mt-2 h-1.5 overflow-hidden rounded-pill bg-border"
              >
                {percent === null ? (
                  <div className="h-full w-1/3 animate-pulse rounded-pill bg-accent" />
                ) : (
                  <div className="h-full rounded-pill bg-accent transition-[width]" style={{ width: `${Math.max(2, percent)}%` }} />
                )}
              </div>
            </>
          ) : null}
          {phase === "downloaded" ? <p>{t("updates.dialog.downloaded")}</p> : null}
          {phase === "error" && failure ? (
            <div className="overflow-hidden rounded-md">
              <Banner tone="danger" title={t("updates.dialog.failed")}>
                <span className="selectable">
                  {failure.text} {failure.hint}
                </span>
              </Banner>
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

export const openUpdateDialog = async (release: UpdateRelease): Promise<void> => {
  await showDialog<void>((done) => <UpdateDialog release={release} done={() => done(null)} />);
};
