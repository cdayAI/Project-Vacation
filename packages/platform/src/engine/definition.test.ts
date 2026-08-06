import { describe, it, expect } from "vitest";
import { InvalidInputError, isDenied } from "../kernel/errors.js";
import {
  WorkflowCatalogue,
  assertValidDefinition,
  defineWorkflow,
  definitionDigest,
  validateDefinition,
} from "./definition.js";
import type { WorkflowDefinition, WorkflowStep } from "./types.js";

/**
 * Definition validation.
 *
 * These tests are the specification of what a reviewable workflow is. Each one
 * corresponds to a way a definition can look correct and behave wrongly, and
 * the reason they live at load time rather than at run time is that every one
 * of them would otherwise be discovered by a case that was already half done.
 */

function step(overrides: Partial<WorkflowStep> & { name: string }): WorkflowStep {
  return {
    type: "automated_action",
    description: `step ${overrides.name}`,
    action: "test.do_thing",
    handler: "noop",
    ...overrides,
  } as WorkflowStep;
}

function definition(steps: readonly WorkflowStep[], overrides: Partial<WorkflowDefinition> = {}) {
  return {
    name: "test.workflow",
    version: 1,
    description: "A workflow used by the validator tests.",
    mode: "supervised" as const,
    steps,
    ...overrides,
  };
}

function codes(candidate: unknown): readonly string[] {
  return validateDefinition(candidate).map((problem) => problem.code);
}

describe("definition schema", () => {
  it("accepts a well-formed linear workflow", () => {
    const parsed = defineWorkflow(
      definition([step({ name: "first", next: "second" }), step({ name: "second" })]),
    );
    expect(parsed.steps).toHaveLength(2);
    expect(validateDefinition(parsed)).toEqual([]);
  });

  it("refuses a workflow name that is not dotted lower_snake_case", () => {
    expect(codes(definition([step({ name: "only" })], { name: "TestWorkflow" }))).toContain(
      "schema_invalid",
    );
  });

  it("refuses a version that is not a positive integer", () => {
    expect(codes(definition([step({ name: "only" })], { version: 0 }))).toContain("schema_invalid");
    expect(codes(definition([step({ name: "only" })], { version: 1.5 }))).toContain(
      "schema_invalid",
    );
  });

  it("refuses an unrecognised field, so a typo is a failure rather than a silent no-op", () => {
    const candidate = definition([
      { ...step({ name: "only" }), nextStep: "somewhere" } as unknown as WorkflowStep,
    ]);
    expect(codes(candidate)).toContain("schema_invalid");
  });

  it("requires a branch to declare where an unmatched case goes", () => {
    const candidate = definition([
      {
        name: "route",
        type: "branch",
        description: "route the case",
        cases: [{ label: "inside window", when: { key: "inside", op: "eq", value: true }, next: "a" }],
      } as unknown as WorkflowStep,
      step({ name: "a" }),
    ]);
    expect(codes(candidate)).toContain("schema_invalid");
  });

  it("requires an effecting step to name an action and a handler", () => {
    const candidate = definition([
      { name: "only", type: "automated_action", description: "do it" } as unknown as WorkflowStep,
    ]);
    expect(codes(candidate)).toContain("schema_invalid");
  });
});

describe("step references and reachability", () => {
  it("refuses a step that points at a step which does not exist", () => {
    expect(codes(definition([step({ name: "first", next: "nowhere" })]))).toEqual([
      "unknown_step_reference",
    ]);
  });

  it("refuses two steps with the same name", () => {
    expect(
      codes(definition([step({ name: "same", next: "same" }), step({ name: "same" })])),
    ).toContain("duplicate_step_name");
  });

  it("refuses a step nothing can reach", () => {
    const problems = validateDefinition(
      definition([step({ name: "first" }), step({ name: "orphan" })]),
    );
    expect(problems.map((problem) => problem.code)).toEqual(["unreachable_step"]);
    expect(problems[0]?.stepName).toBe("orphan");
  });

  it("refuses a loop, because a workflow that revisits a step can run forever", () => {
    const problems = validateDefinition(
      definition([step({ name: "first", next: "second" }), step({ name: "second", next: "first" })]),
    );
    expect(problems.map((problem) => problem.code)).toEqual(["cycle_detected"]);
    expect(problems[0]?.message).toMatch(/bounded retry/);
  });

  it("names the offending step, so the message is actionable without reading the validator", () => {
    const problems = validateDefinition(definition([step({ name: "first", next: "typo" })]));
    expect(problems[0]?.stepName).toBe("first");
    expect(problems[0]?.message).toContain("typo");
  });
});

describe("irreversible steps", () => {
  const gate = (name: string, gates: string, next: string): WorkflowStep => ({
    name,
    type: "approval_gate",
    description: `approve ${gates}`,
    gates,
    approverRoles: ["supervisor"],
    summary: `Approve ${gates}.`,
    next,
  });

  it("accepts an irreversible step with a gate that names it", () => {
    const parsed = defineWorkflow(
      definition([
        gate("approve", "send", "send"),
        step({ name: "send", irreversible: true, action: "test.send_letter" }),
      ]),
    );
    expect(validateDefinition(parsed)).toEqual([]);
  });

  it("refuses an irreversible step with no approval gate before it", () => {
    const problems = validateDefinition(
      definition([step({ name: "send", irreversible: true, action: "test.send_letter" })]),
    );
    expect(problems.map((problem) => problem.code)).toContain(
      "irreversible_without_approval_gate",
    );
  });

  it("refuses an irreversible step whose gate does not name it", () => {
    const problems = validateDefinition(
      definition([
        gate("approve", "other", "send"),
        step({ name: "send", irreversible: true, action: "test.send_letter", next: "other" }),
        step({ name: "other" }),
      ]),
    );
    // The gate exists on the path, but it authorises a different step, so the
    // approval would never be bound to the irreversible proposal.
    expect(problems.map((problem) => problem.code)).toContain(
      "irreversible_without_approval_gate",
    );
  });

  it("refuses an irreversible step reachable by one gated path and one ungated one", () => {
    const problems = validateDefinition(
      definition([
        {
          name: "route",
          type: "branch",
          description: "route the case",
          cases: [{ label: "urgent", when: { key: "urgent", op: "eq", value: true }, next: "send" }],
          otherwise: "approve",
        } as WorkflowStep,
        gate("approve", "send", "send"),
        step({ name: "send", irreversible: true, action: "test.send_letter" }),
      ]),
    );
    expect(problems.map((problem) => problem.code)).toContain(
      "irreversible_without_approval_gate",
    );
  });

  it("accepts an irreversible step when every path to it passes the gate", () => {
    const parsed = defineWorkflow(
      definition([
        {
          name: "route",
          type: "branch",
          description: "route the case",
          cases: [
            { label: "urgent", when: { key: "urgent", op: "eq", value: true }, next: "approve" },
          ],
          otherwise: "approve",
        } as WorkflowStep,
        gate("approve", "send", "send"),
        step({ name: "send", irreversible: true, action: "test.send_letter" }),
      ]),
    );
    expect(validateDefinition(parsed)).toEqual([]);
  });

  it("refuses a reversible step after an irreversible one that declares no compensation", () => {
    const problems = validateDefinition(
      definition([
        gate("approve", "send", "send"),
        step({ name: "send", irreversible: true, action: "test.send_letter", next: "close" }),
        step({ name: "close", action: "test.close_case" }),
      ]),
    );
    expect(problems.map((problem) => problem.code)).toEqual([
      "irreversible_without_downstream_compensation",
    ]);
    expect(problems[0]?.stepName).toBe("close");
  });

  it("accepts it once the downstream step declares how to undo itself", () => {
    const parsed = defineWorkflow(
      definition([
        gate("approve", "send", "send"),
        step({ name: "send", irreversible: true, action: "test.send_letter", next: "close" }),
        step({ name: "close", action: "test.close_case", compensation: "reopen" }),
        {
          name: "reopen",
          type: "compensation",
          description: "reopen the case",
          action: "test.reopen_case",
          handler: "noop",
        } as WorkflowStep,
      ]),
    );
    expect(validateDefinition(parsed)).toEqual([]);
  });

  it("does not demand a compensating action for a model call", () => {
    // A model call spends money and produces text. There is no external effect
    // to reverse, and requiring a no-op compensation would teach authors to
    // write no-op compensations.
    const parsed = defineWorkflow(
      definition([
        {
          name: "approve",
          type: "approval_gate",
          description: "approve the letter",
          gates: "send",
          approverRoles: ["supervisor"],
          summary: "Approve the letter.",
          next: "send",
        } as WorkflowStep,
        step({ name: "send", irreversible: true, action: "test.send_letter", next: "summarise" }),
        {
          name: "summarise",
          type: "model_call",
          description: "summarise what was sent",
          action: "test.draft",
          handler: "noop",
        } as WorkflowStep,
      ]),
    );
    expect(validateDefinition(parsed)).toEqual([]);
  });
});

describe("compensation steps", () => {
  const compensation = (name: string): WorkflowStep =>
    ({
      name,
      type: "compensation",
      description: `undo ${name}`,
      action: "test.undo",
      handler: "noop",
    }) as WorkflowStep;

  it("refuses a compensation step nothing names", () => {
    expect(codes(definition([step({ name: "first" }), compensation("undo")]))).toContain(
      "compensation_not_referenced",
    );
  });

  it("refuses a compensation step named by two different steps", () => {
    const problems = validateDefinition(
      definition([
        step({ name: "first", compensation: "undo", next: "second" }),
        step({ name: "second", compensation: "undo" }),
        compensation("undo"),
      ]),
    );
    expect(problems.map((problem) => problem.code)).toContain("compensation_not_referenced");
  });

  it("refuses a compensation step reachable from the forward path", () => {
    const problems = validateDefinition(
      definition([step({ name: "first", compensation: "undo", next: "undo" }), compensation("undo")]),
    );
    expect(problems.map((problem) => problem.code)).toContain("compensation_in_forward_path");
  });

  it("refuses a compensation step that continues to another step", () => {
    const problems = validateDefinition(
      definition([
        step({ name: "first", compensation: "undo" }),
        { ...compensation("undo"), next: "first" } as WorkflowStep,
      ]),
    );
    expect(problems.map((problem) => problem.code)).toContain("compensation_in_forward_path");
  });

  it("refuses naming an ordinary step as a compensating action", () => {
    const problems = validateDefinition(
      definition([step({ name: "first", compensation: "second" }), step({ name: "second" })]),
    );
    expect(problems.map((problem) => problem.code)).toContain("compensation_target_wrong_type");
  });
});

describe("parallel fan-out", () => {
  it("accepts branches that stay separate and join at the declared step", () => {
    const parsed = defineWorkflow(
      definition([
        {
          name: "fan",
          type: "parallel",
          description: "check two things at once",
          branches: ["left", "right"],
          next: "join",
        } as WorkflowStep,
        step({ name: "left" }),
        step({ name: "right" }),
        step({ name: "join" }),
      ]),
    );
    expect(validateDefinition(parsed)).toEqual([]);
  });

  it("accepts a fan-out nested inside another one", () => {
    // Both inner branches reach the outer join, and that is not an overlap:
    // everything past a join runs once, after every branch has finished. A
    // check that did not bound each branch at its own join would report this
    // correct definition as broken.
    const parsed = defineWorkflow(
      definition([
        {
          name: "outer",
          type: "parallel",
          description: "two workstreams",
          branches: ["left", "inner"],
          next: "combine",
        } as WorkflowStep,
        step({ name: "left" }),
        {
          name: "inner",
          type: "parallel",
          description: "two checks inside the second workstream",
          branches: ["inner_a", "inner_b"],
          next: "inner_join",
        } as WorkflowStep,
        step({ name: "inner_a" }),
        step({ name: "inner_b" }),
        step({ name: "inner_join" }),
        step({ name: "combine" }),
      ]),
    );
    expect(validateDefinition(parsed)).toEqual([]);
  });

  it("refuses branches that share a step, because it would run twice", () => {
    const problems = validateDefinition(
      definition([
        {
          name: "fan",
          type: "parallel",
          description: "check two things at once",
          branches: ["left", "right"],
          next: "join",
        } as WorkflowStep,
        step({ name: "left", next: "shared" }),
        step({ name: "right", next: "shared" }),
        step({ name: "shared" }),
        step({ name: "join" }),
      ]),
    );
    expect(problems.map((problem) => problem.code)).toContain("parallel_branches_overlap");
  });

  it("refuses a branch step that points straight at the join, skipping the barrier", () => {
    const problems = validateDefinition(
      definition([
        {
          name: "fan",
          type: "parallel",
          description: "check two things at once",
          branches: ["left", "right"],
          next: "join",
        } as WorkflowStep,
        step({ name: "left", next: "join" }),
        step({ name: "right" }),
        step({ name: "join" }),
      ]),
    );
    expect(problems.map((problem) => problem.code)).toContain("parallel_branch_reaches_join");
  });

  it("requires at least two branches, since one is not a fan-out", () => {
    const problems = validateDefinition(
      definition([
        {
          name: "fan",
          type: "parallel",
          description: "not really parallel",
          branches: ["left"],
          next: "join",
        } as WorkflowStep,
        step({ name: "left" }),
        step({ name: "join" }),
      ]),
    );
    expect(problems.map((problem) => problem.code)).toContain("schema_invalid");
  });
});

describe("service levels", () => {
  it("refuses escalation rules that are not strictly increasing", () => {
    const problems = validateDefinition(
      definition([
        {
          name: "review",
          type: "human_task",
          description: "review the case",
          title: "Review the case",
          assignedRoles: ["supervisor"],
          sla: {
            targetMs: 3_600_000,
            escalations: [
              { afterMs: 3_600_000, notifyRoles: ["supervisor"], note: "chase" },
              { afterMs: 1_800_000, notifyRoles: ["compliance_reviewer"], note: "escalate" },
            ],
          },
        } as WorkflowStep,
      ]),
    );
    expect(problems.map((problem) => problem.code)).toContain("escalation_out_of_order");
  });
});

describe("assertValidDefinition", () => {
  it("reports every problem at once rather than the first", () => {
    let caught: unknown;
    try {
      assertValidDefinition(
        definition([step({ name: "first" }), step({ name: "orphan" }), step({ name: "other" })]),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidInputError);
    const message = (caught as InvalidInputError).message;
    expect(message).toContain("orphan");
    expect(message).toContain("other");
  });
});

describe("the catalogue", () => {
  const v1 = defineWorkflow(
    definition([step({ name: "first", next: "second" }), step({ name: "second" })]),
  );

  it("returns the exact version asked for, not the newest", () => {
    const catalogue = new WorkflowCatalogue([v1]);
    const v2 = defineWorkflow(definition([step({ name: "first" })], { version: 2 }));
    catalogue.publish(v2);

    expect(catalogue.require("test.workflow", 1).steps).toHaveLength(2);
    expect(catalogue.require("test.workflow", 2).steps).toHaveLength(1);
    expect(catalogue.latest("test.workflow").version).toBe(2);
    expect(catalogue.versionsOf("test.workflow")).toEqual([1, 2]);
  });

  it("refuses to republish a version with different content", () => {
    const catalogue = new WorkflowCatalogue([v1]);
    const changed = defineWorkflow(definition([step({ name: "first" })]));
    expect(() => catalogue.publish(changed)).toThrow(InvalidInputError);
    expect(() => catalogue.publish(changed)).toThrow(/immutable/);
  });

  it("accepts republishing identical content, so a restart is not an error", () => {
    const catalogue = new WorkflowCatalogue([v1]);
    expect(() => catalogue.publish(v1)).not.toThrow();
    expect(catalogue.versionsOf("test.workflow")).toEqual([1]);
  });

  it("refuses a version it does not hold, rather than substituting another", () => {
    const catalogue = new WorkflowCatalogue([v1]);
    let caught: unknown;
    try {
      catalogue.require("test.workflow", 7);
    } catch (error) {
      caught = error;
    }
    expect(isDenied(caught)).toBe(true);
    expect((caught as Error).message).toContain("it has 1");
  });

  it("refuses an unknown workflow", () => {
    const catalogue = new WorkflowCatalogue([v1]);
    expect(() => catalogue.latest("test.absent")).toThrow(/not in this deployment's catalogue/);
  });

  it("validates on publish, so a broken definition never becomes live", () => {
    const catalogue = new WorkflowCatalogue();
    expect(() =>
      catalogue.publish(definition([step({ name: "first", next: "nowhere" })]) as WorkflowDefinition),
    ).toThrow(InvalidInputError);
  });
});

describe("definitionDigest", () => {
  it("changes when a step changes", () => {
    const before = definition([step({ name: "first", next: "second" }), step({ name: "second" })]);
    const after = definition([
      step({ name: "first", next: "second" }),
      step({ name: "second", action: "test.other" }),
    ]);
    expect(definitionDigest(before as WorkflowDefinition)).not.toBe(
      definitionDigest(after as WorkflowDefinition),
    );
  });

  it("ignores the prose, so fixing a typo does not invalidate every case in flight", () => {
    const before = definition([step({ name: "only" })]);
    const after = definition([step({ name: "only" })], {
      description: "The same workflow, described better.",
    });
    expect(definitionDigest(before as WorkflowDefinition)).toBe(
      definitionDigest(after as WorkflowDefinition),
    );
  });
});
