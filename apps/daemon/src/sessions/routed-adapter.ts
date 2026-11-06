import { providerOf, Provider } from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import type { SessionAdapter } from './types';

/**
 * One adapter for the daemon over the two agents: every call goes to the agent of the account kind
 * it names. A new kind picks its agent in `providerOf`.
 */
export function createRoutedAdapter(adapters: {
  readonly claude: SessionAdapter;
  readonly codex: SessionAdapter;
}): SessionAdapter {
  const by = (account: Pick<AccountExpectation, 'kind'>): SessionAdapter =>
    providerOf(account.kind) === Provider.Codex ? adapters.codex : adapters.claude;
  return {
    complete: (spec) => by(spec.account).complete(spec),
    start: (spec) => by(spec.account).start(spec),
    startShape: (spec) => by(spec.account).startShape(spec),
    probeAccount: (probe) => by(probe).probeAccount(probe),
  };
}
