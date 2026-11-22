import type { Provider } from '@10db/contracts';
import type { AgentAdapter } from './types';

/**
 * One adapter for the daemon over every agent: each call goes to the adapter of the harness the account
 * runs (`harnessOf`). A new agent is one `Provider` value, one row in `HARNESSES_OF_KIND` and one adapter here.
 */
export function createRoutedAdapter(
  adapters: Readonly<Record<Provider, AgentAdapter>>,
): AgentAdapter {
  const by = (account: { readonly harness: Provider }): AgentAdapter => adapters[account.harness];
  return {
    capabilities: (account, model) => by(account).capabilities(account, model),
    complete: (spec) => by(spec.account).complete(spec),
    open: (spec) => by(spec.account).open(spec),
    probeAccount: (probe) => by(probe).probeAccount(probe),
    startLogin: (login) => by(login).startLogin(login),
    startMcpSignIn: (spec) => by(spec).startMcpSignIn(spec),
    mcpAuthStatus: (spec) => by(spec).mcpAuthStatus(spec),
    takeoverCommand: (spec) => by(spec).takeoverCommand(spec),
    takeoverNotes: (account) => by(account).takeoverNotes(account),
    readClientUuids: (spec) => by(spec.account).readClientUuids(spec),
    stop: async () => {
      await Promise.all(
        Object.values(adapters).map((adapter) => adapter.stop?.() ?? Promise.resolve()),
      );
    },
  };
}
