import axe, { type Result, type RunOptions } from "axe-core";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { ClientProvider } from "../api/ClientProvider";
import type { ConsoleClient } from "../api/client";
import { ThemeProvider } from "../theme/ThemeProvider";

/**
 * The accessibility assertion every view is required to carry.
 *
 * tools/check-accessibility-coverage.mjs looks for a call to this in a test
 * file that also names the view. Automated rules catch roughly the
 * machine-detectable half of WCAG 2.2 AA — they do not catch a focus order
 * that is technically valid and practically wrong, an unclear label, or a live
 * region that announces at the wrong moment. Those remain a manual
 * keyboard-only and screen-reader pass, recorded as such in the handover
 * (ADR 0014).
 */

const WCAG_22_AA: RunOptions = {
  runOnly: {
    type: "tag",
    values: [
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22a",
      "wcag22aa",
      // Not conformance criteria, but every one of them is a real defect for
      // an operator: a skipped heading level, content outside a landmark, a
      // list built out of the wrong elements.
      "best-practice",
    ],
  },
};

function describe(violations: readonly Result[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes
        .map((node) => `      ${node.target.join(" ")}\n        ${node.failureSummary ?? ""}`)
        .join("\n");
      return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n    ${violation.helpUrl}\n${targets}`;
    })
    .join("\n\n");
}

export async function expectNoAccessibilityViolations(
  container: Element,
  options: RunOptions = WCAG_22_AA,
): Promise<void> {
  const results = await axe.run(container, options);
  if (results.violations.length > 0) {
    throw new Error(
      `axe-core found ${results.violations.length} accessibility violation(s):\n\n${describe(
        results.violations,
      )}`,
    );
  }
}

/**
 * Renders a view inside a `<main>` landmark and the providers it expects.
 *
 * The landmark is not decoration for the test's benefit: in the running
 * console every view is inside `<main>`, and asserting against a fragment that
 * floats outside any landmark would both miss real problems and manufacture
 * fake ones.
 */
export function renderSurface(
  ui: ReactElement,
  options: { readonly client?: ConsoleClient } = {},
): RenderResult {
  const { client } = options;
  return render(ui, {
    wrapper: ({ children }) => {
      const content = <main>{children}</main>;
      const themed = <ThemeProvider>{content}</ThemeProvider>;
      return client === undefined ? (
        themed
      ) : (
        <ClientProvider client={client}>{themed}</ClientProvider>
      );
    },
  });
}

/**
 * Renders the whole shell, which brings its own `<main>` and its own theme
 * provider. Wrapping it the way `renderSurface` does would nest one main
 * landmark inside another, which is both a real violation and a fake one.
 */
export function renderShell(ui: ReactElement, client: ConsoleClient): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => <ClientProvider client={client}>{children}</ClientProvider>,
  });
}
