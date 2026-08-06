import { InvariantError } from "../kernel/errors.js";
import { containsSecret } from "../kernel/redact.js";
import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type { AssociationRecordsPort, ContractRecordsPort } from "./port.js";
import { CONTRACT_STATUSES } from "./types.js";

/**
 * One contract, every adapter.
 *
 * The suite is exported as data — a list of named cases, each a plain async
 * function — rather than as a block of `describe`/`it`. Three reasons, and the
 * third is the one that matters:
 *
 *   1. Nothing in the shipped build depends on a test framework.
 *   2. The vitest file for the fakes iterates the cases and wraps each in an
 *      `it`, so failures still name the case that failed.
 *   3. **The same suite can be run against a real adapter outside the test
 *      runner** — pointed at MVW's staging system from an operator command,
 *      as a conformance check before an integration is switched on. A suite
 *      that only runs under vitest cannot do that, and "the fake and the real
 *      adapter satisfy the same contract" would then be a claim rather than
 *      something anyone had checked.
 *
 * What the cases assert is deliberately about *behaviour at the boundary*
 * rather than about data: that a missing record is null and not an exception,
 * that an unknown timestamp is absent and not silently substituted, that
 * amounts are integer minor units, that windows are half-open so consecutive
 * sweeps neither skip nor double-process, and that nothing carrying owner
 * personal data crosses the boundary. Those are exactly the properties a real
 * adapter written by someone else, months from now, will get subtly wrong.
 */

export interface ContractCase<P> {
  readonly name: string;
  /** Why this property matters. Shown when the case fails. */
  readonly why: string;
  run(port: P): Promise<void>;
}

export interface ContractCaseResult {
  readonly name: string;
  readonly why: string;
  readonly passed: boolean;
  readonly error?: string | undefined;
}

/** Assertion helper. Throws rather than returning, so a case cannot pass silently. */
export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}

/** The platform's wire form for an instant. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Field names that must never cross an integration boundary.
 *
 * The rescission check needs a contract identifier and some dates. It does not
 * need who the owner is, and a field that arrives "because the API returns it"
 * ends up in the operating record, in backups, and in every subject-rights
 * request. Checked structurally rather than by review, because this is exactly
 * the kind of thing that gets added in a hurry.
 */
const FORBIDDEN_FIELD_PATTERN =
  /(first_?name|last_?name|full_?name|owner_?name|email|phone|mobile|address|street|postcode|post_?code|zip|ssn|social_?security|date_?of_?birth|dob|card|pan|iban|account_?number|routing)/i;

function assertNoPersonalData(value: unknown, path = "record"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    check(
      !containsSecret(value),
      `${path} contains something that looks like a credential, a card number, or a national identifier. Integration boundaries must not carry it.`,
    );
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPersonalData(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    check(
      !FORBIDDEN_FIELD_PATTERN.test(key),
      `${path}.${key} looks like owner personal data. This boundary carries only what the check needs.`,
    );
    assertNoPersonalData(entry, `${path}.${key}`);
  }
}

export interface ContractRecordsContractOptions {
  /** A window wide enough to contain at least one contract in the system. */
  readonly window: { readonly from: IsoTimestamp; readonly to: IsoTimestamp };
  /** An id the system definitely does not hold. */
  readonly unknownContractId: Id<"contract">;
}

/**
 * The contract-records contract.
 *
 * Every adapter — the fake, and any real one — must satisfy every case.
 */
export function contractRecordsContract(
  options: ContractRecordsContractOptions,
): readonly ContractCase<ContractRecordsPort>[] {
  const { window, unknownContractId } = options;

  async function sample(port: ContractRecordsPort) {
    const found = await port.listContractsExecutedBetween(window.from, window.to, 50);
    check(
      found.length > 0,
      `The contract suite needs at least one contract executed between ${window.from} and ${window.to}. Widen the window or point it at data that exists — a suite with nothing to check is not a passing suite.`,
    );
    return found;
  }

  return [
    {
      name: "declares its name, version, and whether the shape is confirmed",
      why: "A caller must be able to tell which dialect of the interface it has, and a reviewer must be able to see that a shape is still a guess.",
      async run(port) {
        const descriptor = port.describe();
        check(descriptor.name === port.name, "describe().name must match the port's name.");
        check(descriptor.version === port.version, "describe().version must match the port's version.");
        check(port.version === 1, "This suite covers version 1 of the contract-records port.");
        check(
          typeof descriptor.shapeConfirmedWithMvw === "boolean",
          "shapeConfirmedWithMvw must be stated, not omitted.",
        );
        check(descriptor.systemOfRecord.length > 0, "The system of record must be named.");
      },
    },
    {
      name: "reports health rather than throwing",
      why: "A dashboard needs an answer. An exception on the health path makes an unavailable integration indistinguishable from a broken one.",
      async run(port) {
        const health = await port.health();
        check(typeof health.available === "boolean", "health().available must be a boolean.");
        check(ISO_UTC.test(health.checkedAt), "health().checkedAt must be an ISO-8601 UTC instant.");
      },
    },
    {
      name: "returns null for a contract it does not have",
      why: "'No such contract' and 'we could not look' must not be the same answer: the first ends a workflow, the second must never be treated as an end.",
      async run(port) {
        const missing = await port.getContract(unknownContractId);
        check(missing === null, "An unknown contract id must produce null, not a fabricated record.");
      },
    },
    {
      name: "returns complete, well-typed records",
      why: "A rescission window computed from a malformed timestamp is a wrong deadline that looks like a right one.",
      async run(port) {
        for (const record of await sample(port)) {
          check(record.contractId.length > 0, "contractId must be present.");
          check(
            /^[A-Z]{2}$/.test(record.jurisdiction),
            `jurisdiction "${record.jurisdiction}" must be a two-letter state code; it selects which statute applies.`,
          );
          check(
            CONTRACT_STATUSES.includes(record.status),
            `status "${record.status}" is not a known contract status.`,
          );
          check(ISO_UTC.test(record.executedAt), "executedAt must be an ISO-8601 UTC instant.");
          check(
            typeof record.documentSetComplete === "boolean",
            "documentSetComplete must be stated; it changes when the period begins.",
          );
          check(typeof record.financed === "boolean", "financed must be stated.");
          check(
            record.provenance.system.length > 0 && ISO_UTC.test(record.provenance.retrievedAt),
            "Every record must carry provenance: which system answered, and when.",
          );
          check(
            record.provenance.payloadDigest.startsWith("sha256:"),
            "Provenance must carry a digest of the payload the adapter received.",
          );
        }
      },
    },
    {
      name: "leaves an unknown disclosure-delivery time absent",
      why: "Substituting the execution time for a missing delivery time invents the start of a statutory period. An absent value must stay absent so the workflow refers it to a person.",
      async run(port) {
        for (const record of await sample(port)) {
          if (record.disclosuresDeliveredAt === undefined) continue;
          check(
            ISO_UTC.test(record.disclosuresDeliveredAt),
            "disclosuresDeliveredAt, when present, must be an ISO-8601 UTC instant.",
          );
        }
      },
    },
    {
      name: "keeps missingDocuments consistent with documentSetComplete",
      why: "A complete set with missing documents listed, or an incomplete set with none, means the caller cannot trust either field.",
      async run(port) {
        for (const record of await sample(port)) {
          if (record.documentSetComplete) {
            check(
              record.missingDocuments.length === 0,
              `${record.contractId} claims a complete document set but lists ${record.missingDocuments.length} missing.`,
            );
          } else {
            check(
              record.missingDocuments.length > 0,
              `${record.contractId} claims an incomplete document set but names nothing missing, so nobody can act on it.`,
            );
          }
        }
      },
    },
    {
      name: "treats the execution window as half-open",
      why: "Consecutive sweeps must neither skip a contract nor process one twice. Both are silent, and one of them sends a second letter.",
      async run(port) {
        const found = await sample(port);
        const first = found[0];
        check(first !== undefined, "Expected at least one contract.");
        const at = first.executedAt;

        const inclusive = await port.listContractsExecutedBetween(at, window.to, 50);
        check(
          inclusive.some((record) => record.contractId === first.contractId),
          "A contract executed exactly at `from` must be included.",
        );

        const exclusive = await port.listContractsExecutedBetween(window.from, at, 50);
        check(
          !exclusive.some((record) => record.contractId === first.contractId),
          "A contract executed exactly at `to` must be excluded.",
        );
      },
    },
    {
      name: "lists oldest first",
      why: "The sweep is a work queue. Newest-first with a limit starves whatever has been waiting longest, which is the contract closest to its deadline.",
      async run(port) {
        const found = await sample(port);
        for (let index = 1; index < found.length; index += 1) {
          const previous = found[index - 1];
          const current = found[index];
          check(
            previous !== undefined && current !== undefined && previous.executedAt <= current.executedAt,
            "Contracts must be returned in ascending execution order.",
          );
        }
      },
    },
    {
      name: "respects the limit",
      why: "An adapter that ignores the limit turns a paged sweep into an unbounded read, and the caller finds out in production.",
      async run(port) {
        const limited = await port.listContractsExecutedBetween(window.from, window.to, 1);
        check(limited.length <= 1, `A limit of 1 returned ${limited.length} records.`);
      },
    },
    {
      name: "hands out records the caller cannot edit through",
      why: "A caller mutating what it was handed must not change what the next caller sees. The real store gets that for free; a fake has to earn it.",
      async run(port) {
        const found = await sample(port);
        const first = found[0];
        check(first !== undefined, "Expected at least one contract.");
        (first as { jurisdiction: string }).jurisdiction = "ZZ";
        const reread = await port.getContract(first.contractId);
        check(
          reread !== null && reread.jurisdiction !== "ZZ",
          "Mutating a returned record changed the adapter's answer.",
        );
      },
    },
    {
      name: "carries no owner personal data",
      why: "This boundary exists to compute a deadline. A name or an address crossing it lands in the operating record, the backups, and every subject-rights request, for no benefit.",
      async run(port) {
        for (const record of await sample(port)) assertNoPersonalData(record);
      },
    },
  ];
}

export interface AssociationRecordsContractOptions {
  readonly fiscalYear: number;
  /** An association id the system definitely does not hold. */
  readonly unknownAssociationId: string;
}

/** The association-records contract. */
export function associationRecordsContract(
  options: AssociationRecordsContractOptions,
): readonly ContractCase<AssociationRecordsPort>[] {
  const { fiscalYear, unknownAssociationId } = options;

  async function associations(port: AssociationRecordsPort) {
    const found = await port.listAssociations();
    check(found.length > 0, "The association suite needs at least one association to check.");
    return found;
  }

  return [
    {
      name: "declares its name, version, and whether the shape is confirmed",
      why: "Same reason as the contract-records port: a caller must know the dialect, and a reviewer must see that the shape is still a guess.",
      async run(port) {
        const descriptor = port.describe();
        check(descriptor.name === port.name, "describe().name must match the port's name.");
        check(port.version === 1, "This suite covers version 1 of the association-records port.");
        check(
          typeof descriptor.shapeConfirmedWithMvw === "boolean",
          "shapeConfirmedWithMvw must be stated, not omitted.",
        );
      },
    },
    {
      name: "reports health rather than throwing",
      why: "An operator needs an answer on a dashboard.",
      async run(port) {
        const health = await port.health();
        check(typeof health.available === "boolean", "health().available must be a boolean.");
        check(ISO_UTC.test(health.checkedAt), "health().checkedAt must be an ISO-8601 UTC instant.");
      },
    },
    {
      name: "describes associations as entities",
      why: "An association is a legal entity and a data-scope boundary. The board pack is addressed to it, and the fiscal year end determines when.",
      async run(port) {
        for (const entry of await associations(port)) {
          check(entry.associationId.length > 0, "associationId must be present.");
          check(entry.name.length > 0, "An association must be named.");
          check(
            Number.isInteger(entry.fiscalYearEndMonth) &&
              entry.fiscalYearEndMonth >= 1 &&
              entry.fiscalYearEndMonth <= 12,
            `fiscalYearEndMonth ${entry.fiscalYearEndMonth} is not a month.`,
          );
        }
      },
    },
    {
      name: "returns null for an association it does not have",
      why: "A fabricated zero budget in a board pack is a number a board would vote on.",
      async run(port) {
        const missing = await port.getBudgetSummary(unknownAssociationId, fiscalYear);
        check(missing === null, "An unknown association must produce null, not an empty budget.");
      },
    },
    {
      name: "returns amounts as non-negative integer minor units",
      why: "Board-pack figures are summed and compared. Floating point accumulates error exactly where a board member checks the arithmetic.",
      async run(port) {
        for (const entry of await associations(port)) {
          const budget = await port.getBudgetSummary(entry.associationId, fiscalYear);
          if (budget === null) continue;
          for (const [field, amount] of [
            ["totalBudgetCents", budget.totalBudgetCents],
            ["reserveBalanceCents", budget.reserveBalanceCents],
            ["reserveStudyRecommendedCents", budget.reserveStudyRecommendedCents],
            ["annualAssessmentPerIntervalCents", budget.annualAssessmentPerIntervalCents],
          ] as const) {
            check(
              Number.isInteger(amount) && amount >= 0,
              `${field} must be a non-negative integer number of cents; got ${amount}.`,
            );
          }
          check(
            /^[A-Z]{3}$/.test(budget.currency),
            `currency "${budget.currency}" must be an ISO 4217 code.`,
          );
          check(ISO_UTC.test(budget.asOf), "asOf must be an ISO-8601 UTC instant.");
          check(
            budget.provenance.payloadDigest.startsWith("sha256:"),
            "Every summary must carry provenance.",
          );
        }
      },
    },
    {
      name: "leaves an absent reserve study absent",
      why: "A board pack that compares a balance against a recommendation from no study asserts something nobody computed. Absence is a finding, not a zero.",
      async run(port) {
        for (const entry of await associations(port)) {
          const budget = await port.getBudgetSummary(entry.associationId, fiscalYear);
          if (budget === null || budget.reserveStudyDate === undefined) continue;
          check(
            ISO_DATE.test(budget.reserveStudyDate),
            "reserveStudyDate, when present, must be a civil date (YYYY-MM-DD). A study has a date, not a timestamp.",
          );
        }
      },
    },
    {
      name: "expresses delinquency in basis points when it has it",
      why: "A percentage as a float rounds differently in every renderer. Basis points are integers and compare exactly.",
      async run(port) {
        for (const entry of await associations(port)) {
          const budget = await port.getBudgetSummary(entry.associationId, fiscalYear);
          if (budget === null || budget.delinquencyBasisPoints === undefined) continue;
          check(
            Number.isInteger(budget.delinquencyBasisPoints) && budget.delinquencyBasisPoints >= 0,
            "delinquencyBasisPoints must be a non-negative integer.",
          );
        }
      },
    },
    {
      name: "hands out records the caller cannot edit through",
      why: "Same reason as the contract port: one caller's mutation must not become the next caller's answer.",
      async run(port) {
        const found = await associations(port);
        const first = found[0];
        check(first !== undefined, "Expected at least one association.");
        (first as { name: string }).name = "MUTATED";
        const reread = await port.listAssociations();
        check(
          reread.every((entry) => entry.name !== "MUTATED"),
          "Mutating a returned association changed the adapter's answer.",
        );
      },
    },
    {
      name: "carries no individual's personal data",
      why: "A board pack is about an entity's finances. Individual owners' details have no place on this boundary.",
      async run(port) {
        for (const entry of await associations(port)) {
          assertNoPersonalData(entry, "association");
          const budget = await port.getBudgetSummary(entry.associationId, fiscalYear);
          if (budget) assertNoPersonalData(budget, "budget");
        }
      },
    },
  ];
}

/**
 * Run a contract suite against one adapter.
 *
 * Every case runs even after one fails, because an adapter author needs the
 * whole list rather than the first problem — three findings in one pass is
 * three fixes, and one finding per pass is three days.
 */
export async function runContract<P>(
  cases: readonly ContractCase<P>[],
  port: P,
): Promise<readonly ContractCaseResult[]> {
  const results: ContractCaseResult[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run(port);
      results.push({ name: testCase.name, why: testCase.why, passed: true });
    } catch (error) {
      results.push({
        name: testCase.name,
        why: testCase.why,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Render results for an operator running a conformance check by hand. */
export function formatContractResults(
  adapter: string,
  results: readonly ContractCaseResult[],
): string {
  const failed = results.filter((result) => !result.passed);
  const lines = [
    failed.length === 0
      ? `${adapter}: contract SATISFIED (${results.length} cases).`
      : `${adapter}: contract NOT satisfied — ${failed.length} of ${results.length} cases failed.`,
  ];
  for (const result of failed) {
    lines.push(`  [${result.name}]`);
    lines.push(`    why : ${result.why}`);
    lines.push(`    fail: ${result.error ?? "unknown"}`);
  }
  return lines.join("\n");
}

/**
 * Throw unless every case passed.
 *
 * @throws {InvariantError} listing every failure. Used by the operator command
 *   that checks a real adapter before an integration is switched on.
 */
export function assertContractSatisfied(
  adapter: string,
  results: readonly ContractCaseResult[],
): void {
  if (results.every((result) => result.passed)) return;
  throw new InvariantError(formatContractResults(adapter, results));
}
