import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { LaneSandboxSpec } from '../sandbox';
import type { ClaudeAutoModeSettings } from './claude-auto-mode';
import { setupPromptText } from './setup-prompt';
import type { LanePermissionMode, ShapeAgentDefinition } from './types';

/** What the builder's setup adds to a session (trust line §6): its instructions and plugin dirs. */
export interface ClaudeProfileSetup {
  readonly instructions: string | null;
  readonly plugins: readonly string[];
}

/** What a Claude session is for: a lane that works on a task, or Plan's read-only conversation. */
export type ClaudeProfile =
  | {
      readonly kind: 'lane';
      readonly allowedTools: readonly string[];
      /** The mode a sandboxed lane runs in, already resolved (`laneMode`); an unsandboxed one runs in default. */
      readonly permissionMode: LanePermissionMode;
      readonly pluginDir: string;
      /** The session's policy as auto mode's rules; Claude Code reads them only while it runs in auto mode. */
      readonly autoMode: ClaudeAutoModeSettings;
      readonly setup: ClaudeProfileSetup;
    }
  | {
      readonly kind: 'explore';
      readonly systemPrompt: string;
      readonly tools: readonly string[];
      readonly allowedTools: readonly string[];
      readonly disallowedTools: readonly string[];
      readonly agents: Readonly<Record<string, ShapeAgentDefinition>>;
      readonly setup: ClaudeProfileSetup;
    };

export type ClaudeProfileOptions = Pick<
  Options,
  | 'settingSources'
  | 'strictMcpConfig'
  | 'settings'
  | 'plugins'
  | 'sandbox'
  | 'systemPrompt'
  | 'tools'
  | 'allowedTools'
  | 'disallowedTools'
  | 'agents'
  | 'permissionMode'
> & {
  /** Merged over the session env, before AUTOUPDATE_OFF: the sandbox's env and the scrub switch; {} unsandboxed. */
  readonly sandboxEnv: Readonly<Record<string, string>>;
};

/**
 * Claude Code forces `default` mode while `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is `1`, so a session in
 * auto mode sets it to `0`. The lane profile already denies every non-allowlisted name to Bash by
 * name, and the processes outside the sandbox hold no lane-writable code.
 */
function sandboxEnv(
  sandbox: LaneSandboxSpec,
  mode: LanePermissionMode,
): Readonly<Record<string, string>> {
  return { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: mode === 'auto' ? '0' : '1' };
}

const localPlugins = (paths: readonly string[]) =>
  paths.map((path) => ({ type: 'local' as const, path }));

function laneOptions(
  profile: Extract<ClaudeProfile, { kind: 'lane' }>,
  sandbox: LaneSandboxSpec | null,
): ClaudeProfileOptions {
  // A lane's base prompt is the SDK's empty custom prompt; the setup adds to it, never the preset.
  const setupPrompt = setupPromptText(profile.setup.instructions, profile.setup.plugins);
  return {
    // Never 'user' or 'local': user hooks and plugins stay out (spec §3), and settings.local.json can switch billing.
    // A sandboxed session loads no settings file at all, so the repo can't loosen its sandbox or its permissions.
    settingSources: sandbox ? [] : ['project'],
    // Claude Code reads no MCP config itself. No `mcpServers` here either: the SDK would put them on claude's
    // command line, readable by any local account. They arrive over the control channel (setMcpServers).
    strictMcpConfig: true,
    // Set explicitly: the builder's own autoCompactEnabled: false (global ~/.claude.json) reaches the session despite
    // settingSources. Compaction stays on as the emergency fallback. Claude Code reads `autoMode` only from user,
    // managed or inline settings, never the repository's, so a repository cannot loosen the classifier's rules. The
    // SDK's `settings` type has no `autoMode`; the object comes from `renderClaudeAutoMode`, which validates it.
    settings: sandbox
      ? {
          autoCompactEnabled: true,
          permissions: { ask: [...sandbox.askRules] },
          autoMode: profile.autoMode,
        }
      : { autoCompactEnabled: true },
    ...(sandbox
      ? { sandbox: sandbox.settings, disallowedTools: [...sandbox.disallowedTools] }
      : {}),
    ...(setupPrompt === null ? {} : { systemPrompt: { type: 'custom', prompt: setupPrompt } }),
    // The harness first, then the setup's: never a plugin's install path (`sandbox/setup-dir.ts`).
    plugins: [{ type: 'local', path: profile.pluginDir }, ...localPlugins(profile.setup.plugins)],
    allowedTools: [...profile.allowedTools],
    // In default mode what no allow rule covers reaches canUseTool. Only a sandboxed lane may run in
    // auto mode, whose classifier approves calls itself; an unsandboxed session never does.
    permissionMode: sandbox ? profile.permissionMode : 'default',
    sandboxEnv: sandbox ? sandboxEnv(sandbox, profile.permissionMode) : {},
  };
}

/**
 * Plan's options (Shape spec §5.2): no settings file and never the harness (its skills and personas are
 * for lanes), only the setup's plugin dirs; commands in a read-only lane sandbox; `default` permission
 * mode, in which a call no allow rule covers reaches the permission broker.
 */
function exploreOptions(
  profile: Extract<ClaudeProfile, { kind: 'explore' }>,
  sandbox: LaneSandboxSpec | null,
): ClaudeProfileOptions {
  const setupAppend = setupPromptText(profile.setup.instructions, profile.setup.plugins);
  return {
    settingSources: [],
    strictMcpConfig: true,
    settings: sandbox
      ? { autoCompactEnabled: true, permissions: { ask: [...sandbox.askRules] } }
      : { autoCompactEnabled: true },
    ...(sandbox ? { sandbox: sandbox.settings } : {}),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append:
        setupAppend === null ? profile.systemPrompt : `${profile.systemPrompt}\n\n${setupAppend}`,
    },
    ...(profile.setup.plugins.length === 0 ? {} : { plugins: localPlugins(profile.setup.plugins) }),
    tools: [...profile.tools],
    allowedTools: [...profile.allowedTools],
    disallowedTools: [...profile.disallowedTools, ...(sandbox?.disallowedTools ?? [])],
    // An agent with no model of its own runs on the session's; a call may still name one.
    agents: Object.fromEntries(
      Object.entries(profile.agents).map(([name, agent]) => [
        name,
        {
          description: agent.description,
          prompt: agent.prompt,
          tools: [...agent.tools],
          model: agent.model ?? 'inherit',
        },
      ]),
    ),
    permissionMode: 'default',
    // Default mode: Claude Code forces it while the scrub is on, and it keeps the processes outside the
    // sandbox free of the session's variables.
    sandboxEnv: sandbox ? sandboxEnv(sandbox, 'default') : {},
  };
}

/** Every SDK option that depends on the profile and the sandbox; the session adds the rest. */
export function claudeQueryOptions(
  profile: ClaudeProfile,
  sandbox: LaneSandboxSpec | null,
): ClaudeProfileOptions {
  switch (profile.kind) {
    case 'lane':
      return laneOptions(profile, sandbox);
    case 'explore':
      return exploreOptions(profile, sandbox);
  }
}
