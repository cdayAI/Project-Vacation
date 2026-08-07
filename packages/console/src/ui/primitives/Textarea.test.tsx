import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { Textarea } from "./Textarea";

describe("Textarea", () => {
  it("carries no accessibility violations in any of its states", async () => {
    const { container } = renderSurface(
      <>
        <Textarea label="Rejection reason" />
        <Textarea label="Note" hint="Kept with the decision as improvement signal." />
        <Textarea label="Counted" maxLength={200} defaultValue="Too short to warn about." />
        <Textarea label="Broken" error="Say why, so the workflow can learn from it." />
        <Textarea label="Locked" defaultValue="Approved under policy R-14." readOnly />
        <Textarea label="Unavailable" disabled />
      </>,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("does not set the native maxlength, so a long paste is never truncated in silence", async () => {
    const user = userEvent.setup();
    renderSurface(<Textarea label="Reason" maxLength={10} />);
    const field = screen.getByLabelText("Reason");
    expect(field).not.toHaveAttribute("maxlength");

    await user.type(field, "far more than ten characters");
    // Every character the operator wrote is still there to be edited.
    expect(field).toHaveValue("far more than ten characters");
  });

  it("says how far over the limit it is, and marks itself invalid", async () => {
    const user = userEvent.setup();
    renderSurface(<Textarea label="Reason" maxLength={10} />);
    const field = screen.getByLabelText("Reason");
    await user.type(field, "twelve chars");

    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/2 characters over the limit of 10/);
  });

  it("counts what has been used", async () => {
    const user = userEvent.setup();
    renderSurface(<Textarea label="Reason" maxLength={200} />);
    await user.type(screen.getByLabelText("Reason"), "Rescinded");
    expect(screen.getByText("9 / 200")).toBeInTheDocument();
  });

  it("announces the limit at a threshold, not on every keystroke", async () => {
    const user = userEvent.setup();
    renderSurface(<Textarea label="Reason" maxLength={25} />);
    const field = screen.getByLabelText("Reason");
    const live = screen.getByRole("status");

    await user.type(field, "abcd");
    expect(live).toHaveTextContent("");

    await user.type(field, "efghij");
    // Wording is fixed per threshold, so the region has three states rather
    // than one per character.
    expect(live).toHaveTextContent("Fewer than 20 characters left.");
  });

  it("keeps the value readable and the handle away when read-only", () => {
    renderSurface(<Textarea label="Decision" defaultValue="Approved." readOnly />);
    const field = screen.getByLabelText("Decision");
    expect(field).toHaveAttribute("readonly");
    expect(field).not.toBeDisabled();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("lets the caller's own error win over the counter's", async () => {
    const user = userEvent.setup();
    renderSurface(
      <Textarea label="Reason" maxLength={3} error="Pick a reason code as well." />,
    );
    await user.type(screen.getByLabelText("Reason"), "much too long");
    expect(screen.getByText("Pick a reason code as well.")).toBeInTheDocument();
    expect(screen.queryByText(/over the limit/)).not.toBeInTheDocument();
  });
});
