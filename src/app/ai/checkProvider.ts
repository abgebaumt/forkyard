import type { AiStatus } from "../../core";
import { openAiSetup } from "./open";
import { aiVisibility } from "./visibility";

/**
 * Before an AI element sends: with AI on but no provider connected the click opens the setup
 * instead. Returns whether the caller may go on.
 */
export function checkProvider(status: AiStatus | null | undefined): boolean {
  if (!aiVisibility(status).elementsOpenSetup) return true;
  void openAiSetup();
  return false;
}
