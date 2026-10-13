/**
 * May a view that is just appearing (file view, history, blame) take focus?
 *
 * Views load their content afterwards and set focus once it is there – that can take a
 * moment. If the user has opened something else in the meantime (a dialog, a menu, the
 * Command Palette, the preferences), focus belongs there: otherwise the view would take it
 * away, and whatever the user is typing would land in the view as shortcuts.
 */
import { hasOpenDialog } from "./dialogs";
import { hasOpenMenu } from "./menus/host";
import { useAppStore } from "./store";

export function viewMayTakeFocus(): boolean {
  return !hasOpenDialog() && !hasOpenMenu() && !useAppStore.getState().overlay;
}
