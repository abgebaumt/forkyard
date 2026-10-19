import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Core, CoreCommands, CoreSystem } from "./api";
import { t } from "../i18n";
import { CoreError, type CoreErrorData, type CoreEvents } from "./types";
import { setStartupSender, traceCall } from "./startupTrace";

export * from "./types";
export * from "./limits";
export type { Core, CoreCommands, CommandName, Unsubscribe } from "./api";

const toSnake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) return error;
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return new CoreError(error as CoreErrorData);
  }
  return new CoreError({ code: "unknown", message: typeof error === "string" ? error : t("app.core.unknownError"), gitOutput: null });
}

/**
 * For automated tests: the operating system's folder dialog cannot be driven remotely.
 * If a path is queued here, `pickFolder` takes it instead of opening the dialog.
 * Development build only – the shipped program does not know these redirects.
 */
declare global {
  interface Window {
    __gcTestPicks?: (string | null)[];
  }
}

const system: CoreSystem = {
  async pickFolder({ title, defaultPath }) {
    if (import.meta.env.DEV && window.__gcTestPicks?.length) return window.__gcTestPicks.shift() ?? null;
    const picked = await open({ title, defaultPath, directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  async pickFile({ title, defaultPath }) {
    if (import.meta.env.DEV && window.__gcTestPicks?.length) return window.__gcTestPicks.shift() ?? null;
    const picked = await open({ title, defaultPath, directory: false, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  on(event, handler) {
    let active = true;
    let unlisten: (() => void) | undefined;
    const ready = listen<CoreEvents[typeof event]>(event, (message) => {
      if (active) handler(message.payload);
    }).then(
      (stop) => {
        if (active) unlisten = stop;
        else stop();
      },
      // Without Tauri (preview in the browser) there are no events; `ready` must still never hang.
      () => undefined,
    );
    const stop = () => {
      active = false;
      unlisten?.();
    };
    return Object.assign(stop, { ready });
  },
  async notify({ title, body }) {
    try {
      let granted = await invoke<boolean | null>("plugin:notification|is_permission_granted");
      if (granted === null) granted = (await invoke<string>("plugin:notification|request_permission")) === "granted";
      if (!granted) return false;
      await invoke("plugin:notification|notify", { options: { title, body } });
      return true;
    } catch {
      return false;
    }
  },
  async notifyPermission() {
    try {
      const granted = await invoke<boolean | null>("plugin:notification|is_permission_granted");
      return granted === null ? "default" : granted ? "granted" : "denied";
    } catch {
      return "denied";
    }
  },
  async clipboardRead() {
    try {
      return await invoke<string>("plugin:clipboard-manager|read_text");
    } catch (error) {
      // The plugin reports a clipboard without text as an error.
      if (typeof error === "string") return "";
      throw toCoreError(error);
    }
  },
  async clipboardWrite({ text }) {
    try {
      await invoke("plugin:clipboard-manager|write_text", { text });
    } catch (error) {
      throw toCoreError(error);
    }
  },
};

/**
 * The core. Every method from `CoreCommands` becomes `invoke("<snake_case>", input)`;
 * new commands need no code here, only the entry in api.ts and in the Rust core.
 */
export const core: Core = new Proxy(system as Core, {
  get(target, property: string) {
    if (property in target) return target[property as keyof CoreSystem];
    return async (input?: Record<string, unknown>) => {
      const command = toSnake(property);
      const done = traceCall(command);
      try {
        return await invoke(command, input ?? {});
      } catch (error) {
        throw toCoreError(error);
      } finally {
        done();
      }
    };
  },
}) as Core;

setStartupSender((report) => core.appStartupReport({ report }));

export { startupMark } from "./startupTrace";
export type { CoreSystem };
// Only for type checks in tests: ensures the proxy covers all commands.
export type _CommandCheck = keyof CoreCommands;
