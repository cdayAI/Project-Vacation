import { DAY, HOUR } from "../kernel/clock.js";
import { defineWorkflow } from "../engine/definition.js";
import type { WorkflowDefinition } from "../engine/types.js";

/**
 * The rescission-packet intake — the platform's one built-in workflow.
 *
 * The engine, the definition builder, the catalogue and the handler registry
 * were all written and tested, and no non-test source ever authored a
 * `WorkflowDefinition` or reached `engine.start`. This module is the first real
 * flow: a definition literal in version control, validated at module load by
 * {@link defineWorkflow}, that an operator can start, drive, and finish.
 *
 * It is deliberately the platform's flagship domain rather than a toy. A new
 * timeshare contract arrives with a statutory rescission (cooling-off) window
 * that MVW's back office must not miss, and the volume the Q2 numbers imply is
 * the reason this platform exists. The flow is four steps that exercise the two
 * things Phase 2's exit gate turns on — a human task and a timer — around a
 * governed model call and a governed effect:
 *
 *   1. `screen_packet`   A `model_call`. Screens and extracts the intake packet
 *                        through the model gateway's `model.invoke_draft` action.
 *                        Routine: it produces a draft finding a reviewer will
 *                        see, and lands no external effect.
 *   2. `await_deadline`  A `timer`, and the one that matters. It does no date
 *                        arithmetic itself: the schedule names the context keys
 *                        the timeline module needs and asks it for the statutory
 *                        deadline, then wakes a day before that instant so the
 *                        case reaches a person while there is still time to act.
 *                        Engine-native — no handler.
 *   3. `compliance_confirm`  A `human_task`. A compliance reviewer confirms the
 *                        finding and the computed deadline before anything is
 *                        recorded. Engine-native — it parks on the reviewer's
 *                        queue with an SLA and escalations.
 *   4. `record_outcome`  An `automated_action`. Records the intake outcome and
 *                        flags the contract for review through the governed
 *                        `contract.flag_for_review` action. Reversible, so no
 *                        approval gate is required.
 *
 * Nothing here is irreversible, so the definition needs no approval gate and no
 * compensation — which is what keeps the flow driveable end to end without a
 * step-up session, while still standing on a human task and a timer.
 *
 * The timer is a *statutory* one on purpose, and it inherits the deployment's
 * `PV_REQUIRE_VERIFIED_STATUTORY_RULES` posture rather than overriding it: a
 * deployment that has not had its rule table confirmed by counsel refuses to
 * compute the deadline and the instance is denied, which is the safe direction.
 * The seeded demonstration and the drive-through below run with that switch off,
 * exactly as the rest of the demonstration does, and no date they produce may be
 * acted on.
 */

/** Handler keys the effecting steps resolve against the registry the deployment wires up. */
export const SCREEN_PACKET_HANDLER = "rescission_intake.screen";
export const RECORD_OUTCOME_HANDLER = "rescission_intake.record";

/** The workflow's dotted name, exported so the CLI can default to it. */
export const RESCISSION_INTAKE_WORKFLOW_NAME = "rescission.intake";

export const RESCISSION_INTAKE_WORKFLOW: WorkflowDefinition = defineWorkflow({
  name: RESCISSION_INTAKE_WORKFLOW_NAME,
  version: 1,
  description:
    "Intake of a new timeshare rescission packet: screen and extract it, wait out the statutory cooling-off deadline, have a compliance reviewer confirm, and record the outcome.",
  mode: "supervised",
  // A packet cannot be screened, and a deadline cannot be computed, without
  // these. Declaring them means an instance started missing one is refused up
  // front rather than halfway down the flow.
  requiredContext: ["contractId", "stateCode", "executedAt", "deliveredAt"],
  steps: [
    {
      name: "screen_packet",
      type: "model_call",
      description: "Screen and extract the rescission packet through the model gateway.",
      action: "model.invoke_draft",
      handler: SCREEN_PACKET_HANDLER,
      inputs: ["contractId", "stateCode"],
      estimatedCostUsd: 0.01,
      next: "await_deadline",
    },
    {
      name: "await_deadline",
      type: "timer",
      description: "Wait until a day before the statutory rescission deadline.",
      schedule: {
        kind: "statutory_rescission",
        stateCodeKey: "stateCode",
        executedAtKey: "executedAt",
        deliveredAtKey: "deliveredAt",
        // Wake a day early: a workflow that wakes on the deadline has already
        // missed it. Negative fires before.
        offsetMs: -1 * DAY,
        // The computed deadline, carried into the context so the reviewer and
        // the record step see the date itself rather than the fact of a timer.
        deadlineContextKey: "rescissionDeadline",
      },
      next: "compliance_confirm",
    },
    {
      name: "compliance_confirm",
      type: "human_task",
      description: "A compliance reviewer confirms the finding and the computed deadline.",
      title: "Confirm rescission intake and deadline",
      assignedRoles: ["compliance_reviewer"],
      inputs: ["rescissionDeadline"],
      sla: {
        targetMs: 8 * HOUR,
        escalations: [
          { afterMs: 0, notifyRoles: ["supervisor"], note: "Past the agreed turnaround." },
          {
            afterMs: 24 * HOUR,
            notifyRoles: ["platform_admin"],
            note: "A day past the turnaround on a statutory-deadline case.",
          },
        ],
      },
      next: "record_outcome",
    },
    {
      name: "record_outcome",
      type: "automated_action",
      description: "Record the intake outcome and flag the contract for review.",
      action: "contract.flag_for_review",
      handler: RECORD_OUTCOME_HANDLER,
      inputs: ["contractId", "rescissionDeadline"],
    },
  ],
});
