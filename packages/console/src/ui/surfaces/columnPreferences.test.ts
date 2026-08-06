import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredTableView,
  moveColumn,
  readStoredTableView,
  resolveTableView,
  tableViewStorageKey,
  toggleColumnVisibility,
  writeStoredTableView,
  type ColumnConstraints,
} from "./columnPreferences";

function column(key: string, overrides: Partial<ColumnConstraints> = {}): ColumnConstraints {
  return { key, width: 160, minWidth: 64, maxWidth: 640, ...overrides };
}

const QUEUE_COLUMNS: readonly ColumnConstraints[] = [
  column("status", { width: 32, minWidth: 32, maxWidth: 64, alwaysVisible: true }),
  column("what", { width: 320, alwaysVisible: true }),
  column("owner", { width: 180 }),
  column("age", { width: 100 }),
  column("value", { width: 120 }),
];

afterEach(() => {
  window.localStorage.clear();
});

describe("storage", () => {
  it("round-trips a view", () => {
    writeStoredTableView("work-queue", {
      order: ["what", "status"],
      hidden: ["owner"],
      widths: { what: 400 },
    });

    expect(readStoredTableView("work-queue")).toEqual({
      order: ["what", "status"],
      hidden: ["owner"],
      widths: { what: 400 },
    });
  });

  it("namespaces the key by table", () => {
    expect(tableViewStorageKey("work-queue")).toBe("pv.console.table.work-queue");
  });

  it("ignores a payload written by a different version", () => {
    window.localStorage.setItem(
      tableViewStorageKey("work-queue"),
      JSON.stringify({ v: 99, order: ["what"], hidden: [], widths: {} }),
    );
    expect(readStoredTableView("work-queue")).toBeNull();
  });

  it("ignores malformed storage instead of throwing inside a first render", () => {
    window.localStorage.setItem(tableViewStorageKey("work-queue"), "not json");
    expect(readStoredTableView("work-queue")).toBeNull();

    window.localStorage.setItem(
      tableViewStorageKey("work-queue"),
      JSON.stringify({ v: 1, order: "what", hidden: 3, widths: { what: "wide" } }),
    );
    expect(readStoredTableView("work-queue")).toEqual({ order: [], hidden: [], widths: {} });
  });

  it("survives storage being unavailable", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(readStoredTableView("work-queue")).toBeNull();
    expect(() => writeStoredTableView("work-queue", { order: [], hidden: [], widths: {} })).not.toThrow();
    expect(() => clearStoredTableView("work-queue")).not.toThrow();

    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it("clears a view", () => {
    writeStoredTableView("work-queue", { order: ["what"], hidden: [], widths: {} });
    clearStoredTableView("work-queue");
    expect(readStoredTableView("work-queue")).toBeNull();
  });
});

describe("resolveTableView", () => {
  it("uses the defined order when nothing is stored", () => {
    const resolved = resolveTableView(QUEUE_COLUMNS, null);
    expect(resolved.order).toEqual(["status", "what", "owner", "age", "value"]);
    expect(resolved.hidden.size).toBe(0);
  });

  it("honours the operator's arrangement", () => {
    const resolved = resolveTableView(QUEUE_COLUMNS, {
      order: ["what", "value", "status", "owner", "age"],
      hidden: [],
      widths: {},
    });
    expect(resolved.order).toEqual(["what", "value", "status", "owner", "age"]);
  });

  it("drops keys the build no longer defines", () => {
    // A removed column must not leave a hole, and a key from another table
    // must not be able to render anything.
    const resolved = resolveTableView(QUEUE_COLUMNS, {
      order: ["what", "cost", "status", "owner", "age", "value"],
      hidden: [],
      widths: {},
    });
    expect(resolved.order).not.toContain("cost");
    expect(resolved.order).toHaveLength(5);
  });

  it("drops duplicate keys from a corrupted payload", () => {
    const resolved = resolveTableView(QUEUE_COLUMNS, {
      order: ["what", "what", "status", "owner", "age", "value"],
      hidden: [],
      widths: {},
    });
    expect(resolved.order.filter((key) => key === "what")).toHaveLength(1);
  });

  it("puts a newly defined column beside the neighbour it was defined next to", () => {
    // The bug this prevents: a release adds a column, every operator with a
    // stored order finds it at the far right or not at all, and reports it as
    // missing.
    const withRisk: readonly ColumnConstraints[] = [
      QUEUE_COLUMNS[0] as ColumnConstraints,
      column("risk", { width: 90 }),
      ...QUEUE_COLUMNS.slice(1),
    ];

    const resolved = resolveTableView(withRisk, {
      order: ["what", "status", "owner", "age", "value"],
      hidden: [],
      widths: {},
    });

    expect(resolved.order.indexOf("risk")).toBe(resolved.order.indexOf("status") + 1);
  });

  it("places a new leading column before the column it precedes", () => {
    const withFlag: readonly ColumnConstraints[] = [column("flag", { width: 32 }), ...QUEUE_COLUMNS];
    const resolved = resolveTableView(withFlag, {
      order: ["status", "what", "owner", "age", "value"],
      hidden: [],
      widths: {},
    });

    expect(resolved.order[0]).toBe("flag");
  });

  it("refuses to hide a column the table is meaningless without", () => {
    const resolved = resolveTableView(QUEUE_COLUMNS, {
      order: [],
      hidden: ["what", "owner"],
      widths: {},
    });

    expect(resolved.hidden.has("what")).toBe(false);
    expect(resolved.hidden.has("owner")).toBe(true);
  });

  it("ignores a stored view that would leave no columns at all", () => {
    const optional = QUEUE_COLUMNS.map((entry) => ({ ...entry, alwaysVisible: false }));
    const resolved = resolveTableView(optional, {
      order: [],
      hidden: optional.map((entry) => entry.key),
      widths: {},
    });

    expect(resolved.hidden.size).toBe(0);
  });

  it("clamps stored widths to the column's own bounds", () => {
    // A 4000px column stored from a wide monitor arriving on a laptop is a
    // column nobody can scroll past.
    const resolved = resolveTableView(QUEUE_COLUMNS, {
      order: [],
      hidden: [],
      widths: { what: 4000, status: 4, age: 220 },
    });

    expect(resolved.widths.what).toBe(640);
    expect(resolved.widths.status).toBe(32);
    expect(resolved.widths.age).toBe(220);
  });

  it("falls back to the defined width for a column with nothing stored", () => {
    const resolved = resolveTableView(QUEUE_COLUMNS, { order: [], hidden: [], widths: {} });
    expect(resolved.widths.owner).toBe(180);
  });
});

describe("moveColumn", () => {
  const order = ["status", "what", "owner", "age"];

  it("moves a column later", () => {
    expect(moveColumn(order, "what", 3)).toEqual(["status", "owner", "age", "what"]);
  });

  it("moves a column earlier", () => {
    expect(moveColumn(order, "age", 0)).toEqual(["age", "status", "what", "owner"]);
  });

  it("clamps a target beyond either end", () => {
    expect(moveColumn(order, "status", 99)).toEqual(["what", "owner", "age", "status"]);
    expect(moveColumn(order, "age", -5)).toEqual(["age", "status", "what", "owner"]);
  });

  it("returns the same order for a no-op or an unknown key", () => {
    expect(moveColumn(order, "status", 0)).toBe(order);
    expect(moveColumn(order, "nope", 1)).toBe(order);
  });
});

describe("toggleColumnVisibility", () => {
  const order = ["status", "what", "owner"];

  it("hides and shows", () => {
    const hidden = toggleColumnVisibility(new Set(), order, "owner");
    expect([...hidden]).toEqual(["owner"]);
    expect([...toggleColumnVisibility(hidden, order, "owner")]).toEqual([]);
  });

  it("refuses to hide the last visible column", () => {
    const hidden = new Set(["status", "what"]);
    expect(toggleColumnVisibility(hidden, order, "owner")).toBe(hidden);
  });
});
