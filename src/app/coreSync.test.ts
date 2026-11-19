import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateRepo } from "./coreSync";
import { keepFirstPage, qk } from "./queries";

const three: InfiniteData<string, string | null> = { pages: ["a", "b", "c"], pageParams: [null, "x", "y"] };

describe("keepFirstPage", () => {
  it("passes undefined through", () => expect(keepFirstPage(undefined)).toBeUndefined());
  it("keeps a single page as the same object", () => {
    const one = { pages: ["a"], pageParams: [null] };
    expect(keepFirstPage(one)).toBe(one);
  });
  it("trims three pages to the first", () => expect(keepFirstPage(three)).toEqual({ pages: ["a"], pageParams: [null] }));
});

describe("invalidateRepo", () => {
  it("leaves one graph page after a refs change", async () => {
    const client = new QueryClient();
    client.setQueryData(qk.graph("r"), three);
    await invalidateRepo(client, "r", ["refs"]);
    expect(client.getQueryData<InfiniteData<string>>(qk.graph("r"))?.pages).toEqual(["a"]);
  });
  it("keeps all pages on an unrelated change", async () => {
    const client = new QueryClient();
    client.setQueryData(qk.graph("r"), three);
    await invalidateRepo(client, "r", ["locks"]);
    expect(client.getQueryData<InfiniteData<string>>(qk.graph("r"))?.pages).toHaveLength(3);
  });
});
