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

/** What the card says about an account, in plain words. */
const NOT_SIGNED_IN_CLAUDE = 'Not signed in: run /mcp in Claude Code';
const NOT_SIGNED_IN_CODEX = 'Not signed in: Settings › Trust';
// 10db holds no sign-in status for a Claude account, so these say the way in, not that it is signed in.
const VIA_PLUGIN = "Through Claude Code's Figma plugin; sign in there with /mcp";
const VIA_SERVER = 'Through your Figma server in Claude Code; sign in there with /mcp';
const VIA_CONNECTOR = 'Through the claude.ai Figma connector';
const VIA_CODEX = 'Signed in through Codex';
const NOT_CHECKED = 'Checked when the agent first uses Figma';
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
      const figma = Object.entries(deps.plan().remote).filter(([, remote]) =>
        isFigmaServer(remote.url),
      );
      const servers = figma.map(([name]) => name);
      // Only a plugin's server carries a Claude name of its own (`plugin:<plugin>:<server>`).
      const serverNote = figma.every(([, remote]) => remote.claudeName !== null)
        ? VIA_PLUGIN
        : VIA_SERVER;
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
            return { ...base, via: FigmaVia.None, signedIn: null, note: NOT_SIGNED_IN_CODEX };
          const signedIn = own.some((r) => r.state === McpSignInState.SignedIn);
          return {
            ...base,
            via: FigmaVia.Server,
            signedIn,
            note: signedIn ? VIA_CODEX : NOT_SIGNED_IN_CODEX,
          };
        }
        if (account.kind === AccountKind.ClaudeSubscription) {
          const names = deps.connectorNames(account);
          if (names?.some((name) => /figma/i.test(name)) === true)
            return { ...base, via: FigmaVia.Connector, signedIn: null, note: VIA_CONNECTOR };
          if (servers.length > 0)
            return { ...base, via: FigmaVia.Server, signedIn: null, note: serverNote };
          const note =
            names === undefined ? NOT_CHECKED : names === null ? NOT_READ : NOT_SIGNED_IN_CLAUDE;
          return {
            ...base,
            via: FigmaVia.None,
            signedIn: null,
            note,
            unchecked: names === undefined || names === null,
          };
        }
        return servers.length > 0
          ? { ...base, via: FigmaVia.Server, signedIn: null, note: serverNote }
          : { ...base, via: FigmaVia.None, signedIn: null, note: NOT_SIGNED_IN_CLAUDE };
      });
      return { rows };
    },
  };
}
