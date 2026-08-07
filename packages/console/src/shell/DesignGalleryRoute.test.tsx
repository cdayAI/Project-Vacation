import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../routes";
import { matchRoutes } from "../routing";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import { DesignGalleryRoute } from "./DesignGalleryRoute";

describe("the /design route", () => {
  it("is a real route in the table", () => {
    // Specification §4 requires the gallery in the application itself: it is the
    // review surface and the regression check, not documentation.
    const match = matchRoutes(ROUTES, "/design");
    expect(match?.route.id).toBe("design");
  });

  it("says what the gallery is for", () => {
    renderSurface(<DesignGalleryRoute />);
    expect(screen.getByRole("heading", { level: 1, name: "Design system gallery" })).toBeInTheDocument();
    expect(screen.getByText(/in both themes, with and without transparency/)).toBeInTheDocument();
  });

  it("says plainly that the gallery is still being assembled", () => {
    // A route that renders a blank page, or one quietly left out of the table,
    // both read as "the gallery was never built".
    renderSurface(<DesignGalleryRoute />);
    expect(
      screen.getByRole("heading", { name: "The gallery is still being assembled" }),
    ).toBeInTheDocument();
  });

  it("points at the design authority in the meantime", () => {
    renderSurface(<DesignGalleryRoute />);
    expect(screen.getByText("docs/design/design-spec.md")).toBeInTheDocument();
  });

  it("offers a way back to work", () => {
    renderSurface(<DesignGalleryRoute />);
    expect(screen.getByRole("link", { name: "Go to the work queue" })).toHaveAttribute(
      "href",
      "/work",
    );
  });

  it("has no accessibility violations", async () => {
    const { container } = renderSurface(<DesignGalleryRoute />);
    await expectNoAccessibilityViolations(container);
  });
});
