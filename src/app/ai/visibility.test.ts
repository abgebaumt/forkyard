import { describe, expect, it } from "vitest";
import type { AiStatus } from "../../core";
import { aiVisibility, featureVisible } from "./visibility";

const status = (patch: Partial<AiStatus>): AiStatus => ({
  state: "unset",
  provider: null,
  model: null,
  connected: false,
  keyHint: null,
  local: false,
  price: null,
  introPending: false,
  featuresOff: [],
  ...patch,
});

describe("AI visibility (spec 1.3)", () => {
  it.each([
    ["unset", false, { startEntry: true, setupCommand: true, elements: false, elementsOpenSetup: false }],
    ["unset", true, { startEntry: true, setupCommand: true, elements: false, elementsOpenSetup: false }],
    ["off", false, { startEntry: false, setupCommand: false, elements: false, elementsOpenSetup: false }],
    ["off", true, { startEntry: false, setupCommand: false, elements: false, elementsOpenSetup: false }],
    ["on", true, { startEntry: false, setupCommand: false, elements: true, elementsOpenSetup: false }],
    ["on", false, { startEntry: false, setupCommand: true, elements: true, elementsOpenSetup: true }],
  ] as const)("state %s, connected %s", (state, connected, expected) => {
    expect(aiVisibility(status({ state, connected }))).toEqual(expected);
  });

  it("shows nothing while the status is unknown", () => {
    expect(aiVisibility(undefined)).toEqual({ startEntry: false, setupCommand: false, elements: false, elementsOpenSetup: false });
  });

  it("hides an element whose function or repository is off", () => {
    const on = status({ state: "on", connected: true, featuresOff: ["compose"] });
    expect(featureVisible(on, "commit_message", false)).toBe(true);
    expect(featureVisible(on, "compose", false)).toBe(false);
    expect(featureVisible(on, "commit_message", true)).toBe(false);
    expect(featureVisible(status({ state: "off" }), "commit_message", false)).toBe(false);
  });
});
