import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAccessibilityViolations, renderSurface } from "../test/axe";
import {
  auditEntries,
  auditVerificationBroken,
  auditVerificationIntact,
} from "../test/fixtures";
import { AuditEvidence, NO_AUDIT_FILTERS } from "./AuditEvidence";

function renderAudit(
  overrides: Partial<Parameters<typeof AuditEvidence>[0]> = {},
): ReturnType<typeof renderSurface> {
  return renderSurface(
    <AuditEvidence
      entries={auditEntries}
      verification={auditVerificationIntact}
      total={auditEntries.length}
      filters={NO_AUDIT_FILTERS}
      onFiltersChange={() => undefined}
      {...overrides}
    />,
  );
}

describe("AuditEvidence", () => {
  it("puts the verification status first, before any entry", () => {
    const { container } = renderAudit();

    const headings = [...container.querySelectorAll("h2")].map((node) => node.textContent);
    expect(headings[0]).toBe("Is this record intact?");
    expect(screen.getByText("Verified intact")).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing has been removed, inserted, back-dated, or altered/),
    ).toBeInTheDocument();
  });

  it("shows every break with its kind and its sequence number when the chain is broken", () => {
    renderAudit({ verification: auditVerificationBroken });

    expect(screen.getByText("This record does not verify")).toBeInTheDocument();

    // role="grid" rather than role="table": the library's table binds J/K/Enter
    // row navigation, which is a widget. It is still a real <table> with a
    // <caption>, <th scope>, and aria-sort, so everything below is unchanged.
    const breaks = screen.getByRole("grid", { name: /Breaks found in the record/ });
    const rows = within(breaks).getAllByRole("row");
    // Header plus all three breaks. Not a count, not the first one — all of them.
    expect(rows).toHaveLength(4);
    expect(within(breaks).getByText("hash mismatch")).toBeInTheDocument();
    expect(within(breaks).getByText("sequence gap")).toBeInTheDocument();
    expect(within(breaks).getByText("previous hash mismatch")).toBeInTheDocument();
    expect(within(breaks).getByText("18,204")).toBeInTheDocument();
    expect(within(breaks).getByText("18,206")).toBeInTheDocument();
    expect(within(breaks).getByText("18,207")).toBeInTheDocument();
  });

  it("does not accuse anyone of tampering when the chain is broken", () => {
    renderAudit({ verification: auditVerificationBroken });

    expect(
      screen.getByText(/A break is not proof that somebody tampered with the record/),
    ).toBeInTheDocument();
  });

  it("explains on the page why the log holds fingerprints rather than the originals", () => {
    renderAudit();

    const explanation = screen.getByRole("region", {
      name: "What this record contains, and what it does not",
    });
    expect(within(explanation).getByText("fingerprint")).toBeInTheDocument();
    expect(
      within(explanation).getByText(/The originals themselves are not copied here/),
    ).toBeInTheDocument();
    expect(
      within(explanation).getByText(/a deletion request can be honoured without breaking the evidence trail/),
    ).toBeInTheDocument();
  });

  it("labels entries for a compliance officer rather than for an engineer", () => {
    renderAudit();

    expect(screen.getByRole("heading", { name: "A human approval was requested" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "An action was refused" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "An agent role was put into service" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "An operator stopped something" })).toBeInTheDocument();

    // The raw code stays available beside it, for quoting in a finding.
    expect(screen.getByText("approval.requested")).toBeInTheDocument();
  });

  it("shows what each entry was about, what was decided, and the fingerprints", () => {
    renderAudit();

    // Once per entry, plus the filter control that carries the same label.
    expect(screen.getAllByText("What it was about")).toHaveLength(auditEntries.length + 1);
    expect(screen.getAllByText("What was decided")).toHaveLength(auditEntries.length);
    expect(screen.getAllByText("Fingerprints of what it was decided from")).toHaveLength(
      auditEntries.length,
    );
    expect(screen.getByText("CTR-2026-FL-0184423")).toBeInTheDocument();
    expect(
      screen.getByText("9c4f1ea77b0d38625af0c9b34e1d5a8206ff73c19ad48be05723c6d1f8904b7e"),
    ).toBeInTheDocument();
  });

  it("shows each entry's own fingerprint and the one before it, untruncated", () => {
    renderAudit();

    expect(screen.getAllByText("This entry's own fingerprint")).toHaveLength(auditEntries.length);
    expect(screen.getAllByText("Fingerprint of the entry before it")).toHaveLength(
      auditEntries.length,
    );
    // The head hash appears both on the verification panel and on entry 41,882.
    expect(
      screen.getAllByText("5f2b8c1de4a70936bb1c4f8a2d0e77c3a9451bd6e8f302447cbb19de5a6027f18"),
    ).toHaveLength(2);
  });

  it("links an entry to the piece of work it belongs to", () => {
    renderAudit();

    expect(screen.getByRole("link", { name: "run_01k3m9x2p7" })).toHaveAttribute(
      "href",
      "/runs/run_01k3m9x2p7",
    );
  });

  it("says when an entry was recorded with no input to fingerprint", () => {
    renderAudit();

    expect(
      screen.getByText(/This decision was made from no recorded input/),
    ).toBeInTheDocument();
  });

  it("asks the server for the filters rather than filtering what happened to load", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAudit({ onFiltersChange });

    // The event-type filter is a listbox combobox, not a native <select>, so
    // choosing is open-then-pick. The option is found by the words a compliance
    // officer reads rather than by the code behind them, which is the same
    // guarantee the "labels entries for a compliance officer" test makes.
    const happened = screen.getByRole("combobox", { name: "What happened" });
    await user.click(happened);
    await user.click(screen.getByRole("option", { name: /^An action was refused/ }));
    expect(happened).toHaveTextContent("An action was refused");

    await user.type(screen.getByLabelText("What it was about"), "CTR-2026-FL-0184423");
    await user.type(screen.getByLabelText("Who or what did it"), "act_bb10f5a7");
    await user.type(screen.getByLabelText("Piece of work"), "run_01k3m6h1c5");
    await user.click(screen.getByRole("button", { name: "Apply these filters" }));

    expect(onFiltersChange).toHaveBeenCalledWith({
      eventType: "authorization.denied",
      actorId: "act_bb10f5a7",
      runId: "run_01k3m6h1c5",
      subject: "CTR-2026-FL-0184423",
      from: "",
      to: "",
    });
  });

  it("filters by a date range", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAudit({ onFiltersChange });

    await user.type(screen.getByLabelText("Recorded on or after"), "2026-08-01");
    await user.type(screen.getByLabelText("Recorded on or before"), "2026-08-06");
    await user.click(screen.getByRole("button", { name: "Apply these filters" }));

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...NO_AUDIT_FILTERS,
      from: "2026-08-01",
      to: "2026-08-06",
    });
  });

  it("clears every filter at once", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderAudit({
      onFiltersChange,
      filters: { ...NO_AUDIT_FILTERS, eventType: "approval.granted" },
    });

    await user.click(screen.getByRole("button", { name: "Clear all filters" }));

    expect(onFiltersChange).toHaveBeenCalledWith(NO_AUDIT_FILTERS);
  });

  it("distinguishes an empty record from a filter that matched nothing", () => {
    const { unmount } = renderAudit({ entries: [], total: 0 });
    expect(
      screen.getByRole("heading", { name: "This record has no entries" }),
    ).toBeInTheDocument();
    unmount();

    renderAudit({
      entries: [],
      total: 0,
      filters: { ...NO_AUDIT_FILTERS, eventType: "retention.purged" },
    });
    expect(
      screen.getByRole("heading", { name: "No entry matches these filters" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/an empty result here means no matching entry exists, not that none was loaded/),
    ).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = renderAudit();
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when the chain is broken", async () => {
    const { container } = renderAudit({ verification: auditVerificationBroken });
    await expectNoAccessibilityViolations(container);
  });

  it("has no accessibility violations when nothing matches", async () => {
    const { container } = renderAudit({ entries: [], total: 0 });
    await expectNoAccessibilityViolations(container);
  });
});
