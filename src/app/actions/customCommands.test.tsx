import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailList } from "../dialogs";
import { runConfirmation } from "./customCommands";

const LINE = "git tag -a v2.0 -m v2.0 9f1e56080073d4b1c2a3e4f5a6b7c8d9e0f1a2b3";

describe("runConfirmation", () => {
  it("shows the whole command line, wrapped instead of cut off", () => {
    const options = runConfirmation("Tag", { status: "confirm", display: LINE, cwd: "/r/repo" });
    expect(options.details).toEqual([LINE]);
    expect(options.detailsWrap).toBe(true);
  });
});

describe("DetailList", () => {
  it("cuts long entries by default and wraps them on request", () => {
    const cut = renderToStaticMarkup(<DetailList items={[LINE]} />);
    expect(cut).toContain("truncate");
    const wrapped = renderToStaticMarkup(<DetailList items={[LINE]} wrap />);
    expect(wrapped).not.toContain("truncate");
    expect(wrapped).toContain("break-all");
    expect(wrapped).toContain(LINE);
  });
});
