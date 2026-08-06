import type { ReactNode } from "react";
import type { Resource } from "./api/useResource";
import { Button, Callout } from "./components";
import { Denial } from "./views/Denial";

export interface ResourceViewProps<T> {
  readonly resource: Resource<T>;
  /** What the operator was trying to see, used in the refusal heading. */
  readonly attempted: string;
  readonly children: (data: T) => ReactNode;
}

/**
 * The four outcomes of a load, each rendered as itself.
 *
 * "Denied" gets its own branch rather than being folded into "error". That
 * split runs the whole way down — client, hook, and here — because the two
 * need different words, a different tone, and a different next step, and
 * because collapsing them is how a governed platform ends up looking broken
 * every time it works correctly.
 */
export function ResourceView<T>({ resource, attempted, children }: ResourceViewProps<T>) {
  const { state, reload } = resource;

  if (state.status === "loading") {
    // A polite live region rather than a spinner: an operator using a screen
    // reader is told the console is working, and nobody is shown motion that
    // carries meaning.
    return (
      <p role="status" className="pv-meta">
        Loading {attempted}…
      </p>
    );
  }

  if (state.status === "denied") {
    return <Denial denial={state.denial} attempted={attempted} />;
  }

  if (state.status === "error") {
    return (
      <Callout tone="danger" title="The console could not load this" live="polite">
        <p>{state.error.message}</p>
        <p className="pv-meta">
          This is a fault, not a refusal — the platform did not decline, the request did not
          complete. Nothing was changed. Retrying is safe.
        </p>
        <p>
          <Button variant="secondary" onClick={reload}>
            Try again
          </Button>
        </p>
      </Callout>
    );
  }

  return <>{children(state.data)}</>;
}
