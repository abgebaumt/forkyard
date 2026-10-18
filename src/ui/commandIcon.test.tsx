import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandIcon } from "./commandIcon";

const html = (platform: "mac" | "windows" | "linux") => renderToStaticMarkup(<CommandIcon platform={platform} className="size-icon" aria-hidden />);

describe("CommandIcon", () => {
  it("draws a neutral prompt icon on Windows and Linux", () => {
    for (const platform of ["windows", "linux"] as const) {
      expect(html(platform)).toContain("lucide-square-chevron-right");
      expect(html(platform)).not.toContain("lucide-command");
    }
  });

  it("keeps the ⌘ key on macOS", () => {
    expect(html("mac")).toContain("lucide-command");
    expect(html("mac")).not.toContain("lucide-square-chevron-right");
  });

  it("passes the props on", () => {
    expect(html("linux")).toContain("size-icon");
    expect(html("linux")).toContain('aria-hidden="true"');
  });
});

const SOURCES = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/ui/commandIcon.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("the ⌘ icon", () => {
  it("is imported from lucide-react only by the CommandIcon helper", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
        const names = (match[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
        if (names.some((name) => name === "Command" || name === "CommandIcon" || name === "LucideCommand")) offenders.push(file);
      }
      if (/from\s*["']lucide-react\/dist\/esm\/icons\/command/.test(source) || /\*\s*as\s+\w+\s+from\s*["']lucide-react["']/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
