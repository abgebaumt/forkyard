/**
 * Prepare input for the Windows pseudo terminal (ConPTY).
 *
 * ConPTY turns incoming text into key presses. A character that does not occur on the keyboard
 * layout (en dash, "typographic" quotes, ellipsis, emoji) is converted via the console's code
 * page – and whatever does not exist there disappears without replacement. Measured in the app
 * with PowerShell 7.4 and code page 850: `a–b „c“ … 😀` arrived as `ab c  `. When pasting a commit
 * message this would only be noticed later.
 *
 * ConPTY itself offers the way out (mode 9001, "win32-input-mode"): a key press may come as the
 * record `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`, with the Unicode character in field Uc.
 * Characters outside ASCII therefore go out that way – but only if ConPTY has requested the mode,
 * and only for plain text: key sequences from xterm.js (they contain ESC) and bracketed paste
 * stay as they are.
 */

/** ConPTY switches the mode on at startup and off again at the end. */
export const WIN32_INPUT_ON = "\x1b[?9001h";
export const WIN32_INPUT_OFF = "\x1b[?9001l";

/** Maximum length of a chunk with records: small enough for ConPTY to read in one go. */
export const WIN32_PART_LIMIT = 1536;
/** Maximum length of a chunk of ordinary text (the core accepts at most 1 MB per call). */
export const PLAIN_PART_LIMIT = 64 * 1024;

const ESC = "\x1b";

/** Key pressed and released again, without a key code, only with the character (one UTF-16 unit). */
const record = (unit: number) => `${ESC}[0;0;${unit};1;0;1_${ESC}[0;0;${unit};0;0;1_`;

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

function plainParts(data: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(data.length, start + PLAIN_PART_LIMIT);
    // Do not split a character made of two halves (emoji).
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;
    parts.push(data.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * Splits input into chunks for `terminalWrite`. With `win32`, characters outside ASCII become
 * records; a record is never split across two chunks.
 */
export function inputParts(data: string, win32: boolean): string[] {
  if (data === "") return [];
  if (!win32 || data.includes(ESC) || !/[^\x00-\x7f]/.test(data)) return plainParts(data);
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < data.length; index++) {
    const unit = data.charCodeAt(index);
    let atom = unit < 0x80 ? data[index]! : record(unit);
    // Both halves of a character stay together.
    if (isHighSurrogate(unit) && index + 1 < data.length) atom += record(data.charCodeAt(++index));
    if (current.length > 0 && current.length + atom.length > WIN32_PART_LIMIT) {
      parts.push(current);
      current = "";
    }
    current += atom;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Tracks in the output whether ConPTY has requested the mode. `tail` is the rest of the previous
 * chunk (the sequence may arrive split across two chunks).
 */
export function trackWin32Input(enabled: boolean, tail: string, data: string): { enabled: boolean; tail: string } {
  const text = tail + data;
  const on = text.lastIndexOf(WIN32_INPUT_ON);
  const off = text.lastIndexOf(WIN32_INPUT_OFF);
  const next = on < 0 && off < 0 ? enabled : on > off;
  return { enabled: next, tail: text.slice(-(WIN32_INPUT_ON.length - 1)) };
}
