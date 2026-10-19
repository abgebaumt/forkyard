/**
 * Icon for commands and the command palette. The lucide `Command` icon is the macOS ⌘ key, so only
 * macOS gets it; Windows and Linux get a neutral prompt icon. The only place that imports `Command`.
 */
import { Command, SquareChevronRight, type LucideProps } from "lucide-react";
import { isMacShortcuts, type ShortcutPlatform } from "./shortcut";

export function CommandIcon({ platform, ...props }: LucideProps & { platform?: ShortcutPlatform }) {
  const mac = platform ? platform === "mac" : isMacShortcuts();
  return mac ? <Command {...props} /> : <SquareChevronRight {...props} />;
}
