import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type {
  HumanTask,
  HumanTaskFilter,
  HumanTaskPatch,
  InstanceFilter,
  WorkflowInstance,
} from "./types.js";

/**
 * Persistence port for the workflow engine.
 *
 * The stated exit gate for this module is that a deploy in the middle of a case
 * does not lose the case. That reduces to one requirement on this interface:
 * every state transition is written here before the engine does anything else,
 * and nothing an engine holds in memory is needed to continue. A new engine
 * over the same store must be able to pick up any instance from its row alone.
 *
 * Two operations carry requirements a caller cannot meet with a read followed
 * by a write.
 *
 * `saveInstance` is a compare-and-swap on `revision`, and it is the engine's
 * mutual exclusion. Before a step runs, the engine claims its token by saving
 * the instance with the token marked running; a second engine's claim then
 * fails the swap and it walks away. Without that, two sweeps on the same
 * instance would each read "ready", each authorise, and each perform the effect
 * — and the idempotency key would only catch it after both had already acted.
 * The swap must therefore be atomic in the store, not advisory.
 *
 * `dueInstances` is the sweep's query. It must return instances that have work
 * to do *now*: a ready token, or a timer or retry whose wake time has arrived.
 * It must not return instances whose only tokens are parked on a human, an
 * approval, or an event, because those are woken by the thing they are waiting
 * for rather than by the clock.
 *
 * As everywhere else in this platform, a read that cannot be served raises
 * rather than returning an empty result. "No instance is waiting" and "we
 * cannot tell what is waiting" lead to opposite actions.
 */
export interface WorkflowStore {
  createInstance(instance: WorkflowInstance): Promise<WorkflowInstance>;
  getInstance(id: Id<"workflowInstance">): Promise<WorkflowInstance | null>;
  /** @throws {DeniedError} `record.unavailable` when the instance is absent. */
  requireInstance(id: Id<"workflowInstance">): Promise<WorkflowInstance>;

  /**
   * Compare-and-swap the instance.
   *
   * @param expectedRevision the revision the caller read.
   * @returns the stored instance with `revision` advanced, or `null` when
   *   another writer moved first. Returning null rather than throwing is
   *   deliberate: losing a race is ordinary in a sweep, and an exception would
   *   make the ordinary case look like a failure in every log.
   */
  saveInstance(
    next: WorkflowInstance,
    expectedRevision: number,
  ): Promise<WorkflowInstance | null>;

  listInstances(filter?: InstanceFilter): Promise<readonly WorkflowInstance[]>;
  countInstances(filter?: InstanceFilter): Promise<number>;

  /** Instances with a ready token, or a wake time at or before `at`. */
  dueInstances(at: IsoTimestamp, limit?: number): Promise<readonly WorkflowInstance[]>;

  createHumanTask(task: HumanTask): Promise<HumanTask>;
  getHumanTask(id: Id<"step">): Promise<HumanTask | null>;
  patchHumanTask(id: Id<"step">, patch: HumanTaskPatch): Promise<HumanTask>;
  listHumanTasks(filter?: HumanTaskFilter): Promise<readonly HumanTask[]>;
}
