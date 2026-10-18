/** "Also": the targets besides the tag message. The external one is red and says so in words. */
import { t } from "../../i18n";
import { Checkbox } from "../../ui/Field";
import { isExternal, targetHint, targetLabel, toggleTarget, type ReleaseTarget } from "./model";

export function ReleaseTargets({
  available,
  selected,
  onChange,
  hostName,
  remote,
}: {
  available: ReleaseTarget[];
  selected: ReleaseTarget[];
  onChange: (next: ReleaseTarget[]) => void;
  hostName: string | null;
  remote: string | null;
}) {
  return (
    <fieldset className="flex flex-col gap-2" data-release-targets="">
      <legend className="mb-1 text-sm font-medium text-text">{t("actions.tags.releaseNotes.also")}</legend>
      {available.map((target) => {
        const hint = targetHint(target, remote);
        const external = isExternal(target);
        return (
          <div key={target} data-release-target={target} className="flex flex-col gap-0.5">
            <Checkbox
              label={targetLabel(target, hostName)}
              checked={selected.includes(target)}
              onCheckedChange={(on) => onChange(toggleTarget(selected, target, on))}
              hint={external ? undefined : (hint ?? undefined)}
            />
            {external && hint ? <p className="pl-6 text-sm text-danger">{hint}</p> : null}
          </div>
        );
      })}
    </fieldset>
  );
}
