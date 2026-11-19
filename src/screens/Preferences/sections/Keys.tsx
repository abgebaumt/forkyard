/** Keyboard shortcuts: the registry commands' keys, changeable; the fixed keys stay in the overview. */
import { useState } from "react";
import { TextField } from "../../../ui/Field";
import { KeybindingEditor } from "../../Shortcuts/KeybindingEditor";
import { SectionHeader } from "../parts";
import { t } from "../../../i18n";

export function KeysSection() {
  const [filter, setFilter] = useState("");
  return (
    <div data-preferences-section="keys">
      <SectionHeader title={t("preferences.sections.keys.label")}>{t("keys.description")}</SectionHeader>
      <TextField
        type="search"
        aria-label={t("keys.filter")}
        placeholder={t("keys.filter")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="mb-3 max-w-80"
      />
      <KeybindingEditor filter={filter} />
      <p className="mt-2 text-sm text-text-muted">{t("keys.fixedElsewhere")}</p>
    </div>
  );
}
