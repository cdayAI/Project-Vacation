import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { AuditLog } from "../audit/log.js";
import { decision } from "../audit/log.js";
import type { ContainmentStore } from "./port.js";
import type { ContainmentScope, ContainmentSwitch } from "./types.js";

/**
 * Containment controls.
 *
 * Four switches — global pause, per-workflow, per-role, per-integration — each
 * reachable by an operator in seconds without a deploy.
 *
 * The important design decision is *where* they are checked. A switch checked
 * only when a run starts would let a long-running instance outrun the stop
 * button: an operator hits pause, the console shows "paused", and a workflow
 * that started ten minutes ago keeps taking steps. So containment is checked
 * inside the authorization chokepoint, which every action passes through, and
 * the workflow engine re-checks before each step. Engaging a switch therefore
 * stops in-flight work at its next action boundary rather than only preventing
 * new work.
 *
 * There is one deliberate exception: compensation steps. If a workflow is
 * stopped halfway through an irreversible sequence, refusing to run the
 * compensating action would leave the world in the broken half-state the
 * compensation exists to repair. Compensation is allowed to proceed, and the
 * fact that it ran under containment is recorded.
 */
export class ContainmentController {
  /**
   * Short-lived cache of switch state.
   *
   * Containment is consulted on every action, and hitting the database each
   * time would put the stop button on the hot path of everything. The window
   * is deliberately tiny: an operator expects a pause to take effect in
   * seconds, and this bounds that at `cacheTtlMs`.
   */
  private readonly cache = new Map<string, { value: ContainmentSwitch | null; readAt: number }>();

  constructor(
    private readonly store: ContainmentStore,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly cacheTtlMs = 1000,
  ) {}

  private key(scope: ContainmentScope, target: string): string {
    return `${scope}:${target}`;
  }

  private async read(scope: ContainmentScope, target: string): Promise<ContainmentSwitch | null> {
    const key = this.key(scope, target);
    const cached = this.cache.get(key);
    const now = this.clock.now();
    if (cached && now - cached.readAt < this.cacheTtlMs) return cached.value;

    // A store that cannot answer must not read as "not engaged". Fail closed:
    // if we cannot tell whether the platform is paused, we behave as if it is.
    let value: ContainmentSwitch | null;
    try {
      value = await this.store.getSwitch(scope, target);
    } catch (error) {
      throw new DeniedError(
        "containment.global_pause",
        `Containment state for ${scope}:${target} could not be read, so the action was refused: ${error instanceof Error ? error.message : String(error)}`,
        { scope, target },
      );
    }
    this.cache.set(key, { value, readAt: now });
    return value;
  }

  async isEngaged(scope: ContainmentScope, target = ""): Promise<boolean> {
    const found = await this.read(scope, target);
    return found?.engaged === true;
  }

  /**
   * Refuse the action if any applicable switch is engaged.
   *
   * Checked most-general first, so an operator who hits the global pause gets
   * a global-pause denial rather than an incidental per-role one.
   */
  async assertClear(context: {
    readonly workflowName?: string | undefined;
    readonly roleId?: string | undefined;
    readonly integration?: string | undefined;
    /** Compensation is permitted to run under containment. See class comment. */
    readonly isCompensation?: boolean | undefined;
  }): Promise<void> {
    if (context.isCompensation) return;

    if (await this.isEngaged("global", "")) {
      throw new DeniedError(
        "containment.global_pause",
        "The platform is globally paused. No action will be taken until an operator releases the pause.",
        {},
      );
    }
    if (context.workflowName && (await this.isEngaged("workflow", context.workflowName))) {
      throw new DeniedError(
        "containment.workflow_disabled",
        `Workflow "${context.workflowName}" is disabled.`,
        { workflow: context.workflowName },
      );
    }
    if (context.roleId && (await this.isEngaged("role", context.roleId))) {
      throw new DeniedError("containment.role_disabled", `Role "${context.roleId}" is disabled.`, {
        roleId: context.roleId,
      });
    }
    if (context.integration && (await this.isEngaged("integration", context.integration))) {
      throw new DeniedError(
        "containment.integration_revoked",
        `Integration "${context.integration}" is revoked.`,
        { integration: context.integration },
      );
    }
  }

  /** Engage a switch. Takes effect within `cacheTtlMs` across the process. */
  async engage(
    scope: ContainmentScope,
    target: string,
    actorId: string,
    reason: string,
  ): Promise<ContainmentSwitch> {
    const next = await this.store.setSwitch({
      scope,
      target,
      engaged: true,
      engagedBy: actorId,
      engagedAt: this.clock.nowIso(),
      reason,
    });
    this.cache.delete(this.key(scope, target));
    await this.audit.record(
      decision({
        eventType: "containment.engaged",
        actorId,
        actorKind: "human",
        subject: { scope, target },
        decision: { engaged: true, reason },
      }),
    );
    return next;
  }

  async release(
    scope: ContainmentScope,
    target: string,
    actorId: string,
    reason: string,
  ): Promise<ContainmentSwitch> {
    const next = await this.store.setSwitch({
      scope,
      target,
      engaged: false,
      engagedBy: actorId,
      engagedAt: this.clock.nowIso(),
      reason,
    });
    this.cache.delete(this.key(scope, target));
    await this.audit.record(
      decision({
        eventType: "containment.released",
        actorId,
        actorKind: "human",
        subject: { scope, target },
        decision: { engaged: false, reason },
      }),
    );
    return next;
  }

  list(): Promise<readonly ContainmentSwitch[]> {
    return this.store.listSwitches();
  }

  /** Drop the cache. Used by tests and by the operator CLI after a change. */
  invalidate(): void {
    this.cache.clear();
  }
}
