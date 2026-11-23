import {
  AccountKind,
  LinearVia,
  McpSignInState,
  harnessOf,
  Provider,
  type AccountId,
  type SupportedAccountKind,
  type LinearSignInRowDto,
  type LinearSignInsDto,
} from '@10db/contracts';
import { listAccounts } from '@10db/db';
import type { McpSignIns } from '../accounts';
import type { StateStore } from '../events';
import type { YourMcpPlan } from '../session-setup';

const LINEAR_HOST = 'mcp.linear.app';

/** A row the Connect Linear button settles has no note; only a row 10db can't read says why. */
const NOT_CHECKED = 'Your Linear sign-in is checked when the agent first uses it.';
const NOT_READ = "Couldn't read this account's claude.ai connectors.";

/** Whether a remote server's url is Linear's own host. */
export function isLinearServer(url: string): boolean {
  try {
    return new URL(url).host === LINEAR_HOST;
  } catch {
    return false;
  }
}

/**
 * How each agent account reaches Linear, from reads that already exist: the claude.ai connectors a plan
 * session last read, the builder's configured servers whose host is `mcp.linear.app`, and a Codex account's
 * sign-in to one. It never starts a connector probe.
 */
export function createLinearSignIns(deps: {
  readonly state: StateStore;
  readonly plan: () => YourMcpPlan;
  readonly mcpSignIns: Pick<McpSignIns, 'list'>;
  /** The connector names an account last read: undefined when never read, null when the read failed. */
  readonly connectorNames: (account: {
    readonly id: AccountId;
    readonly kind: SupportedAccountKind;
    readonly harness: Provider;
  }) => readonly string[] | null | undefined;
}): { list(): Promise<LinearSignInsDto> } {
  return {
    async list() {
      const servers = Object.entries(deps.plan().remote)
        .filter(([, remote]) => isLinearServer(remote.url))
        .map(([name]) => name);
      const accounts = listAccounts(deps.state.db).flatMap((account) => {
        const harness = harnessOf(account);
        return harness === null ? [] : [{ ...account, harness }];
      });
      const codexRows =
        servers.length > 0 && accounts.some((a) => a.harness === Provider.Codex)
          ? (await deps.mcpSignIns.list()).rows
          : [];
      const rows = accounts.map((account): LinearSignInRowDto => {
        const base = {
          accountId: account.id,
          accountLabel: account.label,
          unchecked: false,
          serverKey: null,
        };
        if (account.harness === Provider.Codex) {
          const own = codexRows.filter(
            (r) => r.accountId === account.id && servers.includes(r.name),
          );
          // With no Linear server configured or approved, there is nothing to sign in to yet.
          if (own.length === 0)
            return { ...base, via: LinearVia.None, signedIn: null, note: null, serverKey: null };
          return {
            ...base,
            via: LinearVia.Server,
            signedIn: own.some((r) => r.state === McpSignInState.SignedIn),
            note: null,
            serverKey: own[0]?.key ?? null,
          };
        }
        if (account.kind === AccountKind.ClaudeSubscription) {
          const names = deps.connectorNames(account);
          if (names?.some((name) => /linear/i.test(name)) === true)
            return { ...base, via: LinearVia.Connector, signedIn: null, note: null };
          if (servers.length > 0)
            return { ...base, via: LinearVia.Server, signedIn: null, note: null };
          const note = names === undefined ? NOT_CHECKED : names === null ? NOT_READ : null;
          return {
            ...base,
            via: LinearVia.None,
            signedIn: null,
            note,
            unchecked: names === undefined || names === null,
          };
        }
        return servers.length > 0
          ? { ...base, via: LinearVia.Server, signedIn: null, note: null }
          : { ...base, via: LinearVia.None, signedIn: null, note: null };
      });
      return { rows };
    },
  };
}
