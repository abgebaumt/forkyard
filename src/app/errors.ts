import { CoreError, type ErrorCode } from "../core";
import { t } from "../i18n";

export interface ErrorInfo {
  /** What happened, as a complete sentence. */
  text: string;
  /** What one can do now. Empty if there is nothing to do. */
  hint: string;
}

/** Every ErrorCode; the type enforces that none is missing. The texts live under `errors.<code>`. */
const CODES: Record<ErrorCode, true> = {
  not_a_repo: true,
  path_not_found: true,
  path_exists: true,
  git_missing: true,
  git_too_old: true,
  invalid_name: true,
  name_exists: true,
  not_found: true,
  dirty_worktree: true,
  conflict: true,
  nothing_to_commit: true,
  empty_message: true,
  identity_missing: true,
  hook_failed: true,
  push_rejected: true,
  no_upstream: true,
  no_remote: true,
  auth_failed: true,
  host_key_unknown: true,
  offline: true,
  timeout: true,
  stale_state: true,
  locked: true,
  not_merged: true,
  operation_in_progress: true,
  no_operation: true,
  not_allowed: true,
  nothing_to_undo: true,
  cancelled: true,
  duplicate: true,
  unsupported: true,
  io: true,
  unknown: true,
  host_not_connected: true,
  host_auth_failed: true,
  host_rate_limited: true,
  host_not_found: true,
  host_unsupported: true,
  host_rejected: true,
  host_forbidden: true,
  repo_untrusted: true,
  repo_other_profile: true,
  bisect_active: true,
  command_untrusted: true,
  signing_failed: true,
  ai_disabled: true,
  ai_not_configured: true,
  ai_provider_unavailable: true,
  ai_not_logged_in: true,
  ai_invalid_answer: true,
  ai_refused: true,
  ai_limit_reached: true,
  ai_too_large: true,
  ai_unsupported_version: true,
};

/** Error code → understandable sentence with a suggested action. Covers every ErrorCode. */
export const errorInfo = Object.fromEntries(
  (Object.keys(CODES) as ErrorCode[]).map((code) => [
    code,
    { text: t(`errors.${code}.text`), hint: t(`errors.${code}.hint`) },
  ]),
) as Record<ErrorCode, ErrorInfo>;

export function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) return error;
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return new CoreError(error as CoreError);
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return new CoreError({ code: "unknown", message, gitOutput: null });
}

/** Text for toasts and banners: the core's message (if any) plus a suggested action. */
export function describeError(error: unknown): { text: string; hint: string } {
  const coreError = toCoreError(error);
  const info = errorInfo[coreError.code] ?? errorInfo.unknown;
  const message = coreError.message.trim();
  // If the core's message already says what to do, the generic advice would only repeat it.
  return { text: message || info.text, hint: message && givesAdvice(message) ? "" : info.hint };
}

/** Whether a sentence from the core already contains an instruction ("Please …", "Choose …", "Check …"; German and English). */
const ADVICE =
  /(^|[.:!?–]\s+|„|“)(Please|Choose|Select|Check|Open|Save|Push|Pull|Fetch|Clone|Compare|Remove|Commit|Stash|Wait|Close|Delete|Tick|Try|Install|Update|Use|Add|Create|Set|Start|Run|Take|Resolve|Enter|Connect|Sign in|Make sure|Rename|Move|Restart|Finish|Abort|Do not try|First |Bitte|Wähle|Prüfe|Öffne|Speichere|Pushe|Klone|Vergleiche|Entferne|Committe|Stashe|Warte|Schließe|Lösche|Hake|Versuche|Installiere|Aktualisiere|Verwende|Füge|Lege|Stelle|Starte|Nimm|Hole|Nicht noch einmal|Ausweg|Hier sind|Erst )/u;
export const givesAdvice = (message: string) => ADVICE.test(message);
