import { parse, stringify, type TomlValue } from 'smol-toml';
import { CODEX_VERIFIED_ON } from '../environment';
import { McpServerName } from './mcp-server-name';
import {
  TakeoverRefusedError,
  validSessionId,
  type CodexTakeoverServer,
  type TakeoverArg,
  type TakeoverCommand,
  type TakeoverSpec,
} from './takeover-command';

// Sessions spec §7.5: the command that resumes a chat in the builder's own Codex. Codex runs as it does by
// default there: each key 10db's account home sets only for a lane is put back to Codex's own value. Kept are what
// 10db owns outright: the sign-in method (the project's account is its billing line), where MCP sign-ins are
// stored, and the checkout pinned `untrusted`, so agent-written config runs only after approval.

/**
 * What a plain `codex` runs with, read from the pinned release (`codex features list` on an empty `CODEX_HOME`):
 * the values each lane-only key of the account home goes back to.
 */
export const CODEX_TUI_DEFAULTS = {
  version: CODEX_VERIFIED_ON,
  /** What a plain `codex` runs a model's commands with in a git checkout. */
  sandbox: 'workspace-write',
  approval: 'on-request',
  allowLoginShell: true,
  shellInherit: 'all',
  features: {
    apps: true,
    plugins: true,
    memories: false,
    goals: true,
    image_generation: true,
    browser_use: true,
    browser_use_external: true,
    browser_use_full_cdp_access: true,
    computer_use: true,
    skill_mcp_dependency_install: true,
    network_proxy: false,
  },
  agentsEnabled: true,
  skillsIncludeInstructions: true,
} as const;

/** The variables that hold a remote server's header values; Codex keeps them from the commands it runs. */
export const MCP_TOKEN_PREFIX = 'TENDB_MCP_TOKEN_';

/** `value` as a TOML value on one line, for a `-c key=value` override. */
export function tomlInline(value: TomlValue): string {
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    // A table is written inline only inside an array; take it back out.
    const text = stringify({ v: [[value]] });
    const head = 'v = [ [ ';
    const tail = ' ] ]\n';
    if (!text.startsWith(head) || !text.endsWith(tail))
      throw new TakeoverRefusedError('a server could not be written as TOML');
    return text.slice(head.length, text.length - tail.length);
  }
  const text = stringify({ v: value });
  if (!text.startsWith('v = ') || !text.endsWith('\n'))
    throw new TakeoverRefusedError('a value could not be written as TOML');
  return text.slice('v = '.length, text.length - 1);
}

/** A string the way a `-c` override and a TOML file spell it. */
export const tomlString = (text: string): string => tomlInline(text);

const override = (key: string, value: TomlValue): string[] => ['-c', `${key}=${tomlInline(value)}`];

function serverEntry(server: CodexTakeoverServer): Record<string, TomlValue> {
  // `extras` is built from the builder's config by 10db, so its values are TOML values already.
  const extras = parseExtras(server.extras);
  switch (server.kind) {
    case 'stdio':
      return { command: server.command, args: [...server.args], ...extras };
    case 'remote': {
      for (const { variable } of server.headerVariables)
        if (!variable.startsWith(MCP_TOKEN_PREFIX))
          throw new TakeoverRefusedError('a header variable is not one Codex keeps from commands');
      return {
        url: server.url,
        ...(server.headerVariables.length === 0
          ? {}
          : {
              env_http_headers: Object.fromEntries(
                server.headerVariables.map((h) => [h.header, h.variable]),
              ),
            }),
        ...extras,
      };
    }
  }
}

/** Reads `extras` back through TOML, which rejects anything a config file could not hold. */
function parseExtras(extras: Readonly<Record<string, unknown>>): Record<string, TomlValue> {
  try {
    return parse(stringify(extras));
  } catch {
    throw new TakeoverRefusedError('a server setting could not be written as TOML');
  }
}

export function codexTakeoverCommand(spec: TakeoverSpec): TakeoverCommand {
  const { launch } = spec;
  const defaults = CODEX_TUI_DEFAULTS;
  const servers = spec.codexServers.filter((s) => McpServerName.safeParse(s.name).success);
  const argv: TakeoverArg[] = [
    spec.binary,
    'resume',
    validSessionId(spec.providerSessionId),
    '-m',
    spec.model,
    ...override('model_reasoning_effort', spec.effort),
    '-s',
    defaults.sandbox,
    '-a',
    defaults.approval,
    // 10db's guard hook would refuse every call without its socket.
    ...override('hooks.PreToolUse', []),
    ...override('check_for_update_on_startup', false),
    ...override('allow_login_shell', defaults.allowLoginShell),
    ...override('shell_environment_policy.inherit', defaults.shellInherit),
    ...override('shell_environment_policy.exclude', [`${MCP_TOKEN_PREFIX}*`]),
    ...Object.entries(defaults.features).flatMap(([name, on]) => override(`features.${name}`, on)),
    ...override('agents.enabled', defaults.agentsEnabled),
    ...override('skills.include_instructions', defaults.skillsIncludeInstructions),
    ...override('web_search', spec.web ? 'live' : 'disabled'),
    ...servers.flatMap((server) => override(`mcp_servers.${server.name}`, serverEntry(server))),
    ...(spec.instructionsFile === null
      ? []
      : ['-c', { prefix: 'developer_instructions=', file: spec.instructionsFile }]),
  ];
  return {
    cwd: spec.cwd,
    unset: launch.unset,
    unsetPrefixes: launch.unsetPrefixes,
    set: launch.set,
    keychain: launch.keychain,
    sources: spec.sealedEnvFile === null ? [] : [spec.sealedEnvFile],
    argv,
  };
}
