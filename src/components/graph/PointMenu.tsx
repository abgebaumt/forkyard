import { PopupMenu, type MenuEntry } from "../../ui/Menu";

export interface PointMenuState {
  /** Position in the window (clientX/clientY, unzoomed). */
  x: number;
  y: number;
  entries: MenuEntry[];
  /** For screen readers and tests, e.g. "Actions for commit 1a2b3c4". */
  label: string;
}

export interface PointMenuProps {
  menu: PointMenuState | null;
  onClose: () => void;
  /** Where focus goes after closing if it would otherwise be nowhere (e.g. after dragging a label). */
  restoreFocus?: () => void;
}

const DIALOG = '[role="dialog"], [role="alertdialog"]';

/**
 * Menu at a freely chosen spot: for context menus whose entries are only fixed when opening
 * (one instance for the whole list instead of one per row), and for the menu at the
 * drop spot after dragging a branch.
 *
 * It is drawn by the shared menu (src/ui/Menu.tsx): disabled entries name their
 * reason, submenus (reset: soft, mixed, hard) open, long names are in the tooltip.
 */
export function PointMenu({ menu, onClose, restoreFocus }: PointMenuProps) {
  if (!menu) return null;
  return (
    <PopupMenu
      entries={menu.entries}
      point={{ x: menu.x, y: menu.y }}
      label={menu.label}
      onClose={() => {
        onClose();
        // The menu returns focus to where it was before. If it was nowhere (the menu came after
        // dragging with the mouse), it goes to the row – unless an entry has opened a prompt.
        window.setTimeout(() => {
          if (document.querySelector(DIALOG)) return;
          if (!document.activeElement || document.activeElement === document.body) restoreFocus?.();
        }, 0);
      }}
    />
  );
}
