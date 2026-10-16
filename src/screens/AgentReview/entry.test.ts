import { describe, expect, it } from "vitest";
import { getCommands } from "../../app/registry";
import { ACTION_LABELS } from "../Agents/rowActions";

describe("ways into the agent review", () => {
  it("the palette offers “Review coding agent …” without a shortcut", () => {
    const command = getCommands().find((item) => item.id === "agents.review");
    expect(command?.title).toBe("Review coding agent …");
    expect(command?.group).toBe("Repository");
    expect(command?.keywords).toContain("take over");
    expect(command?.shortcut).toBeUndefined();
  });

  it("the cockpit names the action", () => {
    expect(ACTION_LABELS.review).toBe("Review changes");
  });
});
