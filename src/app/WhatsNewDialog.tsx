import { t } from "../i18n";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

/** Highlights of a new version; `done(true)` = "Full changelog", `done(null)` = closed. */
export function WhatsNewDialog({ version, items, done }: { version: string; items: string[]; done: (more: boolean | null) => void }) {
  return (
    <Dialog
      open
      size="md"
      title={t("updates.whatsNew.title", { version })}
      onOpenChange={(open) => {
        if (!open) done(null);
      }}
      footer={
        <>
          <Button onClick={() => done(true)}>{t("updates.whatsNew.fullChangelog")}</Button>
          <Button variant="primary" autoFocus onClick={() => done(null)}>
            {t("updates.whatsNew.go")}
          </Button>
        </>
      }
    >
      <ul className="flex list-disc flex-col gap-2 pl-5 text-base">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Dialog>
  );
}
