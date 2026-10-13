import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";

/** For tests and for WebViews without a Clipboard API: the text copied last. */
let lastCopied: string | null = null;
export const lastCopiedText = () => lastCopied;

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const previous = document.activeElement;
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  if (previous instanceof HTMLElement) previous.focus();
  return ok;
}

/**
 * Copies text to the clipboard and briefly confirms it. `what` names what was copied
 * ("SHA", "branch name"), for the message.
 */
export async function copyText(text: string, what: string): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text);
  }
  if (ok) {
    lastCopied = text;
    toast({ tone: "success", title: t("actions.clipboard.copied", { what }), description: text.length > 120 ? `${text.slice(0, 119)}…` : text });
  } else {
    toast({ tone: "danger", title: t("actions.clipboard.failed"), description: t("actions.clipboard.failedDescription") });
  }
  return ok;
}
