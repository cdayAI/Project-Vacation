import { createContext, useContext, type ReactNode } from "react";
import type { ConsoleClient } from "./client";

/**
 * The client is supplied through context so that every view can be rendered in
 * a test against a hand-written fake without a network stack, and so that
 * nothing in views/ constructs its own transport.
 */
const ClientContext = createContext<ConsoleClient | null>(null);

export function ClientProvider({
  client,
  children,
}: {
  readonly client: ConsoleClient;
  readonly children: ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): ConsoleClient {
  const client = useContext(ClientContext);
  if (client === null) {
    throw new Error("useClient was called outside ClientProvider.");
  }
  return client;
}
