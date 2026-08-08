import { SWRConfig } from "swr";
import type { ReactNode } from "react";

/**
 * A private SWR cache for one test, optionally pre-filled.
 *
 * The cache SWR uses by default is a module-level singleton, so without this
 * wrapper a test would read whatever the test before it fetched, and the suite
 * would only pass in the order it happened to be written in.
 *
 * Seeded entries stand in for the server: `revalidateIfStale` is off so they
 * are not immediately re-fetched over the network. A key with no seed is still
 * fetched, since SWR always revalidates when it has nothing to show.
 */
export function SwrTestCache({
  seed,
  children,
}: {
  seed?: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(Object.entries(seed ?? {}).map(([key, data]) => [key, { data }])),
        revalidateIfStale: false,
        // A failing request is a fact the test asserts on, not something to
        // wait out; retries would only leave timers running past the test.
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}
