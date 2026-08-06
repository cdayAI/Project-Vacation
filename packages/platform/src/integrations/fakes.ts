import type { Clock } from "../kernel/clock.js";
import { digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type { AssociationRecordsPort, ContractRecordsPort } from "./port.js";
import type {
  AssociationBudgetSummary,
  AssociationRef,
  ContractRecord,
  IntegrationDescriptor,
  IntegrationHealth,
} from "./types.js";

/**
 * Realistic fakes for the systems of record.
 *
 * "Realistic" is doing real work in that sentence. These are not stubs that
 * return one happy row: the seeded data is chosen so that every branch the
 * first two workflows have to handle is exercised by something in it — a
 * contract inside its rescission window and one outside, a contract whose
 * disclosure delivery timestamp the system of record simply does not have, an
 * incomplete document set, a financed purchase, a contract the owner has
 * already rescinded, an association with a stale reserve study and one with
 * none at all.
 *
 * Two properties make them safe to develop against.
 *
 * *They are held to the same contract as any real adapter.* The suite in
 * `contract-tests.ts` runs against these, and a real adapter must pass the
 * same cases. A fake that is more forgiving than the real system makes the
 * whole test suite lie, which is worse than having no fake.
 *
 * *They can fail on purpose.* `failNext` and `setAvailable` let a test drive
 * the degradation paths, which are the paths that matter and the ones a
 * happy-path fake makes untestable.
 *
 * The data is invented. It is plausible for a vacation-ownership business and
 * it corresponds to nothing real: no MVW contract, association, or owner is
 * represented here, and the shapes are the guesses described in `types.ts`.
 */

/** Errors the fakes raise. Failures, not refusals — the degradation path. */
export class FakeIntegrationUnavailable extends Error {
  constructor(system: string) {
    super(`${system} did not answer.`);
    this.name = "FakeIntegrationUnavailable";
  }
}

abstract class SeededIntegration {
  protected available = true;
  private failures = 0;

  constructor(protected readonly clock: Clock) {}

  /** Make the next `count` calls fail, to drive the degradation branches. */
  failNext(count = 1): void {
    this.failures = count;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  protected checkAvailability(system: string): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new FakeIntegrationUnavailable(system);
    }
    if (!this.available) throw new FakeIntegrationUnavailable(system);
  }
}

const CONTRACT_SYSTEM = "fake-contract-records";

/**
 * Seeded contract metadata.
 *
 * Timestamps are relative to a fixed origin so the demo reproduces exactly.
 * The origin is a plain constant rather than a clock reading for the same
 * reason: a fake whose data moves with the wall clock produces a test suite
 * that passes on Tuesday.
 */
const CONTRACT_ORIGIN = "2026-08-01T00:00:00.000Z";

function shift(base: IsoTimestamp, days: number): IsoTimestamp {
  return new Date(Date.parse(base) + days * 24 * 60 * 60 * 1000).toISOString();
}

interface SeedContract {
  readonly contractId: string;
  readonly jurisdiction: string;
  readonly status: ContractRecord["status"];
  readonly executedDaysFromOrigin: number;
  readonly disclosuresDeliveredDaysFromOrigin?: number;
  readonly documentSetComplete: boolean;
  readonly missingDocuments: readonly string[];
  readonly financed: boolean;
  readonly rescissionRequestedDaysFromOrigin?: number;
}

const SEED_CONTRACTS: readonly SeedContract[] = [
  {
    // Executed two days ago in Florida: comfortably inside any rescission
    // window, and the ordinary case the workflow is built for.
    contractId: "ctr_fl_recent_complete",
    jurisdiction: "FL",
    status: "executed",
    executedDaysFromOrigin: 3,
    disclosuresDeliveredDaysFromOrigin: 3,
    documentSetComplete: true,
    missingDocuments: [],
    financed: false,
  },
  {
    // Disclosure delivery is unknown. Several states run the period from
    // delivery, so this must produce a referral rather than a deadline.
    contractId: "ctr_fl_missing_disclosure_time",
    jurisdiction: "FL",
    status: "executed",
    executedDaysFromOrigin: 2,
    documentSetComplete: true,
    missingDocuments: [],
    financed: true,
  },
  {
    // Incomplete document set: in several jurisdictions the period does not
    // begin, or restarts, until the set is delivered.
    contractId: "ctr_sc_incomplete_documents",
    jurisdiction: "SC",
    status: "executed",
    executedDaysFromOrigin: 1,
    disclosuresDeliveredDaysFromOrigin: 1,
    documentSetComplete: false,
    missingDocuments: ["public_offering_statement", "reserve_study_summary"],
    financed: false,
  },
  {
    // Long past any window. The workflow must say so plainly rather than
    // computing a date in the past and presenting it as live.
    contractId: "ctr_nv_expired_window",
    jurisdiction: "NV",
    status: "executed",
    executedDaysFromOrigin: -120,
    disclosuresDeliveredDaysFromOrigin: -120,
    documentSetComplete: true,
    missingDocuments: [],
    financed: true,
  },
  {
    // Already rescinded. Nothing further should be proposed for it.
    contractId: "ctr_fl_already_rescinded",
    jurisdiction: "FL",
    status: "rescinded",
    executedDaysFromOrigin: -20,
    disclosuresDeliveredDaysFromOrigin: -20,
    documentSetComplete: true,
    missingDocuments: [],
    financed: false,
    rescissionRequestedDaysFromOrigin: -14,
  },
  {
    // Not yet executed. There is no clock to start.
    contractId: "ctr_hi_pending",
    jurisdiction: "HI",
    status: "pending",
    executedDaysFromOrigin: 0,
    documentSetComplete: false,
    missingDocuments: ["signed_purchase_agreement"],
    financed: false,
  },
];

export class FakeContractRecords extends SeededIntegration implements ContractRecordsPort {
  readonly name = "contract-records";
  readonly version = 1 as const;

  private readonly records: ReadonlyMap<string, ContractRecord>;

  constructor(clock: Clock, seed: readonly SeedContract[] = SEED_CONTRACTS) {
    super(clock);
    const records = new Map<string, ContractRecord>();
    for (const entry of seed) {
      const record: ContractRecord = {
        contractId: entry.contractId as Id<"contract">,
        jurisdiction: entry.jurisdiction,
        status: entry.status,
        executedAt: shift(CONTRACT_ORIGIN, entry.executedDaysFromOrigin),
        disclosuresDeliveredAt:
          entry.disclosuresDeliveredDaysFromOrigin === undefined
            ? undefined
            : shift(CONTRACT_ORIGIN, entry.disclosuresDeliveredDaysFromOrigin),
        documentSetComplete: entry.documentSetComplete,
        missingDocuments: [...entry.missingDocuments],
        financed: entry.financed,
        rescissionRequestedAt:
          entry.rescissionRequestedDaysFromOrigin === undefined
            ? undefined
            : shift(CONTRACT_ORIGIN, entry.rescissionRequestedDaysFromOrigin),
        provenance: {
          system: CONTRACT_SYSTEM,
          retrievedAt: CONTRACT_ORIGIN,
          payloadDigest: digestValue(entry),
        },
      };
      records.set(record.contractId, record);
    }
    this.records = records;
  }

  describe(): IntegrationDescriptor {
    return {
      name: this.name,
      version: this.version,
      systemOfRecord: "UNCONFIRMED — MVW's contract system has not been identified.",
      description: "Contract metadata sufficient to compute a statutory rescission window.",
      // False, loudly. Every field in ContractRecord is our guess about what
      // the calculation needs, not a description of anything MVW has.
      shapeConfirmedWithMvw: false,
    };
  }

  async health(): Promise<IntegrationHealth> {
    return {
      name: this.name,
      version: this.version,
      available: this.available,
      checkedAt: this.clock.nowIso(),
      detail: this.available ? "seeded fake" : "seeded fake, forced unavailable",
    };
  }

  async getContract(contractId: Id<"contract">): Promise<ContractRecord | null> {
    this.checkAvailability(CONTRACT_SYSTEM);
    const found = this.records.get(contractId);
    // Cloned on the way out: a caller that mutates what it was handed must not
    // be able to rewrite the system of record's answer for the next caller.
    return found ? structuredClone(found) : null;
  }

  async listContractsExecutedBetween(
    from: IsoTimestamp,
    to: IsoTimestamp,
    limit = 100,
  ): Promise<readonly ContractRecord[]> {
    this.checkAvailability(CONTRACT_SYSTEM);
    return [...this.records.values()]
      .filter((record) => record.executedAt >= from && record.executedAt < to)
      .sort((left, right) =>
        left.executedAt === right.executedAt
          ? left.contractId < right.contractId
            ? -1
            : 1
          : left.executedAt < right.executedAt
            ? -1
            : 1,
      )
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}

const ASSOCIATION_SYSTEM = "fake-association-records";

const SEED_ASSOCIATIONS: readonly AssociationRef[] = [
  {
    associationId: "1042",
    name: "Palm Grove Vacation Club Owners Association",
    jurisdiction: "FL",
    fiscalYearEndMonth: 12,
  },
  {
    associationId: "2087",
    name: "Mountain Ridge Interval Owners Association",
    jurisdiction: "NV",
    fiscalYearEndMonth: 6,
  },
];

interface SeedBudget {
  readonly associationId: string;
  readonly fiscalYear: number;
  readonly totalBudgetCents: number;
  readonly reserveBalanceCents: number;
  readonly reserveStudyRecommendedCents: number;
  readonly annualAssessmentPerIntervalCents: number;
  readonly reserveStudyDate?: string;
  readonly delinquencyBasisPoints?: number;
}

const SEED_BUDGETS: readonly SeedBudget[] = [
  {
    // Healthy but under-funded reserves against a current study — the ordinary
    // board-pack narrative.
    associationId: "1042",
    fiscalYear: 2026,
    totalBudgetCents: 486_300_00,
    reserveBalanceCents: 122_450_00,
    reserveStudyRecommendedCents: 168_000_00,
    annualAssessmentPerIntervalCents: 1_284_00,
    reserveStudyDate: "2025-09-30",
    delinquencyBasisPoints: 412,
  },
  {
    // No reserve study on file, so no recommended balance can be asserted. The
    // pack has to report the absence rather than compare against zero.
    associationId: "2087",
    fiscalYear: 2026,
    totalBudgetCents: 214_800_00,
    reserveBalanceCents: 61_900_00,
    reserveStudyRecommendedCents: 0,
    annualAssessmentPerIntervalCents: 1_090_00,
  },
  {
    associationId: "1042",
    fiscalYear: 2025,
    totalBudgetCents: 451_200_00,
    reserveBalanceCents: 104_100_00,
    reserveStudyRecommendedCents: 160_000_00,
    annualAssessmentPerIntervalCents: 1_212_00,
    reserveStudyDate: "2024-10-15",
    delinquencyBasisPoints: 505,
  },
];

export class FakeAssociationRecords extends SeededIntegration implements AssociationRecordsPort {
  readonly name = "association-records";
  readonly version = 1 as const;

  private readonly budgets: ReadonlyMap<string, AssociationBudgetSummary>;

  constructor(
    clock: Clock,
    private readonly associations: readonly AssociationRef[] = SEED_ASSOCIATIONS,
    seed: readonly SeedBudget[] = SEED_BUDGETS,
  ) {
    super(clock);
    const budgets = new Map<string, AssociationBudgetSummary>();
    for (const entry of seed) {
      budgets.set(`${entry.associationId}:${entry.fiscalYear}`, {
        associationId: entry.associationId,
        fiscalYear: entry.fiscalYear,
        currency: "USD",
        totalBudgetCents: entry.totalBudgetCents,
        reserveBalanceCents: entry.reserveBalanceCents,
        reserveStudyRecommendedCents: entry.reserveStudyRecommendedCents,
        annualAssessmentPerIntervalCents: entry.annualAssessmentPerIntervalCents,
        reserveStudyDate: entry.reserveStudyDate,
        delinquencyBasisPoints: entry.delinquencyBasisPoints,
        asOf: CONTRACT_ORIGIN,
        provenance: {
          system: ASSOCIATION_SYSTEM,
          retrievedAt: CONTRACT_ORIGIN,
          payloadDigest: digestValue(entry),
        },
      });
    }
    this.budgets = budgets;
  }

  describe(): IntegrationDescriptor {
    return {
      name: this.name,
      version: this.version,
      systemOfRecord: "UNCONFIRMED — MVW's association accounting system has not been identified.",
      description: "Association budget and reserve summary for a homeowners' board pack.",
      shapeConfirmedWithMvw: false,
    };
  }

  async health(): Promise<IntegrationHealth> {
    return {
      name: this.name,
      version: this.version,
      available: this.available,
      checkedAt: this.clock.nowIso(),
      detail: this.available ? "seeded fake" : "seeded fake, forced unavailable",
    };
  }

  async listAssociations(): Promise<readonly AssociationRef[]> {
    this.checkAvailability(ASSOCIATION_SYSTEM);
    return this.associations
      .slice()
      .sort((left, right) => (left.associationId < right.associationId ? -1 : 1))
      .map((entry) => structuredClone(entry));
  }

  async getBudgetSummary(
    associationId: string,
    fiscalYear: number,
  ): Promise<AssociationBudgetSummary | null> {
    this.checkAvailability(ASSOCIATION_SYSTEM);
    const found = this.budgets.get(`${associationId}:${fiscalYear}`);
    return found ? structuredClone(found) : null;
  }
}

/** The contract ids in the seeded fake, for tests and the demo corpus. */
export const SEEDED_CONTRACT_IDS: readonly string[] = SEED_CONTRACTS.map(
  (entry) => entry.contractId,
);

export const SEEDED_ASSOCIATION_IDS: readonly string[] = SEED_ASSOCIATIONS.map(
  (entry) => entry.associationId,
);
