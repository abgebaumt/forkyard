import { describe, expect, it } from "vitest";
import type { CrashReportSummary } from "../../core";
import { t } from "../../i18n";
import { crashReportFileName, crashReportLine, crashReportTitle } from "./model";

const report = (overrides: Partial<CrashReportSummary> = {}): CrashReportSummary => ({
  id: "20261014T120000123Z-ab12cd34",
  time: "2026-10-14T12:00:00.123Z",
  kind: "panic",
  appVersion: "1.0.0",
  message: "index out of bounds: the len is 3 but the index is 7",
  ...overrides,
});

describe("crash report model", () => {
  it("suggests a file name that carries the report id", () => {
    expect(crashReportFileName(report())).toBe("forkyard-crash-20261014T120000123Z-ab12cd34.txt");
  });

  it("names the kind, the version and the message in one line", () => {
    const line = crashReportLine(report());
    expect(line).toContain(t("crash.kind.panic"));
    expect(line).toContain("1.0.0");
    expect(line).toContain("index out of bounds");
    expect(crashReportLine(report({ kind: "unexpected_exit" }))).toContain(t("crash.kind.unexpectedExit"));
  });

  it("formats the time for people and keeps an unreadable time as it is", () => {
    expect(crashReportLine(report())).not.toContain("2026-10-14T12:00:00.123Z");
    expect(crashReportLine(report({ time: "not a time" }))).toContain("not a time");
  });

  it("shortens long messages", () => {
    const line = crashReportLine(report({ message: "x".repeat(500) }));
    expect(line.length).toBeLessThan(220);
    expect(line.endsWith("…")).toBe(true);
  });

  it("leaves the closing period to the sentence the line is put in", () => {
    const message = "Forkyard 1.0.0 ended without shutting down (run started x, last log line y).";
    const line = crashReportLine(report({ kind: "unexpected_exit", message }));
    expect(line.endsWith("y)")).toBe(true);
    expect(t("crash.dialog.description", { line })).not.toContain("..");
    expect(crashReportLine(report({ message: "wait..." })).endsWith("wait")).toBe(true);
  });

  it("counts the pending reports in the title", () => {
    expect(crashReportTitle(1, 0)).toBe(t("crash.dialog.title"));
    expect(crashReportTitle(3, 1)).toBe(t("crash.dialog.titleOf", { index: 2, count: 3 }));
  });
});
