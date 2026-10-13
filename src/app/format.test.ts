import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatRelative, formatShortDate, UNKNOWN_DATE } from "./format";

/** Local time: year 2026, month October (9), day, hour, minute. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0);

describe("formatRelative: yesterday and the day before are calendar days", () => {
  it("23:55 the day before yesterday is \"2 days ago\" in the morning, not \"yesterday\"", () => {
    expect(formatRelative(at(10, 23, 55), at(12, 5, 3).getTime())).toBe("2 days ago");
  });

  it("00:05 yesterday is \"yesterday\" at any time of day", () => {
    for (const [hour, minute] of [[0, 10], [5, 24], [12, 30], [23, 30]] as const) {
      expect(formatRelative(at(11, 0, 5), at(12, hour, minute).getTime())).toBe("yesterday");
    }
    expect(formatRelative(at(10, 0, 5), at(12, 13, 0).getTime())).toBe("2 days ago");
  });

  it("the same calendar day stays in hours – 00:20 today is not \"yesterday\" at 23:30", () => {
    expect(formatRelative(at(12, 0, 20), at(12, 23, 30).getTime())).toBe("23 hours ago");
    expect(formatRelative(at(11, 1, 0), at(12, 23, 30).getTime())).toBe("yesterday");
  });

  it("under 22 hours shows hours, also across midnight and into the future", () => {
    expect(formatRelative(at(11, 23, 0), at(12, 8, 0).getTime())).toBe("9 hours ago");
    expect(formatRelative(at(13, 1, 0), at(12, 22, 0).getTime())).toBe("in 3 hours");
  });

  it("minutes, days, months and years as before", () => {
    const now = at(12, 12, 0).getTime();
    expect(formatRelative(now - 5_000, now)).toBe("just now");
    expect(formatRelative(now - 10 * 60_000, now)).toBe("10 minutes ago");
    expect(formatRelative(at(5, 9, 0), now)).toBe("7 days ago");
    expect(formatRelative(new Date(2026, 6, 12, 12, 0), now)).toBe("3 months ago");
    expect(formatRelative(new Date(2023, 9, 12, 12, 0), now)).toBe("3 years ago");
  });
});

describe("unparseable timestamps do not break the view", () => {
  // This is how the core wrote a date in the year 10000 – `new Date()` cannot parse it.
  const broken = "+10000-01-01T00:00:00.000Z";

  it("all formats return a text instead of throwing", () => {
    expect(formatDateTime(broken)).toBe(UNKNOWN_DATE);
    expect(formatShortDate(broken)).toBe(UNKNOWN_DATE);
    expect(formatRelative(broken)).toBe(UNKNOWN_DATE);
    for (const format of ["relative", "iso", "local"] as const) expect(formatDate(broken, format)).toBe(UNKNOWN_DATE);
  });

  it("the extended six-digit notation is parseable", () => {
    expect(formatDateTime("+010000-01-01T00:00:00.000Z")).toMatch(/10000/);
  });
});
