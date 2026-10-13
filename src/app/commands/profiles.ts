/**
 * Profiles via the command palette: open the menu of the profile chip in front of the tab bar
 * (the registry only knows fixed commands, none per profile) or create a new profile.
 */
import { t } from "../../i18n";
import { kw, type AppCommand } from "../commandTypes";
import { useAppStore } from "../store";

export const commands: AppCommand[] = [
  {
    id: "profile.switch",
    title: t("commands.profile.switch.title"),
    group: "Allgemein",
    keywords: kw("commands.profile.switch.keywords"),
    run: () => {
      // Only after the palette has closed: otherwise its focus guard would close the menu again right away.
      requestAnimationFrame(() => useAppStore.getState().setProfileMenuOpen(true));
    },
  },
  {
    id: "profile.new",
    title: t("commands.profile.new.title"),
    group: "Allgemein",
    keywords: kw("commands.profile.new.keywords"),
    run: () => useAppStore.getState().openOverlay({ kind: "preferences", section: "profiles", createProfile: true }),
  },
];
