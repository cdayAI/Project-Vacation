import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { GovernedIntegration } from "./execute.js";

/**
 * The connector router.
 *
 * When the platform executes on an external agent's behalf, the *action* is
 * what gets policied and receipted — not a pre-authorization the agent then
 * spends wherever it likes. That only holds if there is exactly one place the
 * outbound call can be made from, and this is it: a named registry of
 * operations, each of which declares whether it reads or writes.
 *
 * Three properties are load-bearing.
 *
 * **An unregistered operation is refused, not attempted.** There is no
 * pass-through, no "call this URL for me". An external agent can only reach
 * capabilities somebody deliberately exposed to it.
 *
 * **The declared mode is the registry's, not the caller's.** A request that
 * says `read` for an operation registered as a write is refused rather than
 * downgraded, because a read runs immediately and a write waits for a human —
 * so believing the caller about which one it is would be the whole control.
 *
 * **Enablement is read at call time.** An operator disabling a connector must
 * take effect on the next call, including the commit of an action approved
 * before the connector was switched off. Caching that answer would put a
 * window between an operator's decision and its effect, which is exactly the
 * window an incident happens in.
 */

export interface ConnectorOperation {
  readonly operation: string;
  /** `read` runs immediately; `write` is two-phase and digest-bound. */
  readonly mode: "read" | "write";
  /** What this operation does, shown to the human who approves a write. */
  readonly description: string;
  /**
   * Perform the call.
   *
   * The idempotency key is the platform's, derived from the parked action, and
   * must be passed to the downstream system wherever it supports one. A write
   * that the platform retries after an ambiguous failure is a write the agent
   * asked for once.
   */
  perform(input: {
    readonly request: Record<string, unknown>;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface Connector {
  readonly integration: string;
  readonly description: string;
  readonly operations: readonly ConnectorOperation[];
}

/** Whether a connector is switched on. Consulted on every call. */
export interface ConnectorSwitchboard {
  isEnabled(integration: string): Promise<boolean>;
}

/**
 * A switchboard held in memory.
 *
 * Adequate for a single-process deployment and for tests. A multi-process
 * deployment should back this with the operating record so that disabling a
 * connector on one worker disables it on all of them; the interface exists so
 * that swap needs no change anywhere else.
 */
export class InMemorySwitchboard implements ConnectorSwitchboard {
  private readonly disabled = new Set<string>();

  async isEnabled(integration: string): Promise<boolean> {
    return !this.disabled.has(integration);
  }

  disable(integration: string): void {
    this.disabled.add(integration);
  }

  enable(integration: string): void {
    this.disabled.delete(integration);
  }
}

export class ConnectorRouter implements GovernedIntegration {
  private readonly byIntegration = new Map<string, Map<string, ConnectorOperation>>();
  private readonly connectors: readonly Connector[];

  constructor(
    connectors: readonly Connector[],
    private readonly switchboard: ConnectorSwitchboard = new InMemorySwitchboard(),
  ) {
    for (const connector of connectors) {
      if (this.byIntegration.has(connector.integration)) {
        throw new InvalidInputError(
          `Two connectors are registered as "${connector.integration}". One name must mean one system, or an operator reading the audit log cannot tell which was called.`,
          "integration",
        );
      }
      const operations = new Map<string, ConnectorOperation>();
      for (const operation of connector.operations) {
        if (operations.has(operation.operation)) {
          throw new InvalidInputError(
            `Connector "${connector.integration}" registers "${operation.operation}" twice.`,
            "operation",
          );
        }
        operations.set(operation.operation, operation);
      }
      this.byIntegration.set(connector.integration, operations);
    }
    this.connectors = connectors;
  }

  /** What an external agent may be granted. Read by the console and the CLI. */
  describe(): readonly {
    readonly integration: string;
    readonly description: string;
    readonly operations: readonly {
      readonly operation: string;
      readonly mode: "read" | "write";
      readonly description: string;
    }[];
  }[] {
    return this.connectors.map((connector) => ({
      integration: connector.integration,
      description: connector.description,
      operations: connector.operations.map((operation) => ({
        operation: operation.operation,
        mode: operation.mode,
        description: operation.description,
      })),
    }));
  }

  async isEnabled(integration: string): Promise<boolean> {
    if (!this.byIntegration.has(integration)) return false;
    return this.switchboard.isEnabled(integration);
  }

  /** The registered mode for an operation, or null when there is no such operation. */
  modeOf(integration: string, operation: string): "read" | "write" | null {
    return this.byIntegration.get(integration)?.get(operation)?.mode ?? null;
  }

  async perform(input: {
    readonly integration: string;
    readonly operation: string;
    readonly mode: "read" | "write";
    readonly request: Record<string, unknown>;
    readonly idempotencyKey: string;
  }): Promise<unknown> {
    const operation = this.byIntegration.get(input.integration)?.get(input.operation);
    if (!operation) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `No governed operation "${input.operation}" is registered on connector "${input.integration}". The platform performs only operations somebody deliberately exposed; there is no pass-through.`,
        { integration: input.integration, operation: input.operation },
      );
    }

    // The registry decides whether this is a read or a write. A caller that
    // could declare its own mode could have a write treated as a read and run
    // it immediately, without the human decision that is the entire point of
    // the two-phase path.
    if (operation.mode !== input.mode) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `"${input.integration}.${input.operation}" is registered as a ${operation.mode}, and was called as a ${input.mode}. The registered mode decides which path an action takes, so a mismatch is refused rather than reconciled.`,
        {
          integration: input.integration,
          operation: input.operation,
          registeredMode: operation.mode,
          requestedMode: input.mode,
        },
      );
    }

    // Re-read at call time, so an operator switching a connector off reaches
    // work that is already in flight — including a commit whose approval was
    // granted before the switch.
    if (!(await this.switchboard.isEnabled(input.integration))) {
      throw new DeniedError(
        "containment.integration_revoked",
        `Connector "${input.integration}" is switched off, so the platform will not call it.`,
        { integration: input.integration },
      );
    }

    return operation.perform({ request: input.request, idempotencyKey: input.idempotencyKey });
  }
}
