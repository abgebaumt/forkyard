import { describe, expect, it } from "vitest";
import { fold, fuzzyMatch, highlightParts, isWeakMatch, prepareQuery } from "./fuzzy";

const score = (query: string, text: string, path = false) => fuzzyMatch(prepareQuery(query), text, { path })?.score ?? null;
const positions = (query: string, text: string, path = false) => fuzzyMatch(prepareQuery(query), text, { path })?.positions ?? null;

describe("fold", () => {
  it("folds case and umlauts, length stays the same", () => {
    expect(fold("Rückgängig")).toBe("ruckgangig");
    expect(fold("Größen und Einheiten.md")).toBe("grosen und einheiten.md");
    expect(fold("Größen").length).toBe("Größen".length);
  });
});

describe("fuzzyMatch", () => {
  it("finds subsequences and rejects missing characters", () => {
    expect(score("psh", "Push")).not.toBeNull();
    expect(score("pushx", "Push")).toBeNull();
    expect(score("hsup", "Push")).toBeNull();
    expect(fuzzyMatch("", "Push")).toEqual({ score: 0, positions: [] });
  });

  it("umlauts and case do not matter", () => {
    expect(positions("ruckg", "Rückgängig")).toEqual([0, 1, 2, 3, 4]);
    expect(score("RÜCK", "rückgängig")).not.toBeNull();
  });

  it("initial letters beat scattered matches", () => {
    // “nb” = “Neuer Branch” (word starts) before “Annotierten Tag am …” (n…b anywhere)
    expect(score("nb", "Neuer Branch …")!).toBeGreaterThan(score("nb", "Tag am aktuellen Commit anlegen, ohne Beschreibung")!);
    expect(positions("nb", "Neuer Branch …")).toEqual([0, 6]);
  });

  it("consecutive matches beat fragmented ones", () => {
    expect(score("pull", "Pull")!).toBeGreaterThan(score("pull", "Push all local")!);
    expect(score("stash", "Änderungen stashen")!).toBeGreaterThan(score("stash", "Stage all and show history")!);
  });

  it("chooses the best assignment, not the first", () => {
    // Greedy would take the first “b” in “debug”; the word start “branch” is better.
    expect(positions("br", "debug/branch")).toEqual([6, 7]);
  });

  it("paths: matches in the file name count more", () => {
    expect(score("aus", "src/auswertung.py", true)!).toBeGreaterThan(score("aus", "ausgabe/alt/irgendwas.txt", true)! - 5);
    expect(positions("ausw", "src/auswertung.py", true)).toEqual([4, 5, 6, 7]);
  });

  it("CamelCase boundaries count as word starts", () => {
    expect(positions("cm", "commitMessage")).toEqual([0, 6]);
  });

  it("shorter texts win when the match is otherwise equal", () => {
    expect(score("main", "main")!).toBeGreaterThan(score("main", "main-alt-und-sehr-lang")!);
  });

  it("stays fast with many candidates", () => {
    const paths = Array.from({ length: 20_000 }, (_, index) => `archiv/jahr-${2000 + (index % 25)}/station-${index % 40}/messreihe-${String(index).padStart(5, "0")}.csv`);
    const query = prepareQuery("st12mess");
    const started = performance.now();
    let hits = 0;
    for (const path of paths) if (fuzzyMatch(query, path, { path: true })) hits++;
    const elapsed = performance.now() - started;
    expect(hits).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("highlightParts", () => {
  it("splits at the matches", () => {
    expect(highlightParts("Push", [0, 1])).toEqual([
      { text: "Pu", hit: true },
      { text: "sh", hit: false },
    ]);
    expect(highlightParts("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });
});

describe("isWeakMatch", () => {
  const weak = (query: string, text: string, path = false) => {
    const folded = prepareQuery(query);
    const match = fuzzyMatch(folded, text, { path });
    return match ? isWeakMatch(match, folded.length) : null;
  };

  it("filters out scattered letters", () => {
    expect(weak("wind", "Gewählten Commit auschecken (Detached HEAD)")).toBe(true);
    expect(weak("wind", "daten/messwerte-station-nord-januar-bis-maerz.csv", true)).toBe(true);
  });

  it("lets word starts, abbreviations and consecutive pieces through", () => {
    expect(weak("wind", "feature/wind-diagramm")).toBe(false);
    expect(weak("nbr", "Neuer Branch …")).toBe(false);
    expect(weak("asc", "Alles stagen und committen")).toBe(false);
    expect(weak("v020", "v0.2.0")).toBe(false);
    expect(weak("ausw", "src/auswertung.py", true)).toBe(false);
    expect(weak("st12mess", "archiv/jahr-2012/station-12/messreihe-00012.csv", true)).toBe(false);
  });

  it("only applies from three characters on", () => {
    expect(weak("wd", "Gewählten Commit auschecken (Detached HEAD)")).toBe(false);
  });
});

/**
 * The version without window and without reused buffers: every row over the whole text, new
 * arrays per character. It is slow but easy to check – `fuzzyMatch` must return exactly the
 * same for every input (score and positions).
 */
function referenceMatch(query: string, text: string, path: boolean): { score: number; positions: number[] } | null {
  const SEPARATORS = new Set([" ", "/", "\\", "-", "_", ".", "(", ":", "„", '"', "'", "@", "#", "›", ","]);
  const isLower = (char: string) => char !== char.toUpperCase() && char === char.toLowerCase();
  const isUpper = (char: string) => char !== char.toLowerCase() && char === char.toUpperCase();
  const NEG = -1e9;
  const m = query.length;
  if (m === 0) return { score: 0, positions: [] };
  const hay = fold(text);
  const n = hay.length;
  if (m > n) return null;
  const basenameStart = path ? Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1 : 0;
  const bonusAt = (index: number) => {
    let bonus = 1;
    if (index === 0) bonus += 10;
    else {
      const before = text[index - 1]!;
      if (SEPARATORS.has(before)) bonus += 8;
      else if (isLower(before) && isUpper(text[index]!)) bonus += 6;
    }
    if (basenameStart > 0 && index >= basenameStart) bonus += 2;
    return bonus;
  };
  let previous = new Array<number>(n).fill(NEG);
  const back: number[][] = [];
  for (let i = 0; i < m; i++) {
    const current = new Array<number>(n).fill(NEG);
    const from = new Array<number>(n).fill(-1);
    let gap = NEG;
    let gapFrom = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        if (gap > NEG / 2) gap -= 0.5;
        const start = previous[j - 2]!;
        if (start > NEG / 2 && start - 3 > gap) {
          gap = start - 3;
          gapFrom = j - 2;
        }
      }
      if (hay[j] !== query[i]) continue;
      const bonus = bonusAt(j);
      if (i === 0) {
        current[j] = bonus - j * 0.15;
        continue;
      }
      const adjacent = j > 0 ? previous[j - 1]! : NEG;
      if (adjacent > NEG / 2) {
        current[j] = adjacent + bonus + 5;
        from[j] = j - 1;
      }
      if (gap > NEG / 2 && gap + bonus > current[j]!) {
        current[j] = gap + bonus;
        from[j] = gapFrom;
      }
    }
    back.push(from);
    previous = current;
  }
  let end = -1;
  let best = NEG;
  for (let j = 0; j < n; j++) {
    if (previous[j]! > best) {
      best = previous[j]!;
      end = j;
    }
  }
  if (end < 0 || best <= NEG / 2) return null;
  const positions = new Array<number>(m);
  let at = end;
  for (let i = m - 1; i >= 0; i--) {
    positions[i] = at;
    if (i > 0) at = back[i]![at]!;
  }
  return { score: best - n * 0.02, positions };
}

describe("fuzzyMatch against the simple version", () => {
  // Fixed randomness: the same run on every start.
  let seed = 20261011;
  const random = (below: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % below;
  };
  const ALPHABET = "aabcdeeimnrsstMS/-_. ä";
  const word = (length: number) => Array.from({ length }, () => ALPHABET[random(ALPHABET.length)]).join("");

  it("returns the same score and the same positions for random texts and inputs", () => {
    let hits = 0;
    for (let round = 0; round < 4000; round++) {
      const text = word(1 + random(40));
      // Sometimes a real subsequence of the text, sometimes random – both must agree.
      const picked = Array.from(text)
        .filter(() => random(3) === 0)
        .join("");
      const query = prepareQuery(random(4) === 0 ? word(1 + random(5)) : picked);
      const path = random(2) === 0;
      const expected = referenceMatch(query, text, path);
      const actual = fuzzyMatch(query, text, { path });
      if (expected) hits++;
      expect(actual, `${JSON.stringify(query)} in ${JSON.stringify(text)}`).toEqual(expected);
    }
    expect(hits).toBeGreaterThan(1500);
  });

  it("also for long paths and after a longer text before (the buffers are reused)", () => {
    const long = `${"archiv/jahr-2020/station-25/".repeat(12)}messreihe-12345.csv`;
    for (const query of ["messreihe-12345", "st25mess", "a2s", "csv", "archivarchiv", "jahr2020jahr2020mess"]) {
      expect(fuzzyMatch(prepareQuery(query), long, { path: true })).toEqual(referenceMatch(prepareQuery(query), long, true));
    }
    expect(fuzzyMatch("psh", "Push")).toEqual(referenceMatch("psh", "Push", false));
    const file = "archiv/jahr-2012/station-12/messreihe-00012.csv";
    expect(fuzzyMatch("st12mess", file, { path: true })).toEqual(referenceMatch("st12mess", file, true));
  });
});
