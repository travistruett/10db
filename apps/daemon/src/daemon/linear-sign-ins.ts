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

/** What to tell the builder when an account has no Linear, by the provider table of the Linear design. */
const HINT_CLAUDE_PLAN = 'Sign in to Linear in Claude Code: `/mcp`.';
const HINT_CLAUDE_OTHER = "Add Linear's server to Claude Code, then `/mcp`.";
const HINT_CODEX = 'Sign in in Settings › Trust.';
const NOT_CHECKED = 'Your Linear sign-in is checked when you link a team.';
const NOT_READ = "Couldn't read this account's claude.ai connectors.";

function isLinearServer(url: string): boolean {
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
        const base = { accountId: account.id, accountLabel: account.label, unchecked: false };
        if (account.harness === Provider.Codex) {
          const own = codexRows.filter(
            (r) => r.accountId === account.id && servers.includes(r.name),
          );
          if (own.length === 0)
            return { ...base, via: LinearVia.None, signedIn: null, note: HINT_CODEX };
          const signedIn = own.some((r) => r.state === McpSignInState.SignedIn);
          return {
            ...base,
            via: LinearVia.Server,
            signedIn,
            note: signedIn ? null : HINT_CODEX,
          };
        }
        if (account.kind === AccountKind.ClaudeSubscription) {
          const names = deps.connectorNames(account);
          if (names?.some((name) => /linear/i.test(name)) === true)
            return { ...base, via: LinearVia.Connector, signedIn: null, note: null };
          if (servers.length > 0)
            return { ...base, via: LinearVia.Server, signedIn: null, note: null };
          const note =
            names === undefined ? NOT_CHECKED : names === null ? NOT_READ : HINT_CLAUDE_PLAN;
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
          : { ...base, via: LinearVia.None, signedIn: null, note: HINT_CLAUDE_OTHER };
      });
      return { rows };
    },
  };
}
