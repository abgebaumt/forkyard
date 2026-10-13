import type { Id } from "../../core";
import { ActivityLog } from "../../screens/ActivityLog";
import { CloneDialog } from "../../screens/CloneDialog";
import { CommandPalette } from "../../screens/CommandPalette";
import { InitDialog } from "../../screens/InitDialog";
import { Preferences } from "../../screens/Preferences";
import { RemoteDialog } from "../../screens/RemoteDialog";
import { ShortcutOverlay } from "../../screens/Shortcuts";
import { LfsDialog } from "../../screens/Lfs";
import { SubmoduleDialog } from "../../screens/SubmoduleDialog";
import { installDevHooks } from "../devHooks";
import { MenuHost } from "../menus/host";
import { useAppStore, type Overlay } from "../store";

installDevHooks();

function OverlayContent({ overlay, repoId, close }: { overlay: NonNullable<Overlay>; repoId: Id | null; close: () => void }) {
  switch (overlay.kind) {
    case "clone":
      return <CloneDialog onClose={close} />;
    case "init":
      return <InitDialog onClose={close} />;
    case "palette":
      return <CommandPalette mode={overlay.mode} onClose={close} />;
    case "preferences":
      return <Preferences section={overlay.section} request={overlay} createProfile={overlay.createProfile} repoId={repoId} onClose={close} />;
    case "shortcuts":
      return <ShortcutOverlay onClose={close} />;
    case "activity":
      return <ActivityLog repoId={repoId} onClose={close} />;
    case "add_remote":
      return repoId ? <RemoteDialog repoId={repoId} edit={overlay.edit} onClose={close} /> : null;
    case "add_submodule":
      return repoId ? <SubmoduleDialog repoId={repoId} onClose={close} /> : null;
    case "lfs":
      return repoId ? <LfsDialog repoId={repoId} onClose={close} /> : null;
  }
}

/**
 * Shows the overlay from `store.overlay` (repo-related overlays need a repo tab) and the menu
 * that `openMenuAt` opens at a position in the window (drop menu, menu from a command).
 */
export function OverlayHost({ repoId }: { repoId: Id | null }) {
  const overlay = useAppStore((state) => state.overlay);
  const close = useAppStore((state) => state.closeOverlay);
  return (
    <>
      {overlay ? <OverlayContent overlay={overlay} repoId={repoId} close={close} /> : null}
      <MenuHost />
    </>
  );
}
