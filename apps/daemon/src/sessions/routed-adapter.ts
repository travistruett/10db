import { providerOf, type Provider } from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import type { AgentAdapter } from './types';

/**
 * One adapter for the daemon over every agent: each call goes to the adapter of the agent the account
 * kind names, by `providerOf`. A new agent is one `Provider` value, one row in `providerOf`'s table and
 * one adapter here.
 */
export function createRoutedAdapter(
  adapters: Readonly<Record<Provider, AgentAdapter>>,
): AgentAdapter {
  const by = (account: Pick<AccountExpectation, 'kind'>): AgentAdapter =>
    adapters[providerOf(account.kind)];
  return {
    capabilities: (account, model) => by(account).capabilities(account, model),
    complete: (spec) => by(spec.account).complete(spec),
    open: (spec) => by(spec.account).open(spec),
    probeAccount: (probe) => by(probe).probeAccount(probe),
    startLogin: (login) => by(login).startLogin(login),
    readClientUuids: (spec) => by(spec.account).readClientUuids(spec),
  };
}
