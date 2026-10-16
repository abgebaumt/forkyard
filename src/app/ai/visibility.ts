/**
 * Visibility of AI elements by state (spec 1.3, Entscheidung 11):
 *
 * | state                     | start page entry | palette "Set up AI …" | other AI elements            |
 * | unset                     | yes              | yes                   | hidden                       |
 * | off (on purpose)          | –                | –                     | hidden                       |
 * | on, provider connected    | –                | –                     | shown (per function/repo)    |
 * | on, provider missing      | –                | yes                   | shown, a click opens setup   |
 *
 * Settings › AI is always there. While the status is unknown, nothing is shown.
 */
import type { AiFeature, AiStatus } from "../../core";

export interface AiVisibility {
  startEntry: boolean;
  setupCommand: boolean;
  elements: boolean;
  elementsOpenSetup: boolean;
}

const NONE: AiVisibility = { startEntry: false, setupCommand: false, elements: false, elementsOpenSetup: false };

export function aiVisibility(status: AiStatus | null | undefined): AiVisibility {
  if (!status) return NONE;
  switch (status.state) {
    case "unset":
      return { startEntry: true, setupCommand: true, elements: false, elementsOpenSetup: false };
    case "off":
      return NONE;
    case "on":
      return status.connected
        ? { startEntry: false, setupCommand: false, elements: true, elementsOpenSetup: false }
        : { startEntry: false, setupCommand: true, elements: true, elementsOpenSetup: true };
  }
}

/** One AI element: AI shown, its function on, its repository not "AI off". */
export function featureVisible(status: AiStatus | null | undefined, feature: AiFeature, repoAiOff: boolean): boolean {
  return aiVisibility(status).elements && !(status?.featuresOff ?? []).includes(feature) && !repoAiOff;
}
