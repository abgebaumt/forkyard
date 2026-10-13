import { describe, expect, it } from "vitest";
import { PLAIN_PART_LIMIT, WIN32_INPUT_OFF, WIN32_INPUT_ON, WIN32_PART_LIMIT, inputParts, trackWin32Input } from "./win32Input";

const down = (unit: number) => `\x1b[0;0;${unit};1;0;1_`;
const up = (unit: number) => `\x1b[0;0;${unit};0;0;1_`;

describe("input for ConPTY", () => {
  it("leaves ASCII, control characters and empty input unchanged", () => {
    expect(inputParts("", true)).toEqual([]);
    expect(inputParts("git status\r", true)).toEqual(["git status\r"]);
    expect(inputParts("\x03", true)).toEqual(["\x03"]);
  });

  it("sends characters outside ASCII as key presses with the Unicode character", () => {
    expect(inputParts("a–ü", true)).toEqual([`a${down(0x2013)}${up(0x2013)}${down(0xfc)}${up(0xfc)}`]);
  });

  it("sends an emoji as two halves in a row", () => {
    expect(inputParts("😀", true)).toEqual([`${down(0xd83d)}${up(0xd83d)}${down(0xde00)}${up(0xde00)}`]);
  });

  it("does not touch key sequences and bracketed paste", () => {
    expect(inputParts("\x1b[A", true)).toEqual(["\x1b[A"]);
    expect(inputParts("\x1bü", true)).toEqual(["\x1bü"]);
    expect(inputParts("\x1b[200~Grüße – so\x1b[201~", true)).toEqual(["\x1b[200~Grüße – so\x1b[201~"]);
  });

  it("changes nothing without the mode", () => {
    expect(inputParts("Grüße – 😀", false)).toEqual(["Grüße – 😀"]);
  });

  it("splits long input without tearing a record or a character apart", () => {
    const text = "ä–😀x".repeat(400);
    const parts = inputParts(text, true);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(WIN32_PART_LIMIT);
      // Every chunk consists only of whole records and ASCII.
      expect(part.replace(/\x1b\[0;0;\d+;[01];0;1_/g, "")).toMatch(/^x*$/);
      // Pressed and released come in pairs.
      expect(part.match(/;1;0;1_/g)?.length).toBe(part.match(/;0;0;1_/g)?.length);
    }
    // Joined and read back, the original text results.
    const units = [...parts.join("").matchAll(/\x1b\[0;0;(\d+);1;0;1_|(x)/g)].map((hit) => (hit[2] ? "x" : String.fromCharCode(Number(hit[1]))));
    expect(units.join("")).toBe(text);

    const plain = inputParts("a😀".repeat(PLAIN_PART_LIMIT), false);
    expect(plain.join("")).toBe("a😀".repeat(PLAIN_PART_LIMIT));
    for (const part of plain) {
      expect(part.length).toBeLessThanOrEqual(PLAIN_PART_LIMIT);
      const last = part.charCodeAt(part.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("detects when ConPTY switches the mode on and off – also split across two chunks", () => {
    let state = { enabled: false, tail: "" };
    state = trackWin32Input(state.enabled, state.tail, "PS C:\\> ");
    expect(state.enabled).toBe(false);
    state = trackWin32Input(state.enabled, state.tail, `${WIN32_INPUT_ON}\x1b[?1004h`);
    expect(state.enabled).toBe(true);
    state = trackWin32Input(state.enabled, state.tail, "Ausgabe ohne Modus");
    expect(state.enabled).toBe(true);
    state = trackWin32Input(state.enabled, state.tail, WIN32_INPUT_OFF.slice(0, 4));
    expect(state.enabled).toBe(true);
    state = trackWin32Input(state.enabled, state.tail, WIN32_INPUT_OFF.slice(4));
    expect(state.enabled).toBe(false);
    state = trackWin32Input(state.enabled, state.tail, `${WIN32_INPUT_OFF}…${WIN32_INPUT_ON}`);
    expect(state.enabled).toBe(true);
  });
});
