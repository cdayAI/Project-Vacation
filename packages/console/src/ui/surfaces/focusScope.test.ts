import { afterEach, describe, expect, it } from "vitest";
import {
  captureFocusOrigin,
  focusInitialElement,
  tabbableWithin,
  wrapTabFocus,
} from "./focusScope";

/**
 * Plain DOM, no React. The trap is the part of an overlay that has to be right
 * before anything else works, and testing it here means it is tested once
 * rather than four times through four different components.
 */

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

function tabEvent(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tabbableWithin", () => {
  it("finds controls in document order", () => {
    const host = mount(`
      <button id="a">A</button>
      <a id="b" href="/x">B</a>
      <input id="c" />
    `);

    expect(tabbableWithin(host).map((element) => element.id)).toEqual(["a", "b", "c"]);
  });

  it("skips disabled controls, including aria-disabled ones", () => {
    const host = mount(`
      <button id="a">A</button>
      <button id="b" disabled>B</button>
      <button id="c" aria-disabled="true">C</button>
    `);

    expect(tabbableWithin(host).map((element) => element.id)).toEqual(["a"]);
  });

  it("skips hidden, inert, and aria-hidden subtrees", () => {
    const host = mount(`
      <button id="a">A</button>
      <button id="b" hidden>B</button>
      <div inert><button id="c">C</button></div>
      <div aria-hidden="true"><button id="d">D</button></div>
      <button id="e" style="display: none">E</button>
    `);

    expect(tabbableWithin(host).map((element) => element.id)).toEqual(["a"]);
  });

  it("treats tabindex=-1 as focusable by script but not a tab stop", () => {
    const host = mount(`
      <h2 id="title" tabindex="-1">Title</h2>
      <button id="a">A</button>
    `);

    expect(tabbableWithin(host).map((element) => element.id)).toEqual(["a"]);
  });

  it("skips unchecked radios in a group that already has a checked member", () => {
    // Landing on the wrong radio in a group reads as the overlay silently
    // changing the operator's answer.
    const host = mount(`
      <input type="radio" name="reason" id="r1" />
      <input type="radio" name="reason" id="r2" checked />
      <input type="radio" name="other" id="r3" />
    `);

    expect(tabbableWithin(host).map((element) => element.id)).toEqual(["r2", "r3"]);
  });
});

describe("wrapTabFocus", () => {
  it("wraps forward from the last stop to the first", () => {
    const host = mount(`<button id="a">A</button><button id="b">B</button>`);
    document.getElementById("b")?.focus();

    expect(wrapTabFocus(host, tabEvent())).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("wraps backward from the first stop to the last", () => {
    const host = mount(`<button id="a">A</button><button id="b">B</button>`);
    document.getElementById("a")?.focus();

    expect(wrapTabFocus(host, tabEvent(true))).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("leaves interior movement to the browser", () => {
    const host = mount(`<button id="a">A</button><button id="b">B</button>`);
    document.getElementById("a")?.focus();

    expect(wrapTabFocus(host, tabEvent())).toBe(false);
    expect(document.activeElement?.id).toBe("a");
  });

  it("pulls focus back in when it has escaped the container", () => {
    const host = mount(`<button id="a">A</button><button id="b">B</button>`);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    expect(wrapTabFocus(host, tabEvent())).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("does nothing for keys that are not Tab", () => {
    const host = mount(`<button id="a">A</button>`);
    expect(wrapTabFocus(host, new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
  });

  it("declines to trap when there is nothing to trap", () => {
    // Preventing Tab here would leave the operator with a dead key and no
    // explanation, which is worse than briefly leaving the overlay.
    const host = mount(`<p>Nothing focusable.</p>`);
    expect(wrapTabFocus(host, tabEvent())).toBe(false);
  });
});

describe("captureFocusOrigin", () => {
  it("returns focus to where it was", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const restore = captureFocusOrigin();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();

    restore();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not throw when the trigger has been removed", () => {
    // A row sheet whose row was filtered away while it was open.
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    const restore = captureFocusOrigin();
    trigger.remove();

    expect(() => restore()).not.toThrow();
  });
});

describe("focusInitialElement", () => {
  it("prefers the nominated element over the first control", () => {
    const host = mount(`
      <h2 id="title" tabindex="-1">The ask</h2>
      <button id="approve">Approve</button>
    `);

    focusInitialElement(host, document.getElementById("title") as HTMLElement);
    expect(document.activeElement?.id).toBe("title");
  });

  it("falls back to the first control when nothing is nominated", () => {
    const host = mount(`<button id="approve">Approve</button>`);
    focusInitialElement(host, null);
    expect(document.activeElement?.id).toBe("approve");
  });

  it("falls back to the container when it holds no controls", () => {
    const host = mount(`<p>Read-only content.</p>`);
    host.tabIndex = -1;
    focusInitialElement(host, null);
    expect(document.activeElement).toBe(host);
  });
});
