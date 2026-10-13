/** About: versions, paths and platform to read and copy. */
import type { ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Copy, FolderOpen, GitBranch } from "lucide-react";
import type { Platform } from "../../../core";
import { useAppInfo } from "../../../app/queries";
import { showError } from "../../../app/run";
import { Button } from "../../../ui/Button";
import { toast } from "../../../ui/Feedback";
import { LoadError, Mono, SectionHeader, SettingsSkeleton } from "../parts";
import { t } from "../../../i18n";

const platformName: Record<Platform, string> = { windows: "Windows", linux: "Linux", macos: "macOS" };

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-4 border-b border-border py-1.5 last:border-b-0" data-fact={name}>
      <dt className="w-36 shrink-0 text-base text-text-muted">{name}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">{children}</dd>
    </div>
  );
}

export function AboutSection() {
  const appInfo = useAppInfo();
  if (appInfo.isPending) return <SettingsSkeleton rows={4} />;
  if (appInfo.isError) return <LoadError title={t("preferences.loadError.about")} error={appInfo.error} onRetry={() => void appInfo.refetch()} />;
  const info = appInfo.data;

  const summary = [
    `Forkyard ${info.version}`,
    `${t("preferences.about.summary.git", { version: info.gitVersion ?? t("preferences.about.notFound") })}${info.gitPath ? ` (${info.gitPath})` : ""}`,
    t("preferences.about.summary.platform", { name: platformName[info.platform] }),
    t("preferences.about.summary.dataDir", { path: info.dataDir }),
  ].join("\n");

  return (
    <section>
      <SectionHeader
        title={t("preferences.about.title")}
        actions={
          <Button
            icon={<Copy className="size-icon" aria-hidden />}
            onClick={() => {
              navigator.clipboard.writeText(summary).then(
                () => toast({ tone: "success", title: t("preferences.about.copied") }),
                () => toast({ tone: "danger", title: t("preferences.about.copyFailed"), description: t("preferences.about.clipboardUnavailable") }),
              );
            }}
          >
            {t("preferences.about.copy")}
          </Button>
        }
      >
        {t("preferences.about.intro")}
      </SectionHeader>

      <div className="mb-3 flex items-center gap-3 rounded-md border border-border bg-surface-raised p-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-surface text-accent" aria-hidden>
          <GitBranch className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-md font-semibold text-text">Forkyard</p>
          <p className="text-sm text-text-muted">{t("preferences.about.tagline")}</p>
        </div>
      </div>

      <dl>
        <Fact name={t("preferences.about.appVersion")}>
          <Mono>{info.version}</Mono>
        </Fact>
        <Fact name={t("preferences.about.gitVersion")}>
          {info.gitVersion ? <Mono>{info.gitVersion}</Mono> : <span className="text-danger">{t("preferences.about.notFound")}</span>}
          <span className="shrink-0 text-sm text-text-muted">{t("preferences.about.minimum", { version: info.gitMinVersion })}</span>
        </Fact>
        <Fact name={t("preferences.about.gitPath")}>{info.gitPath ? <Mono>{info.gitPath}</Mono> : <span className="text-text-muted">–</span>}</Fact>
        <Fact name={t("preferences.about.platform")}>
          <span className="selectable text-base text-text">{platformName[info.platform]}</span>
        </Fact>
        <Fact name={t("preferences.about.dataDir")}>
          <Mono className="min-w-0 flex-1">{info.dataDir}</Mono>
          <Button
            size="sm"
            icon={<FolderOpen className="size-3.5" aria-hidden />}
            onClick={() => {
              revealItemInDir(info.dataDir).catch((error: unknown) => showError(t("preferences.about.reveal"), error));
            }}
          >
            {t("preferences.about.reveal")}
          </Button>
        </Fact>
      </dl>
      <p className="mt-3 text-sm text-text-muted">
        {t("preferences.about.dataDirHint")}
      </p>

      <h3 className="mt-5 mb-1 text-md font-semibold text-text">{t("preferences.about.privacyTitle")}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text-muted" data-privacy>
        <li>{t("preferences.about.privacyGit")}</li>
        <li>{t("preferences.about.privacyHosts")}</li>
        <li>{t("preferences.about.privacyAvatars")}</li>
        <li>{t("preferences.about.privacyLinks")}</li>
      </ul>
      <p className="mt-2 text-sm text-text-muted">
        {t("preferences.about.privacyRest")}
      </p>
    </section>
  );
}
