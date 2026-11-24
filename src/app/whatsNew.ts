/** "What's new" after an update: shown once per version, from the highlights in `updates.json` (en + de). */
import { createElement } from "react";
import { core } from "../core";
import { i18n, t } from "../i18n";
import { openInBrowser } from "./actions/hosts";
import { showDialog } from "./dialogs";
import { WhatsNewDialog } from "./WhatsNewDialog";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** "1.3.0" (or "1.3.0-dev") → "updates.whatsNew.1_3_0.items"; not x.y.z → null. */
export function whatsNewKey(version: string): string | null {
  const match = VERSION.exec(version);
  return match ? `updates.whatsNew.${match[1]}_${match[2]}_${match[3]}.items` : null;
}

/** The highlights of a version, else those of its x.y.0 (a patch release brings no own list); null when there are none. */
export function whatsNewItems(version: string): string[] | null {
  return itemsAt(whatsNewKey(version)) ?? itemsAt(whatsNewKey(version.replace(VERSION, "$1.$2.0")));
}

function itemsAt(key: string | null): string[] | null {
  if (!key) return null;
  const items: unknown = i18n.t(key, { returnObjects: true });
  return Array.isArray(items) && items.length > 0 && items.every((item) => typeof item === "string") ? (items as string[]) : null;
}

export const changelogUrl = (version: string) => `https://github.com/abgebaumt/forkyard/releases/tag/v${version}`;

/** Asks the core once after start; the core remembers the version as shown. Quiet on errors. */
export async function showWhatsNewOnce(): Promise<void> {
  try {
    const raw = await core.updateWhatsNew();
    const items = raw ? whatsNewItems(raw) : null;
    if (!raw || !items) return;
    const version = raw.replace(/[-+].*$/, "");
    const more = await showDialog<boolean>((done) => createElement(WhatsNewDialog, { version, items, done }));
    if (more) await openInBrowser(changelogUrl(version), t("updates.page"));
  } catch {
    // The notice is a courtesy; never disturb the start.
  }
}
