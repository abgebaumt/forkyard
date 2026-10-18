import { describe, expect, it } from "vitest";
import { embedChoice, embedChoicePatch, embedModelPlaceholder, indexText } from "./searchModel";

describe("settings of the search by meaning", () => {
  it("offers the main provider or one on this computer, and a new choice starts empty", () => {
    expect(embedChoice({ aiSearchEmbedProvider: null })).toBe("main");
    expect(embedChoice({ aiSearchEmbedProvider: "lmstudio" })).toBe("lmstudio");
    expect(embedChoice({ aiSearchEmbedProvider: "openai" }), "never stored, and never offered").toBe("main");
    expect(embedChoicePatch("ollama")).toEqual({ aiSearchEmbedProvider: "ollama", aiSearchEmbedModel: null, aiSearchEmbedBaseUrl: null });
    expect(embedChoicePatch("main")).toEqual({ aiSearchEmbedProvider: null, aiSearchEmbedModel: null, aiSearchEmbedBaseUrl: null });
  });

  it("suggests a model that fits the choice", () => {
    expect(embedModelPlaceholder({ aiSearchEmbedProvider: "ollama", aiProvider: "openai" })).toBe("nomic-embed-text");
    expect(embedModelPlaceholder({ aiSearchEmbedProvider: "lmstudio", aiProvider: null })).toBe("text-embedding-nomic-embed-text-v1.5");
    expect(embedModelPlaceholder({ aiSearchEmbedProvider: null, aiProvider: "openai" })).toBe("text-embedding-3-small");
    expect(embedModelPlaceholder({ aiSearchEmbedProvider: null, aiProvider: "gemini" })).toBe("gemini-embedding-001");
    expect(embedModelPlaceholder({ aiSearchEmbedProvider: null, aiProvider: "anthropic" })).toBe("");
  });

  it("describes the index of the open repository", () => {
    const local = { route: "local_embeddings" as const, provider: "ollama" as const, model: "embeddinggemma", indexed: 4, used: true, local: true };
    expect(indexText(local, false)).toBe("Open a repository to see its index.");
    expect(indexText(local, true)).toBe("4 commits with embeddinggemma");
    expect(indexText({ ...local, indexed: 1 }, true)).toBe("1 commit with embeddinggemma");
    expect(indexText({ ...local, indexed: 0, used: false }, true)).toBe("No index yet – it is built on the first search by meaning.");
    expect(indexText({ ...local, route: "rephrase" }, true)).toBe("No index: without embeddings the question is rephrased into a search.");
  });
});
