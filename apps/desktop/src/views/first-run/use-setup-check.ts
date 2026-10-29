import { ToolName, type ToolCheck } from '@10db/contracts';
import { useEffect, useRef, useState } from 'react';
import { useAccounts, useCheckAccountIdentity } from '../../daemon/account-queries';
import { useRecheckSystem, useSystemCheck } from '../../daemon/queries';
import { claudeRow, type ClaudeRow, type SetupRow } from './claude-row';
import { ghRow, gitRow } from './tool-rows';

export interface SetupCheck {
  readonly claude: ClaudeRow;
  readonly git: SetupRow;
  readonly gh: SetupRow;
  /** Claude Code and git are both found; gh is optional. */
  readonly canContinue: boolean;
  /** The login the default account runs tasks as, once Claude Code has said. */
  readonly runsAs: string | null;
  /** Probe Claude Code's login again, and look for the tools again. */
  readonly recheckAgents: () => void;
  readonly recheckTools: () => void;
  readonly rechecking: { readonly agents: boolean; readonly tools: boolean };
}

function find(tools: readonly ToolCheck[], name: ToolName): ToolCheck | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * What the setup check shows: the tools the daemon found and the login Claude Code reports. The login
 * probe starts Claude Code, so it runs once when `entered` first holds and again on each recheck, never
 * on a render. Nothing here changes the default account: the preparer records its login on the first task.
 */
export function useSetupCheck(entered: boolean): SetupCheck {
  const system = useSystemCheck();
  const recheck = useRecheckSystem();
  const identity = useCheckAccountIdentity();
  const accounts = useAccounts();
  const account = (accounts.data ?? []).find((a) => a.isDefault && !a.archived) ?? null;
  const [round, setRound] = useState(0);
  const probed = useRef<string | null>(null);

  const tools = system.data?.tools ?? [];
  const claudeTool = system.data === undefined ? undefined : find(tools, ToolName.Claude);
  const gitTool = system.data === undefined ? undefined : find(tools, ToolName.Git);
  const ghTool = system.data === undefined ? undefined : find(tools, ToolName.Gh);

  const accountId = account?.id ?? null;
  const claudeFound = claudeTool?.path != null;
  const { mutate: probe } = identity;
  useEffect(() => {
    if (!entered || accountId === null || !claudeFound) return;
    const key = `${accountId}:${String(round)}`;
    if (probed.current === key) return;
    probed.current = key;
    probe(accountId);
  }, [entered, accountId, claudeFound, round, probe]);

  const result = identity.data?.accountId === accountId ? identity.data : null;
  // A failed refetch keeps the last good answer on screen; only the lack of any answer is an error.
  const toolsFailure =
    system.data === undefined ? (system.error?.message ?? recheck.error?.message ?? null) : null;
  const failure = toolsFailure ?? accounts.error?.message ?? null;
  const failed: SetupRow | null = failure === null ? null : { mark: 'bad', detail: failure };
  const claude = failed
    ? { ...failed, runsAs: null, canAddLogin: false }
    : claudeRow({
        claude: claudeTool,
        probing: identity.isPending,
        identity: result,
        error: identity.isError ? identity.error.message : null,
      });

  return {
    claude,
    git: toolsFailure === null ? gitRow(gitTool) : { mark: 'bad', detail: toolsFailure },
    gh: toolsFailure === null ? ghRow(ghTool) : { mark: 'bad', detail: toolsFailure },
    canContinue: claudeFound && gitTool?.path != null,
    runsAs: claude.runsAs,
    recheckAgents: () => {
      setRound(round + 1);
      recheck.mutate();
    },
    recheckTools: () => {
      recheck.mutate();
    },
    rechecking: { agents: identity.isPending, tools: recheck.isPending },
  };
}
