import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installMatchMedia, resetMediaPreferences } from "./media";

// Vitest runs with `globals: false`, so Testing Library's automatic cleanup
// hook does not install itself. Doing it here rather than in every file is
// what stops one test's DOM from leaking into the next one's axe run.
installMatchMedia();

afterEach(() => {
  cleanup();
  resetMediaPreferences();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
