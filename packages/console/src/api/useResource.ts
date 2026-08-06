import { useCallback, useEffect, useState } from "react";
import { ApiError, isDenial, type Outcome } from "./client";
import type { DenialView } from "./contract";

/**
 * Data loading, as small as it can be while still telling the truth about what
 * came back.
 *
 * Four states, not three. "Denied" is separated from "error" all the way up
 * from the client, because the two want different screens: a refusal is an
 * outcome with a reason and a next step, a fault is something broken. Merging
 * them here would put a denial behind an error page, which is the exact
 * mistake this platform is built to avoid.
 */
export type ResourceState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "denied"; readonly denial: DenialView }
  | { readonly status: "error"; readonly error: ApiError | Error };

export interface Resource<T> {
  readonly state: ResourceState<T>;
  /** Re-runs the loader. Reads are never retried automatically; this is the operator's call. */
  readonly reload: () => void;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<Outcome<T>>,
  dependencies: readonly unknown[],
): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setState({ status: "loading" });

    load(controller.signal)
      .then((outcome) => {
        if (cancelled) return;
        if (isDenial(outcome)) setState({ status: "denied", denial: outcome });
        else setState({ status: "ready", data: outcome });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setState({
          status: "error",
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // The loader is intentionally not a dependency: callers write it inline,
    // and a new function identity on every render would loop forever. The
    // dependency array the caller passes is the contract, and its length must
    // be constant at a given call site — the same rule React itself imposes.
  }, [...dependencies, reloadCount]);

  return { state, reload };
}
