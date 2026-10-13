import { describe, expect, it } from "vitest";
import { isTerminalReply } from "./control";

describe("terminal: replies from xterm.js are not user input", () => {
  it("detects reports that xterm.js sends by itself", () => {
    expect(isTerminalReply("\x1b[?1;2c")).toBe(true); // device attributes
    expect(isTerminalReply("\x1b[>0;276;0c")).toBe(true);
    expect(isTerminalReply("\x1b[24;80R")).toBe(true); // cursor position
    expect(isTerminalReply("\x1b[0n")).toBe(true);
    expect(isTerminalReply("\x1b[I")).toBe(true); // focus
    expect(isTerminalReply("\x1b[O")).toBe(true);
    expect(isTerminalReply("\x1b[1;1R\x1b[?1;2c")).toBe(true); // two replies in one chunk
    expect(isTerminalReply("\x1b]11;rgb:1111/1313/1717\x1b\\")).toBe(true); // colour
    expect(isTerminalReply("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBe(true);
    expect(isTerminalReply("\x1bP1$r0m\x1b\\")).toBe(true);
  });

  it("counts everything typed or pasted as input", () => {
    expect(isTerminalReply("g")).toBe(false);
    expect(isTerminalReply("git status\r")).toBe(false);
    expect(isTerminalReply("\r")).toBe(false);
    expect(isTerminalReply("\x03")).toBe(false); // Ctrl+C
    expect(isTerminalReply("\x1b")).toBe(false); // Esc
    expect(isTerminalReply("\x1b[A")).toBe(false); // arrow up
    expect(isTerminalReply("\x1b[200~text\x1b[201~")).toBe(false); // bracketed paste
    expect(isTerminalReply("\x1b[?1;2cx")).toBe(false); // reply and key together
    expect(isTerminalReply("")).toBe(false);
  });
});
