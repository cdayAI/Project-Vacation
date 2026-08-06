import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Avatar, UnassignedAvatar, initialsOf } from "./Avatar";

describe("initialsOf", () => {
  it("takes the first and last word, which is what people use for themselves", () => {
    expect(initialsOf("Marisol Delgado")).toBe("MD");
    expect(initialsOf("Ana Maria Ruiz")).toBe("AR");
  });

  it("strips the punctuation an abbreviated name arrives with", () => {
    expect(initialsOf("M. Delgado")).toBe("MD");
  });

  it("handles a one-word name and a machine identifier", () => {
    expect(initialsOf("Dana")).toBe("Da");
    expect(initialsOf("sf-quotebot")).toBe("sq");
  });

  it("has an answer for a name with nothing in it", () => {
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("Avatar", () => {
  it("carries no accessibility violations", async () => {
    const { container } = renderSurface(
      <>
        <Avatar name="Marisol Delgado" />
        <Avatar name="Dana Ruiz" size="sm" />
        <Avatar name="Marc Webb" size="lg" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
        <span>
          Marc Webb <Avatar name="Marc Webb" decorative />
        </span>
        <UnassignedAvatar />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("names itself, because a nameless circle is announced as 'image'", () => {
    renderSurface(<Avatar name="Marisol Delgado" />);
    expect(screen.getByRole("img", { name: "Marisol Delgado" })).toHaveTextContent("MD");
  });

  it("disappears from the accessibility tree when the name is already beside it", () => {
    renderSurface(
      <span>
        Marc Webb <Avatar name="Marc Webb" decorative />
      </span>,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("falls back to initials when the photograph cannot be fetched", () => {
    renderSurface(<Avatar name="Dana Ruiz" src="https://example.invalid/dana.png" />);
    const avatar = screen.getByRole("img", { name: "Dana Ruiz" });
    expect(avatar.querySelector("img")).not.toBeNull();

    fireEvent.error(avatar.querySelector("img") as HTMLImageElement);
    // A row of broken-image glyphs reads as a system fault, which is a lie
    // about an identity provider being briefly unreachable.
    expect(avatar).toHaveTextContent("DR");
    expect(avatar.querySelector("img")).toBeNull();
  });

  it("leaves the photograph's own alt empty so the name is not read twice", () => {
    renderSurface(<Avatar name="Marc Webb" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />);
    expect(screen.getByRole("img", { name: "Marc Webb" }).querySelector("img")).toHaveAttribute(
      "alt",
      "",
    );
  });
});

describe("UnassignedAvatar", () => {
  it("draws the empty seat rather than leaving a blank circle", () => {
    renderSurface(<UnassignedAvatar />);
    expect(screen.getByRole("img", { name: "Unassigned" })).toBeInTheDocument();
  });
});
