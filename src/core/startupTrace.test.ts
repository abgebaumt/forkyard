import { describe, expect, it } from "vitest";
import { addCall, addMark, createTrace, toReport } from "./startupTrace";

describe("startup trace", () => {
  it("keeps the first time of each mark and the calls with their duration", () => {
    const trace = createTrace(1_760_000_000_000.5);
    expect(addMark(trace, "script", 180.4)).toBe(true);
    expect(addMark(trace, "script", 900)).toBe(false);
    addCall(trace, "app_info", 200, 260.5);
    addCall(trace, "graph_page", 410, 690);
    expect(addMark(trace, "graph", 702)).toBe(true);
    expect(toReport(trace)).toEqual({
      timeOrigin: 1_760_000_000_000.5,
      marks: [
        { name: "script", at: 180.4 },
        { name: "graph", at: 702 },
      ],
      calls: [
        { command: "app_info", start: 200, ms: 60.5 },
        { command: "graph_page", start: 410, ms: 280 },
      ],
    });
  });

  it("ignores what happens a minute after the start and everything once reported", () => {
    const trace = createTrace(0);
    expect(addMark(trace, "graph", 61_000)).toBe(false);
    addCall(trace, "status_get", 60_500, 60_600);
    expect(toReport(trace).calls).toEqual([]);
    trace.reported = true;
    expect(addMark(trace, "shell", 10)).toBe(false);
    addCall(trace, "tabs_list", 5, 9);
    expect(toReport(trace)).toEqual({ timeOrigin: 0, marks: [], calls: [] });
  });
});
