import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../routes";
import { matchRoutes } from "../routing";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import {
  DesignGallery,
  GALLERY_ENTRIES,
  GALLERY_FAMILIES,
  type GalleryFamily,
} from "./DesignGallery";

/**
 * The gallery's own ratchet.
 *
 * The first two tests here are the reason this file matters more than most.
 * They read `src/ui/` off the disk and compare it to the page, because a
 * gallery that silently omits a component is worse than no gallery: it reads as
 * coverage, and a reviewer who has looked at the page believes they have looked
 * at the library. Nothing about a missing entry is visible on the page itself —
 * the only way to see it is to ask the directory.
 *
 * This is the same shape as tools/check-accessibility-coverage.mjs, which fails
 * the build when a view has no accessibility assertion, and it is here for the
 * same reason: a gate that depends on somebody remembering is a gate that rots
 * quietly while the badge stays green.
 */

/**
 * Resolved from this file rather than from the working directory, so the check
 * is the same whether the suite is run from the package or from the repository
 * root. Deliberately not `new URL("../ui", import.meta.url)`: the bundler
 * rewrites that pattern into an asset reference at transform time, and the
 * result is an http URL for a module rather than a path on disk.
 */
const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

/**
 * Machinery, not components.
 *
 * Both of these are `.tsx` because they carry a provider or a hook that needs
 * JSX, and neither renders anything of its own that could be shown:
 *
 *   dialogHost.tsx    the shared dialog element, focus trap and origin motion
 *                     behind Modal and Sheet. It is on the page four times over,
 *                     as those two.
 *   glassSurface.tsx  the blur budget. Visible as the difference between glass
 *                     and the designed solid, which the transparency control at
 *                     the top of the gallery switches between.
 *
 * Anything else added to src/ui needs an entry. Adding a name here is a
 * decision to leave something out of the review surface, and it should be as
 * uncomfortable as it looks.
 */
const MACHINERY = new Set(["dialogHost.tsx", "glassSurface.tsx"]);

function componentFilesIn(family: GalleryFamily): readonly string[] {
  return readdirSync(join(UI_ROOT, family))
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .filter((name) => !MACHINERY.has(name))
    .sort();
}

function moduleName(file: string): string {
  return file.replace(/\.tsx$/, "");
}

describe("the component gallery", () => {
  describe("coverage", () => {
    it("has an entry for every component under src/ui", () => {
      const missing: string[] = [];
      for (const family of GALLERY_FAMILIES) {
        for (const file of componentFilesIn(family.id)) {
          const name = moduleName(file);
          const entry = GALLERY_ENTRIES.find(
            (candidate) => candidate.id === name && candidate.family === family.id,
          );
          if (entry === undefined) missing.push(`${family.id}/${file}`);
        }
      }

      expect(
        missing,
        `These components exist under src/ui and are not in the gallery. A gallery that omits a component reads as coverage it does not have — add an entry to GALLERY_ENTRIES:\n  ${missing.join("\n  ")}`,
      ).toEqual([]);
    });

    it("claims no component that is not there", () => {
      // The other direction. An entry left behind after a component is deleted
      // or renamed would fail at render rather than here, but the message here
      // says which one, which is the difference between a minute and an hour.
      const phantom = GALLERY_ENTRIES.filter((entry) => {
        const files = componentFilesIn(entry.family);
        return !files.includes(`${entry.id}.tsx`);
      }).map((entry) => `${entry.family}/${entry.id}.tsx`);

      expect(phantom).toEqual([]);
    });

    it("covers all four families", () => {
      const families = new Set(GALLERY_ENTRIES.map((entry) => entry.family));
      expect([...families].sort()).toEqual(
        GALLERY_FAMILIES.map((family) => family.id).sort(),
      );
    });
  });

  describe("entries", () => {
    it("gives every component a note on when to use it", () => {
      const silent = GALLERY_ENTRIES.filter((entry) => entry.when.trim().length === 0);
      expect(silent.map((entry) => entry.id)).toEqual([]);
    });

    it("shows at least one named state for every component", () => {
      const stateless = GALLERY_ENTRIES.filter((entry) => entry.states.length === 0);
      expect(stateless.map((entry) => entry.id)).toEqual([]);
    });

    it("names every state distinctly within its component", () => {
      // The name is the caption under the demo and the React key. A duplicate
      // is both an unreadable page and a dropped cell.
      const clashes: string[] = [];
      for (const entry of GALLERY_ENTRIES) {
        const seen = new Set<string>();
        for (const state of entry.states) {
          if (seen.has(state.name)) clashes.push(`${entry.id}: ${state.name}`);
          seen.add(state.name);
        }
      }
      expect(clashes).toEqual([]);
    });

    it("uses each module name once", () => {
      const ids = GALLERY_ENTRIES.map((entry) => `${entry.family}/${entry.id}`);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("the route", () => {
    it("is what /design renders", () => {
      // Spec §4 asks for the gallery in the application itself. A page that
      // exists in the repository and not in the console is documentation.
      const match = matchRoutes(ROUTES, "/design");
      expect(match?.route.id).toBe("design");

      const element = match?.route.render({});
      expect(isValidElement(element) ? element.type : null).toBe(DesignGallery);
    });
  });

  describe("the page", () => {
    it("names itself and says what it is for", () => {
      renderSurface(<DesignGallery />);
      expect(
        screen.getByRole("heading", { level: 1, name: "Design system gallery" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/in both themes and with\s+transparency on and off/),
      ).toBeInTheDocument();
    });

    it("draws a heading for every family and every component", () => {
      renderSurface(<DesignGallery />);
      for (const family of GALLERY_FAMILIES) {
        expect(screen.getByRole("heading", { level: 2, name: family.label })).toBeInTheDocument();
      }
      for (const entry of GALLERY_ENTRIES) {
        expect(screen.getByRole("heading", { level: 3, name: entry.name })).toBeInTheDocument();
      }
    });

    it("writes every state's name in text under it", () => {
      // Not a colour, not a position: this page is read on a monochrome
      // printout in a design review as often as it is read on a screen.
      renderSurface(<DesignGallery />);
      const button = document.getElementById("component-Button");
      expect(button).not.toBeNull();
      const region = within(button as HTMLElement);
      for (const state of ["Primary", "Secondary", "Ghost", "Danger", "Loading", "Disabled"]) {
        expect(region.getByText(state)).toBeInTheDocument();
      }
    });

    it("draws something in every state it names", () => {
      // A demo that renders nothing — a component that returns null for a prop
      // combination, an overlay with no trigger — leaves a captioned empty box,
      // which reads as "this state has no design" rather than as the defect it
      // is. The caption beside it is what makes the failure legible.
      const { container } = renderSurface(<DesignGallery />);
      const expected = GALLERY_ENTRIES.reduce((total, entry) => total + entry.states.length, 0);

      const stages = [...container.querySelectorAll(".pv-gallery-stage")];
      expect(stages).toHaveLength(expected);

      const blank = stages
        .filter((stage) => stage.childElementCount === 0 && (stage.textContent ?? "").trim() === "")
        .map((stage) => stage.parentElement?.textContent ?? "unnamed state");
      expect(blank).toEqual([]);
    });

    it("offers a way to jump to any component", () => {
      renderSurface(<DesignGallery />);
      const contents = screen.getByRole("navigation", { name: "Components" });
      expect(within(contents).getByRole("link", { name: "Table" })).toHaveAttribute(
        "href",
        "#component-Table",
      );
    });

    it("shows the read-only state, which is where auditors live", () => {
      renderSurface(<DesignGallery />);
      // Named in text, not implied by dimming — several times over, because
      // every component that has the state has to show it.
      expect(screen.getAllByText("Read-only").length).toBeGreaterThan(5);
    });
  });

  describe("the three preferences", () => {
    it("switches the theme without leaving the page", async () => {
      const user = userEvent.setup();
      renderSurface(<DesignGallery />);

      await user.click(screen.getByRole("radio", { name: "Dark" }));
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
      expect(screen.getByText(/Showing the/)).toHaveTextContent("dark");

      await user.click(screen.getByRole("radio", { name: "Light" }));
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });

    it("switches density", async () => {
      const user = userEvent.setup();
      renderSurface(<DesignGallery />);

      await user.click(screen.getByRole("radio", { name: "Compact" }));
      expect(document.documentElement).toHaveAttribute("data-density", "compact");
    });

    it("turns transparency off, which is a first-class variant and not a fallback", async () => {
      const user = userEvent.setup();
      renderSurface(<DesignGallery />);

      await user.click(screen.getByRole("radio", { name: "Reduced" }));
      expect(document.documentElement).toHaveAttribute("data-transparency", "reduced");
      expect(screen.getByText(/Showing the/)).toHaveTextContent("glass off");
    });

    it("says which state is actually being painted, not which was stored", () => {
      // "System" tells a reviewer nothing about what is on their screen, and
      // what is on their screen is the thing under review.
      renderSurface(<DesignGallery />);
      expect(screen.getByText(/Showing the/)).toHaveTextContent(
        "Showing the light theme at comfortable density, with glass on.",
      );
    });
  });

  describe("the overlays", () => {
    it("opens the command palette against the gallery's own registry", async () => {
      // The palette reads whatever the surrounding screen registered, so the
      // gallery gives it a registry of its own. Nothing is bound in it, which
      // is what keeps a demo from firing a real verb — and it is also the one
      // arrangement on this page that would fail silently if it were wrong.
      const user = userEvent.setup();
      renderSurface(<DesignGallery />);

      const entry = document.getElementById("component-CommandPalette");
      const [trigger] = within(entry as HTMLElement).getAllByRole("button", {
        name: "Open the palette",
      });
      await user.click(trigger as HTMLElement);

      expect(screen.getByRole("listbox", { name: "Results" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /Approve and go to the next item/ })).toBeInTheDocument();
    });

    it("opens the shortcut reference", async () => {
      const user = userEvent.setup();
      renderSurface(<DesignGallery />);

      await user.click(screen.getByRole("button", { name: "Open the reference" }));
      expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    });

    it("opens a modal and gives focus back to the control that opened it", async () => {
      const user = userEvent.setup();
      renderSurface(<DesignGallery />);

      const entry = document.getElementById("component-Modal");
      const [trigger] = within(entry as HTMLElement).getAllByRole("button", {
        name: "Open the modal",
      });
      await user.click(trigger as HTMLElement);

      const dialog = screen.getByRole("dialog", {
        name: "Move three cases to the escalation queue?",
      });
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(trigger).toHaveFocus());
    });
  });

  // The whole library in one DOM is by far the largest tree in this suite, and
  // axe walks all of it. The generous timeout is the price of asserting against
  // the real page rather than against a convenient subset of it — a per-family
  // assertion would pass while two families collided.
  it(
    "has no accessibility violations with every component on the page",
    async () => {
      const { container } = renderSurface(<DesignGallery />);
      await expectNoAccessibilityViolations(container);
    },
    60_000,
  );
});
