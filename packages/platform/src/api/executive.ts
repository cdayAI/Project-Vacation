import type { Platform } from "../platform.js";

/**
 * The executive board — knowledge to sales to share price, told honestly.
 *
 * This is the business-value screen, and it is the one screen where a single
 * invented number costs the whole board its credibility: an executive who
 * catches one figure the platform was not entitled to claim stops trusting all
 * of them. So the discipline here is absolute and it is visible in the shape.
 *
 * **Two kinds of tile, and never a blurred one.** `businessMetrics` are MVW's
 * own reported results — contract sales, VPG, EBITDA, margin. Every one carries
 * a `sourceNote` that says "MVW reported ..." and cites the filing, and none is
 * claimed as an effect of this platform. `platformMetrics` are what this
 * deployment measured from its own operating record, and each says "measured by
 * this platform". The platform did not move MVW's share price in Q2 2026, and
 * this board does not imply that it did.
 *
 * **Unmeasured is stated, not estimated.** `humanHoursSaved` needs a baseline
 * handle time agreed with MVW and a measured post-deployment time; until both
 * exist it is omitted and `measurementCaveat` says why, rather than a confident
 * figure nobody measured. `costPerCaseUsd` and `runsCompleted` are counted from
 * the record and are shown; a savings number is not.
 *
 * The business figures are transcribed in `docs/context/mvw-priorities.md` from
 * MVW's Q2 2026 earnings release (Form 8-K filed 6 August 2026, Exhibit 99.1).
 * That document is a reading of the source of record, not the source itself, and
 * every tile's `sourceNote` points a reader at both.
 */

export interface ExecutiveMetricView {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly comparison?: string | undefined;
  readonly direction?: "up" | "down" | "flat" | undefined;
  readonly increaseIsGood?: boolean | undefined;
  readonly sourceNote: string;
}

export interface ExecutiveView {
  readonly asOf: string;
  readonly businessMetrics: readonly ExecutiveMetricView[];
  readonly platformMetrics: readonly ExecutiveMetricView[];
  readonly costPerCaseUsd?: number | undefined;
  readonly runsCompleted: number;
  readonly humanHoursSaved?: number | undefined;
  readonly measurementCaveat: string;
}

/**
 * MVW's own Q2 2026 results. Not attributable to this platform.
 *
 * Each note names the filing and the section of the transcription doc, so a
 * reader can reach the source of record. The numbers are stated exactly as MVW
 * reported them, with the direction and whether an increase is the good
 * direction encoded so the console cannot colour a fall the wrong way.
 */
const MVW_SOURCE =
  "MVW reported this in its Q2 2026 earnings release (Form 8-K filed 6 August 2026, Exhibit 99.1); transcribed in docs/context/mvw-priorities.md. Not attributable to this platform.";

const BUSINESS_METRICS: readonly ExecutiveMetricView[] = [
  {
    key: "contract_sales",
    label: "Contract sales (Q2 2026)",
    value: "$545M",
    comparison: "+22% vs Q2 2025",
    direction: "up",
    increaseIsGood: true,
    sourceNote: `${MVW_SOURCE} See §3.1.`,
  },
  {
    key: "vpg",
    label: "Volume per guest (VPG)",
    value: "$4,477",
    comparison: "+23% vs Q2 2025",
    direction: "up",
    increaseIsGood: true,
    sourceNote: `${MVW_SOURCE} See §3.1.`,
  },
  {
    key: "adjusted_ebitda",
    label: "Adjusted EBITDA (Q2 2026)",
    value: "$215M",
    comparison: "+6% vs Q2 2025",
    direction: "up",
    increaseIsGood: true,
    sourceNote: `${MVW_SOURCE} See §1.`,
  },
  {
    key: "diluted_eps",
    label: "Diluted EPS (Q2 2026)",
    value: "$2.12",
    comparison: "+20% vs Q2 2025",
    direction: "up",
    increaseIsGood: true,
    sourceNote: `${MVW_SOURCE} See §1.`,
  },
  {
    key: "financing_margin",
    label: "Financing profit margin (Q2 2026)",
    value: "54.3%",
    comparison: "−450 bps vs Q2 2025",
    direction: "down",
    // A fall here is the wrong direction; the console must not paint it green.
    increaseIsGood: true,
    sourceNote: `${MVW_SOURCE} See §3.5.`,
  },
  {
    key: "interval_members",
    label: "Interval International members (Q2 2026)",
    value: "1,475K",
    comparison: "−2% vs Q2 2025",
    direction: "down",
    increaseIsGood: true,
    sourceNote: `${MVW_SOURCE} See §3.3.`,
  },
];

/** The epoch, as the "since" for a whole-record cost sum. */
const EPOCH = "1970-01-01T00:00:00.000Z";

const MEASUREMENT_CAVEAT =
  "Human hours saved is not shown because it is not yet measured on this deployment: it needs a baseline handle time per case agreed with MVW and a measured post-deployment time, and until both exist this board reports it as unmeasured rather than as a confident number. The business figures above are MVW's own reported results and are not claimed as effects of this platform; the platform figures below are counted from this deployment's operating record.";

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * Build the executive view.
 *
 * The platform figures are read from the operating record here: the number of
 * cases carried to a successful close, the total spend recorded, and the spend
 * per case. Nothing is asserted — every platform number is a count or a sum an
 * operator could reproduce.
 */
export async function executiveView(platform: Platform): Promise<ExecutiveView> {
  const asOf = platform.clock.nowIso();

  const [totalRuns, runsCompleted, rollups] = await Promise.all([
    platform.runs.countRuns({}),
    platform.runs.countRuns({ status: ["succeeded"] }),
    platform.runs.costRollupSince(EPOCH),
  ]);

  const totalSpendUsd = round4(rollups.reduce((sum, rollup) => sum + rollup.totalUsd, 0));
  // Spend per case across every case on the record. Absent, not zero, when the
  // record holds no cases — a cost-per-case of $0.00 over nothing is a claim the
  // record cannot support.
  const costPerCaseUsd = totalRuns > 0 ? round4(totalSpendUsd / totalRuns) : undefined;

  const platformMetrics: readonly ExecutiveMetricView[] = [
    {
      key: "cases_recorded",
      label: "Cases on the operating record",
      value: String(totalRuns),
      sourceNote: "Measured by this platform: every run recorded in the operating record.",
    },
    {
      key: "cases_completed",
      label: "Cases carried to a successful close",
      value: String(runsCompleted),
      sourceNote:
        "Measured by this platform: runs the operating record shows reached a succeeded state.",
    },
    {
      key: "platform_spend",
      label: "Platform spend recorded",
      value: `$${totalSpendUsd.toFixed(2)}`,
      sourceNote:
        "Measured by this platform: model, retrieval, and integration spend summed from the cost ledger.",
    },
  ];

  return {
    asOf,
    businessMetrics: BUSINESS_METRICS,
    platformMetrics,
    costPerCaseUsd,
    runsCompleted,
    // Omitted on purpose: unmeasured, and stated as such in the caveat.
    humanHoursSaved: undefined,
    measurementCaveat: MEASUREMENT_CAVEAT,
  };
}
