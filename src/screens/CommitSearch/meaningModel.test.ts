import { describe, expect, it } from "vitest";
import type { AiSemanticHit, AiSemanticResult, CommitSummary } from "../../core";
import { enterAction, hitReason, routeNote, searchedFor } from "./meaningModel";

const commit: CommitSummary = {
  sha: "a".repeat(40),
  summary: "Login-Formular: Fehlertext",
  author: { name: "Erika Muster", email: "erika@example.com" },
  authoredAt: "2026-01-02T03:04:05.000Z",
  parents: [],
};
const hit = (patch: Partial<AiSemanticHit>): AiSemanticHit => ({ commit, score: null, reason: null, matchedTerms: [], ...patch });
const result = (patch: Partial<AiSemanticResult>): AiSemanticResult => ({
  route: "rephrase",
  hits: [],
  indexed: 0,
  capped: false,
  ranked: true,
  filters: null,
  terms: [],
  author: null,
  ignored: [],
  ...patch,
});

describe("search by meaning", () => {
  it("runs a new question on Enter and jumps through the hits of the shown one", () => {
    expect(enterAction("  ", null, false)).toBe("none");
    expect(enterAction("Wo wird exportiert?", null, false)).toBe("run");
    expect(enterAction(" Wo wird exportiert? ", "Wo wird exportiert?", false)).toBe("jump");
    expect(enterAction("Wo wird exportiert?", "Wo wird exportiert?", true)).toBe("none");
    expect(enterAction("Anders gefragt", "Wo wird exportiert?", true)).toBe("run");
  });

  it("gives every hit a reason in words", () => {
    expect(hitReason(hit({ reason: "Behebt die Weiterleitung nach dem Anmelden." }), "en")).toBe("Behebt die Weiterleitung nach dem Anmelden.");
    expect(hitReason(hit({ score: 0.9487 }), "en")).toBe("Similar in meaning (95%)");
    expect(hitReason(hit({ score: 0.8, matchedTerms: ["login", "formular"] }), "en")).toBe("Similar in meaning (80%) · contains login, formular");
    expect(hitReason(hit({ score: 1.0004 }), "en")).toBe("Similar in meaning (100%)");
    expect(hitReason(hit({ score: -0.2 }), "en")).toBe("Similar in meaning (0%)");
    expect(hitReason(hit({}), "en")).toBe("Found by the search terms");
  });

  it("names the way and the size of the index", () => {
    expect(routeNote({ route: "local_embeddings", provider: "ollama", model: "embeddinggemma", indexed: 1234, used: true, local: true })).toBe(
      "Uses the embeddings of Ollama (on this computer) with embeddinggemma. 1234 commits indexed.",
    );
    expect(routeNote({ route: "provider_embeddings", provider: "openai", model: "text-embedding-3-small", indexed: 0, used: false, local: false })).toBe(
      "Uses the embeddings of OpenAI (API key) with text-embedding-3-small.",
    );
    expect(routeNote({ route: "rephrase", provider: "anthropic", model: "claude-haiku-5-5", indexed: 0, used: false, local: false })).toBe(
      "The AI turns the question into a search and sorts the matches.",
    );
    expect(routeNote(undefined)).toBe("");
  });

  it("says what the rephrased search looked for", () => {
    expect(searchedFor(result({ terms: ["anmeld", "login"], filters: { pickaxe: null, paths: ["src/zugang"], since: "2025-06-01", until: null } }))).toBe(
      "Searched for “anmeld”, “login”, path src/zugang, since 2025-06-01",
    );
    expect(searchedFor(result({ terms: [], filters: { pickaxe: "geheimeFunktion", paths: null, since: null, until: "2026-01-31" }, author: "Erika" }))).toBe(
      "Searched for code geheimeFunktion, author Erika, until 2026-01-31",
    );
    expect(searchedFor(result({ route: "local_embeddings" }))).toBeNull();
    expect(searchedFor(result({}))).toBeNull();
  });
});
