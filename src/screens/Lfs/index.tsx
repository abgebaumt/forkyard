/** Git LFS: the section for the repository settings and the same content as its own dialog. */
import type { Id } from "../../core";
import { useAppStore } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { LfsPanel } from "./LfsPanel";
import { t } from "../../i18n";

export { LfsPanel, type LfsPanelProps } from "./LfsPanel";

/** "Git LFS" dialog – an overlay of the shell (`openOverlay({ kind: "lfs" })`), so prompts can open above it. */
export function LfsDialog({ repoId, onClose }: { repoId: Id; onClose: () => void }) {
  return (
    <Dialog
      open
      size="md"
      title={t("lfs.title")}
      description={t("lfs.description")}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={<Button onClick={onClose}>{t("lfs.close")}</Button>}
    >
      <div data-screen="lfs">
        <LfsPanel repoId={repoId} autoFocus />
      </div>
    </Dialog>
  );
}

/** Opens the LFS dialog for the repository in the active tab. */
export function openLfsDialog(): void {
  useAppStore.getState().openOverlay({ kind: "lfs" });
}
