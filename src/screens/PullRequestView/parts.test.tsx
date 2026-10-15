import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultCapabilities } from "../../app/actions/hostTypes";
import { LabelsBlock } from "./parts";

describe("LabelsBlock", () => {
  it("is left out for a host without pull request labels", () => {
    expect(renderToStaticMarkup(<LabelsBlock labels={[]} capabilities={defaultCapabilities.bitbucket} />)).toBe("");
  });

  it("shows the labels or the empty note where the host has labels", () => {
    expect(renderToStaticMarkup(<LabelsBlock labels={["bug"]} capabilities={defaultCapabilities.github} />)).toContain("bug");
    expect(renderToStaticMarkup(<LabelsBlock labels={[]} capabilities={defaultCapabilities.github} />)).toContain("data-pr-labels");
  });
});
