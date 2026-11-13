import { createUnavailableAdapter } from './unavailable-adapter';
import type { AgentAdapter } from './types';

/** Where an agent CLI stands now: a path to run, or the reason no session can start on it. */
export type AdapterSource =
  | { readonly ready: true; readonly path: string }
  | { readonly ready: false; readonly message: string };

/**
 * An adapter that asks `source` on every call, so a copy still being fetched ends sessions with its
 * reason and the same adapter works once the copy is ready. A copy that is refused never runs. It
 * reports `capabilities` all the while, since what its agent can do doesn't depend on the copy.
 */
export function createPinnedAdapter(
  source: () => AdapterSource,
  build: (path: string) => AgentAdapter,
  capabilities: AgentAdapter['capabilities'],
): AgentAdapter {
  let built: { readonly path: string; readonly adapter: AgentAdapter } | null = null;
  const current = (): AgentAdapter => {
    const now = source();
    if (!now.ready) return createUnavailableAdapter(now.message, capabilities);
    if (built?.path !== now.path) built = { path: now.path, adapter: build(now.path) };
    return built.adapter;
  };
  return {
    capabilities: (account, model) => capabilities(account, model),
    complete: (spec) => current().complete(spec),
    open: (spec) => current().open(spec),
    probeAccount: (probe) => current().probeAccount(probe),
    startLogin: (login) => current().startLogin(login),
    readClientUuids: (spec) => current().readClientUuids(spec),
  };
}
