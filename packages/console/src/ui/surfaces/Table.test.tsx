import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../../test/axe";
import { ThemeProvider } from "../../theme/ThemeProvider";
import tokensSource from "../../theme/tokens.css?raw";
import { ROW_HEIGHT_PX, Table, type TableColumn } from "./Table";

interface Case {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly value: number;
}

function makeCases(count: number): readonly Case[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `case-${index}`,
    title: `Rescission package ${index}`,
    owner: index % 2 === 0 ? "M. Delgado" : "A. Okonkwo",
    value: (count - index) * 100,
  }));
}

const COLUMNS: readonly TableColumn<Case>[] = [
  {
    key: "title",
    header: "What",
    rowHeader: true,
    width: 320,
    sortValue: (row) => row.title,
    cell: (row) => row.title,
  },
  {
    key: "owner",
    header: "Owner",
    width: 180,
    sortValue: (row) => row.owner,
    cell: (row) => row.owner,
  },
  {
    key: "value",
    header: "Value",
    width: 120,
    numeric: true,
    sortValue: (row) => row.value,
    cell: (row) => `$${row.value.toLocaleString()}`,
  },
];

function renderTable(props: Partial<Parameters<typeof Table<Case>>[0]> = {}, rowCount = 12) {
  return renderSurface(
    <Table
      caption="Work queue"
      tableId="test-queue"
      columns={COLUMNS}
      rows={makeCases(rowCount)}
      rowKey={(row) => row.id}
      rowNoun="cases"
      {...props}
    />,
  );
}

function rowKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-row-key]")].map(
    (element) => element.dataset.rowKey ?? "",
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe("Table", () => {
  describe("row heights", () => {
    it("agrees with the density tokens the stylesheet declares", () => {
      // The virtualizer needs the number in JavaScript and the row needs it as
      // a token. A drift between them does not look wrong — it makes the
      // scrollbar lie and the keyboard cursor slip a row every few pages.
      const comfortable = /:root\s*\{[\s\S]*?--pv-row-height:\s*([\d.]+)rem/.exec(tokensSource);
      const compact =
        /\[data-density="compact"\]\s*\{[\s\S]*?--pv-row-height:\s*([\d.]+)rem/.exec(tokensSource);

      expect(Number(comfortable?.[1]) * 16).toBe(ROW_HEIGHT_PX.comfortable);
      expect(Number(compact?.[1]) * 16).toBe(ROW_HEIGHT_PX.compact);
    });

    it("matches the specification: 52 comfortable, 40 compact", () => {
      expect(ROW_HEIGHT_PX).toEqual({ comfortable: 52, compact: 40 });
    });
  });

  describe("telling the truth about how many rows there are", () => {
    it("announces the real total, not the number of mounted rows", () => {
      // An operator told there are 30 rows when there are 10,000 will act on it.
      renderTable({}, 10_000);

      const grid = screen.getByRole("grid", { name: "Work queue" });
      expect(grid).toHaveAttribute("aria-rowcount", "10001");
      expect(rowKeys().length).toBeLessThan(60);
    });

    it("gives every row its position in the whole set", () => {
      renderTable({}, 10_000);
      const first = document.querySelector('[data-row-key="case-0"]');
      // 1 is the header row, so the first body row is 2.
      expect(first).toHaveAttribute("aria-rowindex", "2");
    });

    it("uses the server's total when the rows are only what has loaded", () => {
      renderTable({ totalRowCount: 1240 }, 40);
      expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1241");
      expect(screen.getByRole("status")).toHaveTextContent("1,240 cases");
    });

    it("keeps the count visible and live so a filter announces its result", () => {
      renderTable({}, 12);
      const count = screen.getByRole("status");
      expect(count).toHaveTextContent("12 cases");
      expect(count).toHaveAttribute("data-numeric");
    });
  });

  describe("virtualization", () => {
    it("renders a window of rows and keeps the scroll height of the whole list", () => {
      const { container } = renderTable({}, 10_000);
      const spacers = container.querySelectorAll<HTMLElement>(".pv-table-spacer");
      const mounted = rowKeys().length;

      const trailing = spacers[spacers.length - 1];
      expect(spacers.length).toBeGreaterThan(0);
      // Spacer height plus mounted rows accounts for every row in the list.
      const trailingRows = Number.parseInt(trailing?.style.height ?? "0", 10) / ROW_HEIGHT_PX.comfortable;
      expect(mounted + trailingRows).toBe(10_000);
    });

    it("hides the spacers from assistive technology", () => {
      // A screen reader walking into a 520,000-pixel empty row has been told
      // something absurd. The count and the indices carry the truth instead.
      const { container } = renderTable({}, 10_000);
      for (const spacer of container.querySelectorAll(".pv-table-spacer")) {
        expect(spacer).toHaveAttribute("aria-hidden", "true");
      }
    });

    it("draws no spacers for a list that fits", () => {
      const { container } = renderTable({}, 4);
      expect(container.querySelectorAll(".pv-table-spacer")).toHaveLength(0);
    });
  });

  describe("sorting", () => {
    it("sorts itself when no sort handler is supplied", async () => {
      const user = userEvent.setup();
      renderTable({}, 6);

      await user.click(screen.getByRole("button", { name: /^Owner/ }));
      const owners = [...document.querySelectorAll(".pv-table-row")].map(
        (row) => row.children[1]?.textContent,
      );
      expect(owners[0]).toBe("A. Okonkwo");
    });

    it("reverses on a second activation", async () => {
      const user = userEvent.setup();
      renderTable({}, 6);
      const header = screen.getByRole("button", { name: /^Value/ });

      await user.click(header);
      expect(screen.getByRole("columnheader", { name: /Value/ })).toHaveAttribute(
        "aria-sort",
        "ascending",
      );

      await user.click(header);
      expect(screen.getByRole("columnheader", { name: /Value/ })).toHaveAttribute(
        "aria-sort",
        "descending",
      );
    });

    it("reports the intent and renders what it is given when a handler is supplied", async () => {
      // A server-paged table cannot sort its own page and call it sorted.
      const user = userEvent.setup();
      const onSortChange = vi.fn();
      renderTable({ onSortChange, sort: null }, 6);

      await user.click(screen.getByRole("button", { name: /^Owner/ }));
      expect(onSortChange).toHaveBeenCalledWith({ columnKey: "owner", direction: "ascending" });
      expect(rowKeys()[0]).toBe("case-0");
    });

    it("says in words what activating a header will do", () => {
      renderTable({}, 4);
      expect(screen.getByRole("button", { name: /Owner, not sorted/ })).toHaveAccessibleName(
        /Activate to sort ascending/,
      );
    });

    it("leaves a column without a sort value as plain text", () => {
      const columns: readonly TableColumn<Case>[] = [
        { key: "title", header: "What", rowHeader: true, cell: (row) => row.title },
      ];
      renderTable({ columns }, 3);
      expect(screen.queryByRole("button", { name: /What/ })).toBeNull();
      expect(screen.getByRole("columnheader")).not.toHaveAttribute("aria-sort");
    });
  });

  describe("the keyboard model", () => {
    it("is one tab stop, not one per row", async () => {
      const user = userEvent.setup();
      renderTable({}, 12);

      await user.tab();
      await user.tab();
      await user.tab();
      // Count, Columns button, then the first sortable header — the rows are
      // reached by arrowing, not by tabbing forty times.
      const stops = rowKeys().filter(
        (key) => document.querySelector(`[data-row-key="${key}"]`)?.getAttribute("tabindex") === "0",
      );
      expect(stops).toHaveLength(1);
    });

    it("moves the cursor with J and K", async () => {
      const user = userEvent.setup();
      renderTable({}, 12);

      const first = document.querySelector<HTMLElement>('[data-row-key="case-0"]');
      first?.focus();
      await user.keyboard("j");
      expect(document.querySelector('[data-row-key="case-1"]')).toHaveFocus();

      await user.keyboard("k");
      expect(document.querySelector('[data-row-key="case-0"]')).toHaveFocus();
    });

    it("moves with the arrow keys too", async () => {
      const user = userEvent.setup();
      renderTable({}, 12);

      document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
      await user.keyboard("{ArrowDown}{ArrowDown}");
      expect(document.querySelector('[data-row-key="case-2"]')).toHaveFocus();
    });

    it("jumps to the ends with Home and End", async () => {
      const user = userEvent.setup();
      renderTable({}, 12);

      document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
      await user.keyboard("{End}");
      expect(document.querySelector('[data-row-key="case-11"]')).toHaveFocus();

      await user.keyboard("{Home}");
      expect(document.querySelector('[data-row-key="case-0"]')).toHaveFocus();
    });

    it("opens the focused row on Enter", async () => {
      const user = userEvent.setup();
      const onOpenRow = vi.fn();
      renderTable({ onOpenRow }, 12);

      document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
      await user.keyboard("j{Enter}");
      expect(onOpenRow).toHaveBeenCalledWith("case-1", expect.objectContaining({ id: "case-1" }));
    });

    it("previews on Space without navigating", async () => {
      const user = userEvent.setup();
      const onPreviewRow = vi.fn();
      const onOpenRow = vi.fn();
      renderTable({ onPreviewRow, onOpenRow }, 12);

      document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
      await user.keyboard(" ");
      expect(onPreviewRow).toHaveBeenCalledWith("case-0", expect.anything());
      expect(onOpenRow).not.toHaveBeenCalled();
    });

    it("toggles selection on X", async () => {
      const user = userEvent.setup();
      const onToggleSelect = vi.fn();
      renderTable({ onToggleSelect }, 12);

      document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
      await user.keyboard("x");
      expect(onToggleSelect).toHaveBeenCalledWith("case-0", expect.anything());
    });

    it("range-selects with Shift+J and Shift+K", async () => {
      const user = userEvent.setup();
      const onSelectRange = vi.fn();
      renderTable({ onSelectRange }, 12);

      document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
      await user.keyboard("{Shift>}jj{/Shift}");

      expect(onSelectRange).toHaveBeenLastCalledWith(["case-0", "case-1", "case-2"]);

      await user.keyboard("{Shift>}k{/Shift}");
      expect(onSelectRange).toHaveBeenLastCalledWith(["case-0", "case-1"]);
    });

    it("publishes the keys it binds, so a shortcut reference can list them", async () => {
      const { TABLE_SHORTCUTS } = await import("./Table");
      expect(TABLE_SHORTCUTS.map((entry) => entry.action)).toContain("Toggle selection");
    });
  });

  describe("selection", () => {
    it("marks a selected row for a screen reader as well as with the accent bar", () => {
      renderTable({ selectedKeys: new Set(["case-2"]), onToggleSelect: vi.fn() }, 12);

      const row = document.querySelector('[data-row-key="case-2"]');
      expect(row).toHaveAttribute("aria-selected", "true");
      expect(row).toHaveAttribute("data-selected", "true");
      expect(screen.getByRole("grid")).toHaveAttribute("aria-multiselectable", "true");
    });

    it("claims no selection model at all when the screen binds none", () => {
      renderTable({}, 12);
      expect(screen.getByRole("grid")).not.toHaveAttribute("aria-multiselectable");
      expect(document.querySelector('[data-row-key="case-0"]')).not.toHaveAttribute("aria-selected");
    });
  });

  describe("column configuration", () => {
    it("hides a column and remembers it for this operator", async () => {
      const user = userEvent.setup();
      const { unmount } = renderTable({}, 6);

      await user.click(screen.getByRole("button", { name: "Columns" }));
      await user.click(screen.getByRole("checkbox", { name: "Owner" }));
      expect(screen.queryByRole("columnheader", { name: /Owner/ })).toBeNull();

      unmount();
      renderTable({}, 6);
      expect(screen.queryByRole("columnheader", { name: /Owner/ })).toBeNull();
    });

    it("reorders with buttons, so the keyboard can do it too", async () => {
      // A drag-only reorder is unusable from a keyboard and unpleasant with a
      // trackpad, and column order is a per-user setting.
      const user = userEvent.setup();
      renderTable({}, 6);

      await user.click(screen.getByRole("button", { name: "Columns" }));
      await user.click(screen.getByRole("button", { name: "Move Value earlier" }));

      const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent ?? "");
      expect(headers[1]).toContain("Value");
    });

    it("refuses to hide the column that identifies the row", () => {
      renderTable({}, 6);
      const chooserTrigger = screen.getByRole("button", { name: "Columns" });
      expect(chooserTrigger).toBeInTheDocument();
    });

    it("resizes a column from the keyboard and remembers the width", async () => {
      const user = userEvent.setup();
      const { container, unmount } = renderTable({}, 6);

      const handle = screen.getByRole("separator", { name: "Owner column width" });
      handle.focus();
      await user.keyboard("{ArrowRight}");

      unmount();
      const second = renderTable({}, 6);
      const cols = second.container.querySelectorAll("col");
      expect(cols[1]?.getAttribute("style")).toContain("188px");
      expect(container).toBeDefined();
    });
  });

  describe("designed states", () => {
    it("shows a calm empty block rather than an empty grid", () => {
      renderTable({ empty: "Nothing needs you right now." }, 0);
      expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
    });

    it("has an empty state even when the screen forgets to supply one", () => {
      renderTable({}, 0);
      expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
    });

    it("shows a skeleton while the first page loads", () => {
      const { container } = renderTable({ loading: true }, 0);
      expect(container.querySelector(".pv-table-scroller")).toHaveAttribute("aria-busy", "true");
      expect(container.querySelectorAll(".pv-surface-skeleton")).toHaveLength(8);
    });

    it("states an error in words", () => {
      renderTable({ error: "We could not reach the case store. Reference 8f2a41." }, 0);
      expect(screen.getByText("Error")).toBeInTheDocument();
    });

    describe("read-only", () => {
      it("says so once and keeps everything that does not change anything", () => {
        renderTable({ readOnly: true, selectedKeys: new Set(["case-1"]), onToggleSelect: vi.fn() }, 6);

        expect(screen.getByText("Read-only")).toBeInTheDocument();
        expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
        // Sorting and column configuration survive: neither changes a record.
        expect(screen.getByRole("button", { name: "Columns" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^Owner/ })).toBeInTheDocument();
      });

      it("drops selection, because selection exists to feed bulk actions", async () => {
        const user = userEvent.setup();
        const onToggleSelect = vi.fn();
        renderTable({ readOnly: true, onToggleSelect }, 6);

        document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
        await user.keyboard("x");
        expect(onToggleSelect).not.toHaveBeenCalled();
        expect(screen.getByRole("grid")).not.toHaveAttribute("aria-multiselectable");
      });

      it("still lets an auditor read a row", async () => {
        const user = userEvent.setup();
        const onPreviewRow = vi.fn();
        renderTable({ readOnly: true, onPreviewRow }, 6);

        document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
        await user.keyboard(" ");
        expect(onPreviewRow).toHaveBeenCalled();
      });
    });
  });

  describe("density", () => {
    it("changes row height without rebuilding the table", () => {
      window.localStorage.setItem("pv.console.density", "compact");
      render(
        <ThemeProvider>
          <main>
            <Table
              caption="Work queue"
              tableId="density-queue"
              columns={COLUMNS}
              rows={makeCases(10_000)}
              rowKey={(row) => row.id}
            />
          </main>
        </ThemeProvider>,
      );

      // A compact row is 40px, so the same viewport fallback covers more rows.
      const spacer = document.querySelector<HTMLElement>(".pv-table-spacer:last-of-type");
      const mounted = rowKeys().length;
      const trailingRows = Number.parseInt(spacer?.style.height ?? "0", 10) / ROW_HEIGHT_PX.compact;
      expect(mounted + trailingRows).toBe(10_000);
    });
  });

  it("asks for the next page once when the operator reaches the end", () => {
    const onEndReached = vi.fn();
    const { container } = renderTable({ onEndReached }, 20);
    const scroller = container.querySelector(".pv-table-scroller");
    if (scroller === null) throw new Error("no scroller");

    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    // jsdom reports a zero-height scroller, which reads as "at the end" — the
    // point of this assertion is the guard, not the threshold.
    expect(onEndReached.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("tracks the cursor for a screen that binds it", async () => {
    const user = userEvent.setup();
    function Bound() {
      const [activeKey, setActiveKey] = useState<string | null>("case-0");
      return (
        <>
          <p>Previewing {activeKey}</p>
          <Table
            caption="Work queue"
            tableId="bound-queue"
            columns={COLUMNS}
            rows={makeCases(8)}
            rowKey={(row) => row.id}
            activeKey={activeKey}
            onActiveKeyChange={setActiveKey}
          />
        </>
      );
    }
    renderSurface(<Bound />);

    document.querySelector<HTMLElement>('[data-row-key="case-0"]')?.focus();
    await user.keyboard("jj");
    await waitFor(() => expect(screen.getByText("Previewing case-2")).toBeInTheDocument());
  });

  it("keeps the caption available to a screen reader without printing it twice", () => {
    const { container } = renderTable({}, 4);
    const caption = container.querySelector("caption");
    expect(caption).toHaveTextContent("Work queue");
    expect(caption).toHaveClass("pv-sr-only");
  });

  it("puts the row header on the column that identifies the row", () => {
    renderTable({}, 4);
    const row = document.querySelector('[data-row-key="case-0"]');
    if (row === null) throw new Error("no row");
    expect(within(row as HTMLElement).getByRole("rowheader")).toHaveTextContent(
      "Rescission package 0",
    );
  });

  it("has no accessibility violations", async () => {
    const { container } = renderTable({ selectedKeys: new Set(["case-1"]), onToggleSelect: vi.fn() }, 200);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations while loading", async () => {
    const { container } = renderTable({ loading: true }, 0);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when read-only", async () => {
    const { container } = renderTable({ readOnly: true }, 6);
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when empty", async () => {
    const { container } = renderTable({}, 0);
    await expectNoAccessibilityViolations(container);
  });
});
