/**
 * Opening a repository that only other profiles list (`repo_other_profile`): ask whether to
 * switch to that profile or also list the repository in the active profile.
 * The dependencies come from outside so the flow can be tested without the core.
 */
import { t } from "../../i18n";
import type { ChooseOptions } from "../dialogs";
import type { Profile, ProfileRef } from "../../core";

export interface OtherProfileDeps<R> {
  /** The profiles other than the active one that list the repository. */
  owners(path: string): Promise<ProfileRef[]>;
  profiles(): Promise<Profile[]>;
  ask(question: ChooseOptions): Promise<string | null>;
  switchTo(profile: Profile): Promise<boolean>;
  /** `add`: also list it in the active profile. */
  open(path: string, add: boolean): Promise<R>;
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The prompt: per owning profile "Switch to …", plus "Also open in …". */
export function otherProfileQuestion(path: string, owners: ProfileRef[], current: string): ChooseOptions {
  const name = folderName(path);
  const single = owners.length === 1 ? owners[0] : null;
  return {
    title: single ? t("actions.otherProfile.titleOne", { name, profile: single.name }) : t("actions.otherProfile.titleMany", { name }),
    description: t("actions.otherProfile.description", { current }),
    options: [
      ...owners.map((owner) => ({
        key: `switch:${owner.id}`,
        label: t("actions.otherProfile.switch", { profile: owner.name }),
        description: t("actions.otherProfile.switchDescription"),
      })),
      { key: "add", label: t("actions.otherProfile.add", { profile: current }), description: t("actions.otherProfile.addDescription") },
    ],
  };
}

/** Asks and carries out the choice; null on cancel or if the switch did not happen. */
export async function openFromOtherProfile<R>(path: string, deps: OtherProfileDeps<R>): Promise<R | null> {
  const [owners, profiles] = await Promise.all([deps.owners(path), deps.profiles()]);
  const current = profiles.find((profile) => profile.isActive)?.name ?? "";
  const answer = await deps.ask(otherProfileQuestion(path, owners, current));
  if (!answer) return null;
  if (answer === "add") return deps.open(path, true);
  const target = profiles.find((profile) => `switch:${profile.id}` === answer);
  if (!target || !(await deps.switchTo(target))) return null;
  return deps.open(path, false);
}
