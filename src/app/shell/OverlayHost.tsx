import { lazy, Suspense } from "react";
import type { Id } from "../../core";
import { CommandPalette } from "../../screens/CommandPalette";
import { installDevHooks } from "../devHooks";
import { MenuHost } from "../menus/host";
import { useAppStore, type Overlay } from "../store";

installDevHooks();

// Loaded when first opened, not during the start (separate chunks).
const ActivityLog = lazy(() => import("../../screens/ActivityLog").then((module) => ({ default: module.ActivityLog })));
const CloneDialog = lazy(() => import("../../screens/CloneDialog").then((module) => ({ default: module.CloneDialog })));
const InitDialog = lazy(() => import("../../screens/InitDialog").then((module) => ({ default: module.InitDialog })));
const Preferences = lazy(() => import("../../screens/Preferences").then((module) => ({ default: module.Preferences })));
const RemoteDialog = lazy(() => import("../../screens/RemoteDialog").then((module) => ({ default: module.RemoteDialog })));
const ShortcutOverlay = lazy(() => import("../../screens/Shortcuts").then((module) => ({ default: module.ShortcutOverlay })));
const LfsDialog = lazy(() => import("../../screens/Lfs").then((module) => ({ default: module.LfsDialog })));
const RepoCleanupDialog = lazy(() => import("../../screens/RepoCleanup").then((module) => ({ default: module.RepoCleanupDialog })));
const SubmoduleDialog = lazy(() => import("../../screens/SubmoduleDialog").then((module) => ({ default: module.SubmoduleDialog })));

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
    case "repo_cleanup":
      return <RepoCleanupDialog repoId={overlay.repoId} onClose={close} />;
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
      {overlay ? (
        <Suspense fallback={null}>
          <OverlayContent overlay={overlay} repoId={repoId} close={close} />
        </Suspense>
      ) : null}
      <MenuHost />
    </>
  );
}
