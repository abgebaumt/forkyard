/**
 * Changes the registry commands' shortcuts (setting `keybindings`); shared by the shortcut
 * overview and Preferences. Clicking a row's keys starts recording: the next combination is set at
 * once, a taken one asks first, a reserved one is refused with the reason. Esc cancels, Backspace
 * removes the key. While recording, no key reaches the dialogs or the global shortcuts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getBaseCommands, useCommands } from "../../app/registry";
import { remove, reset, shortcutFromEvent, type Keybindings, type Refusal } from "../../app/keybindings";
import { confirm } from "../../app/dialogs";
import { useSettings } from "../../app/queries";
import { Button } from "../../ui/Button";
import { Kbd } from "../../ui/Kbd";
import { cn } from "../../ui/cn";
import { formatShortcut, isMacShortcuts, shortcutPlatform } from "../../ui/shortcut";
import { LoadError, SettingsSkeleton } from "../Preferences/parts";
import { applySettings } from "../Preferences/settings";
import { assignKey, onRecordKey, type RecordState } from "./editor";
import { filterSections, registrySections } from "./model";
import { t } from "../../i18n";

function reasonText(reason: Refusal): string {
  if (reason.kind === "fixed") return t("keys.reason.fixed", { group: reason.group, label: reason.label });
  return t(`keys.reason.${reason.kind}`);
}

export function KeybindingEditor({ filter }: { filter: string }) {
  const commands = useCommands();
  // Undefined while loading or failed: a write would then replace every override with one entry.
  const settings = useSettings();
  const overrides = settings.data?.keybindings;
  const [state, setState] = useState<RecordState>({ kind: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => filterSections(registrySections(commands, { editing: true }), filter), [commands, filter]);

  const save = (keybindings: Keybindings) => void applySettings({ keybindings });
  const context = () => ({ effective: commands, base: getBaseCommands(), platform: shortcutPlatform() });
  const focusKey = (commandId: string) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-keybinding="${CSS.escape(commandId)}"]`)?.focus();

  useEffect(() => {
    if (state.kind === "idle" || !overrides) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // While asking about a conflict, Tab and Enter belong to its buttons; only Esc is ours.
      if (state.kind === "conflict" && event.key !== "Escape") return;
      // Window, capture phase: before Radix (Esc closes the dialog) and the global shortcuts.
      event.preventDefault();
      event.stopPropagation();
      const next = onRecordKey(state, shortcutFromEvent(event, isMacShortcuts()), event.key, context());
      setState(next.state);
      if (state.kind === "conflict") focusKey(state.commandId);
      if (next.action.kind === "set") save(assignKey(overrides, state.commandId, next.action.combo, context()));
      else if (next.action.kind === "remove") save(remove(overrides, state.commandId));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const resetAll = async () => {
    const ok = await confirm({ title: t("keys.resetAll.title"), body: t("keys.resetAll.body"), confirmLabel: t("keys.resetAll.label") });
    if (ok) save({});
  };

  if (settings.isError)
    return <LoadError title={t("preferences.loadError.settings")} error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!overrides) return <SettingsSkeleton />;

  return (
    <div ref={rootRef} data-keys-editor>
      {Object.keys(overrides).length ? (
        <div className="mb-2 flex justify-end">
          <Button size="sm" variant="ghost" data-keys-reset-all onClick={() => void resetAll()}>
            {t("keys.resetAll.label")}
          </Button>
        </div>
      ) : null}
      {sections.length === 0 ? <p className="py-4 text-base text-text-muted">{t("keys.empty", { query: filter.trim() })}</p> : null}
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`keys-${section.id}`} className="mb-5" data-section={section.id}>
          <h3 id={`keys-${section.id}`} className="text-xs font-semibold tracking-wide text-text-muted uppercase">
            {section.title}
          </h3>
          <ul className="mt-1.5 flex flex-col">
            {section.entries.map((entry) => {
              const id = entry.key;
              const mine = state.kind !== "idle" && state.commandId === id ? state : null;
              const listening = mine?.kind === "recording" || mine?.kind === "refused";
              return (
                <li key={id} className="flex flex-col border-b border-border py-1 last:border-b-0" data-entry={id}>
                  <div className="flex min-h-control-md items-center gap-3">
                    <span className="min-w-0 flex-1 text-base text-text">{entry.label}</span>
                    {Object.hasOwn(overrides, id) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-keybinding-reset={id}
                        aria-label={t("keys.reset", { command: entry.label })}
                        onClick={() => {
                          save(reset(overrides, id));
                          focusKey(id);
                        }}
                      >
                        {t("ui.reset")}
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      data-keybinding={id}
                      aria-label={
                        listening
                          ? undefined
                          : t("keys.change", {
                              command: entry.label,
                              keys: entry.keys.length
                                ? entry.keys.map((alternative) => formatShortcut(alternative.join("+"))).join(", ")
                                : t("keys.none"),
                            })
                      }
                      onClick={() => setState(listening ? { kind: "idle" } : { kind: "recording", commandId: id })}
                      onBlur={() => listening && setState({ kind: "idle" })}
                      className={cn(
                        "flex min-h-control-sm shrink-0 flex-wrap items-center justify-end gap-1 rounded-md border border-border px-2 hover:bg-surface-raised",
                        listening && "bg-accent-surface",
                      )}
                    >
                      {listening ? (
                        <span className="text-sm text-text" data-keys-recording>
                          {t("keys.recording")}
                        </span>
                      ) : entry.keys.length ? (
                        entry.keys.map(([key]) => <Kbd key={key}>{key}</Kbd>)
                      ) : (
                        <span className="text-sm text-text-muted">{t("keys.none")}</span>
                      )}
                    </button>
                  </div>
                  <div aria-live="polite">
                    {mine?.kind === "recording" ? (
                      <p className="pb-1 text-right text-sm text-text-muted">
                        <span className="sr-only">{t("keys.recording")} </span>
                        {t(isMacShortcuts() ? "keys.recordingHintMac" : "keys.recordingHint")}
                      </p>
                    ) : null}
                    {mine?.kind === "refused" ? (
                      <p className="pb-1 text-right text-sm text-danger" data-keys-refused>
                        {t("keys.refused", { reason: reasonText(mine.reason) })}
                      </p>
                    ) : null}
                    {mine?.kind === "conflict" ? (
                      <div className="flex items-center justify-end gap-2 pb-1 text-sm text-text" data-keys-conflict>
                        <Kbd>{mine.combo}</Kbd>
                        <span className="min-w-0">{t("keys.conflict", { command: mine.other.title.replace(/ …$/, "") })}</span>
                        <Button
                          size="sm"
                          data-keys-assign-anyway
                          onClick={() => {
                            setState({ kind: "idle" });
                            save(assignKey(overrides, id, mine.combo, context()));
                            focusKey(id);
                          }}
                        >
                          {t("keys.assignAnyway")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setState({ kind: "idle" });
                            focusKey(id);
                          }}
                        >
                          {t("ui.cancel")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
