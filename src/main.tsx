import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "./styles/app.css";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { queryClient, useAvatarUrl } from "./app/queries";
import { useAppStore } from "./app/store";
import { installCloseGuard } from "./app/closeGuard";
import { installEscapeGuard } from "./app/escapeGuard";
import { installWebviewGuards } from "./app/webviewGuards";
import { installScrollPin } from "./app/scrollPin";
import { core, type Core } from "./core";
import { DesignPage } from "./design/DesignPage";
import { Toaster } from "./ui/Feedback";
import { TooltipProvider } from "./ui/Tooltip";
import { AvatarSourceContext } from "./ui/Git";

declare global {
  interface Window {
    __gc?: { core: Core; store: typeof useAppStore; queryClient: typeof queryClient };
  }
}

const params = new URLSearchParams(window.location.search);

// ?theme=light|dark forces a theme (design page, screenshots); otherwise the app sets it from the settings.
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  document.documentElement.dataset.theme = theme;
}

// ?design shows the design page instead of the app.
const showDesign = params.has("design");

installWebviewGuards({ mac: /Mac/i.test(navigator.platform), dev: import.meta.env.DEV });
// The window itself never scrolls (focus, scrollIntoView, selections dragged past the edge).
installScrollPin();

// Kind of the last input on the root element (app.css): a focus set by a keyboard shortcut shows
// its ring even if the mouse was clicked before.
window.addEventListener("keydown", () => (document.documentElement.dataset.input = "keyboard"), true);
window.addEventListener("pointerdown", () => (document.documentElement.dataset.input = "pointer"), true);
// Esc reaches the open dialog even when a success message is currently on top of it.
installEscapeGuard();
// Closing the window with unsaved text or a running action: ask first.
if (!showDesign) installCloseGuard();

// Development build only: access for the E2E driver (scripts/e2e) and the console,
// e.g. `__gc.store.getState().openOverlay({ kind: "clone" })`.
if (import.meta.env.DEV) {
  window.__gc = { core, store: useAppStore, queryClient };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      {showDesign ? (
        <DesignPage />
      ) : (
        <QueryClientProvider client={queryClient}>
          <AvatarSourceContext.Provider value={useAvatarUrl}>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </AvatarSourceContext.Provider>
        </QueryClientProvider>
      )}
      <Toaster />
    </TooltipProvider>
  </StrictMode>,
);
