import {
  YourMcpServerState,
  YourMcpSource,
  type TrustSwitches,
  type YourMcpServerDto,
  type YourMcpServerKey,
} from '@10db/contracts';
import { prepareYourMcpRun, type LaneWritableRoot } from '../sandbox';
import type { DeclaredYourServer, YourMcpEntry } from './your-mcp-entry';
import { oauthText, shownEnvOf } from './your-mcp-hash';
import { serverState } from './your-mcp-plan';

/** The config keys that only a Codex session applies, as `config.toml` spells them. */
function codexOnlyKeys(entry: YourMcpEntry, declared: DeclaredYourServer): string[] {
  if (entry.source !== YourMcpSource.CodexConfig) return [];
  const { codex } = declared;
  return [
    ...(codex.enabledTools === null ? [] : ['enabled_tools']),
    ...(codex.disabledTools.length === 0 ? [] : ['disabled_tools']),
    ...(codex.startupTimeoutSec === null ? [] : ['startup_timeout_sec']),
    ...(codex.toolTimeoutSec === null ? [] : ['tool_timeout_sec']),
  ];
}

/**
 * Why a stdio server that parsed still can't run today: its command, an argument, its folder or a declared
 * code-loading variable lies where a lane can write. Judged on the server as declared, naming a field and
 * never a value; `${…}` in an env value expands from the login environment at session start.
 */
function launchRefusal(
  declared: Extract<DeclaredYourServer, { transport: 'stdio' }>,
  home: string,
  roots: readonly LaneWritableRoot[],
): string | null {
  return prepareYourMcpRun(
    {
      command: declared.command,
      args: declared.args,
      cwd: declared.cwd,
      env: declared.env,
      declaredEnv: Object.keys(declared.env),
    },
    { home, laneWritable: roots },
  ).refusal;
}

/**
 * The builder's servers as Settings › Trust lists them: each with its state, its switch and the values an
 * approval covers, and no secret. A server that can't run today is left out with its reason, so Approve is
 * never offered for it.
 */
export function yourMcpServerDtos(args: {
  readonly entries: readonly YourMcpEntry[];
  readonly switches: TrustSwitches;
  readonly approvals: ReadonlyMap<YourMcpServerKey, string>;
  readonly home: string;
  readonly laneWritable: readonly LaneWritableRoot[];
}): YourMcpServerDto[] {
  return args.entries.map((entry) => {
    const declared = entry.declared;
    const refusal =
      entry.refusal ??
      (declared?.transport === 'stdio'
        ? launchRefusal(declared, args.home, args.laneWritable)
        : null);
    const state =
      refusal === null ? serverState(entry, args.approvals) : YourMcpServerState.LeftOut;
    const switched = Object.hasOwn(args.switches.mcpServers, entry.key)
      ? args.switches.mcpServers[entry.key]
      : undefined;
    const stdio = declared?.transport === 'stdio' ? declared : null;
    const remote = declared !== null && declared.transport !== 'stdio' ? declared : null;
    return {
      key: entry.key,
      name: entry.name,
      source: entry.source,
      pluginId: entry.pluginId,
      transport: declared?.transport ?? null,
      command: stdio?.command ?? null,
      args: stdio === null ? [] : [...stdio.args],
      cwd: stdio?.cwd ?? null,
      url: remote?.url ?? null,
      envNames:
        stdio === null ? [] : [...new Set([...Object.keys(stdio.env), ...stdio.envVars])].sort(),
      headerNames:
        remote === null
          ? []
          : [
              ...new Set([
                ...Object.keys(remote.headers),
                ...Object.keys(remote.envHeaders),
                ...(remote.bearerTokenVar === null ? [] : ['Authorization']),
              ]),
            ].sort(),
      oauth: remote?.oauth
        ? Object.entries(oauthText(remote.oauth)).map(([name, value]) => ({ name, value }))
        : [],
      shownEnv: declared === null ? [] : shownEnvOf(declared),
      configHash: entry.configHash,
      state,
      reason: refusal,
      on: state === YourMcpServerState.Approved && (switched ?? entry.enabledInSource),
      codexOnly: declared === null ? [] : codexOnlyKeys(entry, declared),
      enabledTools: declared?.codex.enabledTools ? [...declared.codex.enabledTools] : null,
      disabledTools: declared === null ? [] : [...declared.codex.disabledTools],
      sendsNoHeaders:
        remote !== null &&
        Object.keys(remote.headers).length === 0 &&
        Object.keys(remote.envHeaders).length === 0 &&
        remote.bearerTokenVar === null,
    };
  });
}
