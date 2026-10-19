/**
 * Startup timing of the UI: milestones (script loaded, shell drawn, first graph rows) and the core
 * calls made until then. Reported once per run with `appStartupReport`, which writes one
 * `Startup (UI): …` line into the log – so a slow start can be explained from the log alone.
 * Development builds also expose the trace as `window.__gcStartup` (E2E startup check).
 */
import type { StartupReport } from "./types";

/** Calls and marks after this long no longer belong to the start. */
const WINDOW_MS = 60_000;
/** Without a repository tab the start ends when the shell is drawn; report shortly after. */
const MANAGEMENT_DELAY_MS = 1500;

type Mark = { name: string; at: number };
type Call = { command: string; start: number; ms: number };

export interface StartupTrace {
  timeOrigin: number;
  marks: Mark[];
  calls: Call[];
  reported: boolean;
}

export function createTrace(timeOrigin: number): StartupTrace {
  return { timeOrigin, marks: [], calls: [], reported: false };
}

/** Records a mark once (the first time counts). */
export function addMark(trace: StartupTrace, name: string, at: number): boolean {
  if (trace.reported || at > WINDOW_MS || trace.marks.some((mark) => mark.name === name)) return false;
  trace.marks.push({ name, at });
  return true;
}

export function addCall(trace: StartupTrace, command: string, start: number, end: number): void {
  if (trace.reported || start > WINDOW_MS) return;
  trace.calls.push({ command, start, ms: end - start });
}

export function toReport(trace: StartupTrace): StartupReport {
  return { timeOrigin: trace.timeOrigin, marks: [...trace.marks], calls: [...trace.calls] };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : 0);

const trace: StartupTrace = createTrace(typeof performance !== "undefined" ? performance.timeOrigin : Date.now());

declare global {
  interface Window {
    __gcStartup?: StartupTrace;
  }
}
if (import.meta.env.DEV && typeof window !== "undefined") window.__gcStartup = trace;

let send: ((report: StartupReport) => Promise<void>) | null = null;

/** The core's `appStartupReport` (set by index.ts). */
export function setStartupSender(sender: (report: StartupReport) => Promise<void>): void {
  send = sender;
}

/** A core call during the start (src/core/index.ts). Returns the function that ends it. */
export function traceCall(command: string): () => void {
  if (trace.reported) return () => {};
  const start = now();
  return () => addCall(trace, command, start, now());
}

function flush(): void {
  if (trace.reported || !send) return;
  const report = toReport(trace);
  trace.reported = true;
  void send(report).catch(() => {});
}

/** After the next paint (two frames: the one with the change, then the one after it). */
function afterPaint(fn: () => void): void {
  if (typeof requestAnimationFrame === "undefined") return fn();
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * A milestone of the start: `script` (all modules evaluated), `paint` (first React paint), `shell`
 * (tabs drawn), `graph` (first graph rows painted; ends the start) or `management` (no repository
 * tab; ends the start shortly after).
 */
export function startupMark(name: "script" | "paint" | "shell" | "management" | "graph"): void {
  if (trace.reported) return;
  if (name === "script") {
    addMark(trace, name, now());
    return;
  }
  afterPaint(() => {
    if (!addMark(trace, name, now())) return;
    if (name === "graph") flush();
    if (name === "management") setTimeout(flush, MANAGEMENT_DELAY_MS);
  });
}
