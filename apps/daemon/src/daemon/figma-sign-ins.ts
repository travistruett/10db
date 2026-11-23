import {
  AccountKind,
  FigmaVia,
  McpSignInState,
  harnessOf,
  Provider,
  type AccountId,
  type SupportedAccountKind,
  type FigmaSignInRowDto,
  type FigmaSignInsDto,
} from '@10db/contracts';
import { listAccounts } from '@10db/db';
import type { McpSignIns } from '../accounts';
import type { StateStore } from '../events';
import type { YourMcpPlan } from '../session-setup';

const FIGMA_HOST = 'mcp.figma.com';

/** What to tell the builder when an account has no Figma, . */
const HINT_CLAUDE_PLAN = 'Sign in to Figma in Claude Code: `/mcp`.';
const HINT_CLAUDE_OTHER = "Add Figma's server to Claude Code, then `/mcp`.";
const HINT_CODEX = 'Sign in in Settings › Trust.';
const NOT_CHECKED = 'Your Figma sign-in is checked when the agent first uses it.';
const NOT_READ = "Couldn't read this account's claude.ai connectors.";

/** Whether a remote server's url is Figma's own host. */
export function isFigmaServer(url: string): boolean {
  try {
    return new URL(url).host === FIGMA_HOST;
  } catch {
    return false;
  }
}

/**
 * How each agent account reaches Figma, from reads that already exist: the claude.ai connectors a plan
 * session last read, the builder's configured servers whose host is `mcp.figma.com`, and a Codex account's
 * sign-in to one. It never starts a connector probe.
 */
export function createFigmaSignIns(deps: {
  readonly state: StateStore;
  readonly plan: () => YourMcpPlan;
  readonly mcpSignIns: Pick<McpSignIns, 'list'>;
  /** The connector names an account last read: undefined when never read, null when the read failed. */
  readonly connectorNames: (account: {
    readonly id: AccountId;
    readonly kind: SupportedAccountKind;
    readonly harness: Provider;
  }) => readonly string[] | null | undefined;
}): { list(): Promise<FigmaSignInsDto> } {
  return {
    async list() {
      const servers = Object.entries(deps.plan().remote)
        .filter(([, remote]) => isFigmaServer(remote.url))
        .map(([name]) => name);
      const accounts = listAccounts(deps.state.db).flatMap((account) => {
        const harness = harnessOf(account);
        return harness === null ? [] : [{ ...account, harness }];
      });
      const codexRows =
        servers.length > 0 && accounts.some((a) => a.harness === Provider.Codex)
          ? (await deps.mcpSignIns.list()).rows
          : [];
      const rows = accounts.map((account): FigmaSignInRowDto => {
        const base = { accountId: account.id, accountLabel: account.label, unchecked: false };
        if (account.harness === Provider.Codex) {
          const own = codexRows.filter(
            (r) => r.accountId === account.id && servers.includes(r.name),
          );
          if (own.length === 0)
            return { ...base, via: FigmaVia.None, signedIn: null, note: HINT_CODEX };
          const signedIn = own.some((r) => r.state === McpSignInState.SignedIn);
          return {
            ...base,
            via: FigmaVia.Server,
            signedIn,
            note: signedIn ? null : HINT_CODEX,
          };
        }
        if (account.kind === AccountKind.ClaudeSubscription) {
          const names = deps.connectorNames(account);
          if (names?.some((name) => /figma/i.test(name)) === true)
            return { ...base, via: FigmaVia.Connector, signedIn: null, note: null };
          if (servers.length > 0)
            return { ...base, via: FigmaVia.Server, signedIn: null, note: null };
          const note =
            names === undefined ? NOT_CHECKED : names === null ? NOT_READ : HINT_CLAUDE_PLAN;
          return {
            ...base,
            via: FigmaVia.None,
            signedIn: null,
            note,
            unchecked: names === undefined || names === null,
          };
        }
        return servers.length > 0
          ? { ...base, via: FigmaVia.Server, signedIn: null, note: null }
          : { ...base, via: FigmaVia.None, signedIn: null, note: HINT_CLAUDE_OTHER };
      });
      return { rows };
    },
  };
}
