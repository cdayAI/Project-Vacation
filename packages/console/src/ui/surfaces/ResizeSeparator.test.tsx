import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations } from "../../test/axe";
import { ResizeSeparator } from "./ResizeSeparator";

function setup(props: Partial<Parameters<typeof ResizeSeparator>[0]> = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const result = render(
    <main>
      <ResizeSeparator
        label="Owner column width"
        value={180}
        min={64}
        max={640}
        onChange={onChange}
        onCommit={onCommit}
        {...props}
      />
    </main>,
  );
  return { ...result, onChange, onCommit, handle: screen.getByRole("separator") };
}

/**
 * jsdom implements neither `PointerEvent` nor pointer capture.
 *
 * Without the constructor, Testing Library falls back to a bare `Event` and
 * silently drops `button` and `clientX` — so a drag test would exercise a
 * handler that returns immediately and would pass no matter what the component
 * did. The shim is a MouseEvent carrying a pointer id, which is exactly the
 * subset of the interface this component reads.
 */
class PointerEventShim extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { readonly pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

if (window.PointerEvent === undefined) {
  window.PointerEvent = PointerEventShim as unknown as typeof window.PointerEvent;
}

function stubPointerCapture(element: HTMLElement): void {
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn(() => true);
}

describe("ResizeSeparator", () => {
  it("names what it resizes, not itself", () => {
    // A screen reader reads this in a list of ten identical handles.
    const { handle } = setup();
    expect(handle).toHaveAccessibleName("Owner column width");
  });

  it("reports its value and bounds", () => {
    const { handle } = setup();
    expect(handle).toHaveAttribute("aria-valuenow", "180");
    expect(handle).toHaveAttribute("aria-valuemin", "64");
    expect(handle).toHaveAttribute("aria-valuemax", "640");
    expect(handle).toHaveAttribute("aria-valuetext", "180 pixels");
  });

  it("declares the axis it moves on", () => {
    // ARIA defaults a separator to horizontal; this one is a vertical bar the
    // operator moves left and right.
    expect(setup().handle).toHaveAttribute("aria-orientation", "vertical");
  });

  it("is reachable from the keyboard", async () => {
    const user = userEvent.setup();
    const { handle } = setup();
    await user.tab();
    expect(handle).toHaveFocus();
  });

  it("resizes with the arrow keys", async () => {
    const user = userEvent.setup();
    const { handle, onChange, onCommit } = setup();
    handle.focus();

    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith(188);

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(172);

    // Committed per keypress: an operator resizing with the keyboard and then
    // moving on with the keyboard would otherwise lose the change.
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("takes a bigger step with Shift", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = setup();
    handle.focus();

    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onChange).toHaveBeenCalledWith(220);
  });

  it("jumps to the bounds with Home and End", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = setup();
    handle.focus();

    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenCalledWith(64);

    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith(640);
  });

  it("never reports a value outside its bounds", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = setup({ value: 66 });
    handle.focus();

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledWith(64);
  });

  it("inverts the arrow keys for a handle on a trailing panel's leading edge", async () => {
    // Dragging left widens a right-hand panel. The arrow keys have to agree
    // with the drag, or the keyboard and the pointer disagree about which way
    // "bigger" is.
    const user = userEvent.setup();
    const { handle, onChange } = setup({ direction: -1 });
    handle.focus();

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledWith(188);
  });

  it("tracks a pointer drag and commits once at the end", () => {
    const { handle, onChange, onCommit } = setup();
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 460 });
    expect(onChange).toHaveBeenLastCalledWith(240);

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 430 });
    // Each move is measured from where the drag started, not from the last
    // move, so a jittery pointer cannot accumulate drift.
    expect(onChange).toHaveBeenLastCalledWith(210);

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("ignores pointer movement that did not begin with a press on the handle", () => {
    const { handle, onChange } = setup();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing at all when disabled", async () => {
    const user = userEvent.setup();
    const { handle, onChange } = setup({ disabled: true });

    expect(handle).toHaveAttribute("aria-disabled", "true");
    expect(handle).toHaveAttribute("tabindex", "-1");

    handle.focus();
    await user.keyboard("{ArrowRight}");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500 });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    const { container } = setup();
    await expectNoAccessibilityViolations(container);
  });
});
