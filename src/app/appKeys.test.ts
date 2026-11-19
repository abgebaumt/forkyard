import { describe, expect, it } from "vitest";
import { APP_KEYS } from "./coreSync";
import { qk } from "./queries";

describe("APP_KEYS", () => {
  it("maps the profile-dependent lists to their query keys", () => {
    expect(APP_KEYS.credentials).toBe(qk.credentials);
    expect(APP_KEYS.ssh_keys).toBe(qk.sshKeys);
  });
});
