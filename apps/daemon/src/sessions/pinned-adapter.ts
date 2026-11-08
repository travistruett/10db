import { createUnavailableAdapter } from './unavailable-adapter';
import type { SessionAdapter } from './types';

/** Where an agent CLI stands now: a path to run, or the reason no session can start on it. */
export type AdapterSource =
  | { readonly ready: true; readonly path: string }
  | { readonly ready: false; readonly message: string };

/**
 * An adapter that asks `source` on every call, so a copy still being fetched ends sessions with its
 * reason and the same adapter works once the copy is ready. A copy that is refused never runs.
 */
export function createPinnedAdapter(
  source: () => AdapterSource,
  build: (path: string) => SessionAdapter,
): SessionAdapter {
  let built: { readonly path: string; readonly adapter: SessionAdapter } | null = null;
  const current = (): SessionAdapter => {
    const now = source();
    if (!now.ready) return createUnavailableAdapter(now.message);
    if (built?.path !== now.path) built = { path: now.path, adapter: build(now.path) };
    return built.adapter;
  };
  return {
    complete: (spec) => current().complete(spec),
    start: (spec) => current().start(spec),
    startShape: (spec) => current().startShape(spec),
    probeAccount: (probe) => current().probeAccount(probe),
    startLogin: (login) => current().startLogin(login),
  };
}
