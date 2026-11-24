import { z } from 'zod';
import { JudgeKind } from './agent-capabilities';
import { AccountId } from './ids';
import { YourMcpServerDto, YourMcpServerKey } from './your-mcp';

// What comes along into each lane, pass and Plan session (Settings › Trust): one switch per kind of
// setup, on by default, app-wide with a per-project override. A session reads them when it starts.

/** The switches, in the order Settings shows them. */
export const TRUST_SWITCH_KEYS = [
  'web',
  'projectInstructions',
  'yourInstructions',
  'yourSkills',
  'yourPlugins',
  'yourMcpServers',
  'projectSkills',
] as const;
export type TrustSwitchKey = (typeof TRUST_SWITCH_KEYS)[number];

/** A plugin as Claude Code names it: `name@marketplace`. */
const PluginId = z.string().min(1);

export const TrustSwitches = z.strictObject({
  web: z.boolean(),
  projectInstructions: z.boolean(),
  yourInstructions: z.boolean(),
  yourSkills: z.boolean(),
  yourPlugins: z.boolean(),
  projectSkills: z.boolean(),
  /** Only the plugins the builder switched by hand; any other follows Claude Code's `enabledPlugins`. */
  plugins: z.record(PluginId, z.boolean()),
  /** The builder's own MCP servers. A value stored before this key existed reads with them on. */
  yourMcpServers: z.boolean().default(true),
  /** Only the servers the builder switched by hand; any other follows its source's own `enabled`. */
  mcpServers: z.record(YourMcpServerKey, z.boolean()).default({}),
});
export type TrustSwitches = z.infer<typeof TrustSwitches>;

export const TRUST_DEFAULTS: TrustSwitches = {
  web: true,
  projectInstructions: true,
  yourInstructions: true,
  yourSkills: true,
  yourPlugins: true,
  projectSkills: true,
  plugins: {},
  yourMcpServers: true,
  mcpServers: {},
};

/**
 * A project's own switches; an absent key follows the app's. Written out with no defaults: a `.partial()`
 * over defaulted fields would fill them in and override the app.
 */
export const TrustOverrides = z.strictObject({
  web: z.boolean().optional(),
  projectInstructions: z.boolean().optional(),
  yourInstructions: z.boolean().optional(),
  yourSkills: z.boolean().optional(),
  yourPlugins: z.boolean().optional(),
  projectSkills: z.boolean().optional(),
  plugins: z.record(PluginId, z.boolean()).optional(),
  yourMcpServers: z.boolean().optional(),
  mcpServers: z.record(YourMcpServerKey, z.boolean()).optional(),
});
export type TrustOverrides = z.infer<typeof TrustOverrides>;

/**
 * The switches a project's sessions use: each override wins its field, and `plugins` and `mcpServers` merge
 * key by key.
 */
export function effectiveTrust(app: TrustSwitches, overrides: TrustOverrides): TrustSwitches {
  const merged: TrustSwitches = {
    ...app,
    plugins: { ...app.plugins },
    mcpServers: { ...app.mcpServers },
  };
  for (const key of TRUST_SWITCH_KEYS) {
    const value = overrides[key];
    if (value !== undefined) merged[key] = value;
  }
  if (overrides.yourMcpServers !== undefined) merged.yourMcpServers = overrides.yourMcpServers;
  Object.assign(merged.plugins, overrides.plugins ?? {});
  Object.assign(merged.mcpServers, overrides.mcpServers ?? {});
  return merged;
}

/** One skill or plugin that would load, and the switch that brings it; null when none of them owns it. */
const SetupLoadedItem = z.object({ what: z.string(), from: z.enum(TRUST_SWITCH_KEYS).nullable() });

/** What would load into a project's next session, and what was left out and why. */
export const SetupPreviewDto = z.object({
  skills: z.array(SetupLoadedItem),
  plugins: z.array(SetupLoadedItem),
  leftOut: z.array(
    z.object({
      what: z.string(),
      why: z.string(),
      /** The switch whose setup this was left out of; null when none of them owns it. */
      from: z.enum(TRUST_SWITCH_KEYS).nullable(),
      /** Left out as the builder would expect (a duplicate name, 10db's own skill): shown folded and quiet. */
      expected: z.boolean(),
    }),
  ),
});
export type SetupPreviewDto = z.infer<typeof SetupPreviewDto>;

/** A plugin Claude Code has installed for the builder, and whether it comes along. */
export const InstalledPluginDto = z.object({
  id: PluginId,
  name: z.string(),
  version: z.string(),
  /** Its state in Claude Code's own `enabledPlugins`. */
  enabledInClaude: z.boolean(),
  /** Whether it comes along: never with Your plugins off, else the builder's switch here, else `enabledInClaude`. */
  on: z.boolean(),
});
export type InstalledPluginDto = z.infer<typeof InstalledPluginDto>;

/** Who judges a new task's calls on an account: its default model, and why 10db's rules do when they do. */
export const AccountJudgeDto = z.strictObject({
  accountId: AccountId,
  label: z.string(),
  /** The model a new task gets on the account; null when the account offers none. */
  model: z.string().nullable(),
  judge: z.enum(JudgeKind),
  /** Why the account's sessions are on 10db's rules, in one sentence; null when a judge runs. */
  why: z.string().nullable(),
});
export type AccountJudgeDto = z.infer<typeof AccountJudgeDto>;

/** `GET|PUT /settings/trust`. */
export const TrustSettingsDto = z.object({
  switches: TrustSwitches,
  plugins: z.array(InstalledPluginDto),
  /** One row per account. */
  judges: z.array(AccountJudgeDto),
  /** Whether 10db's judge can answer now: a key, and its switches on. A `tendb` row reads the rules without it. */
  tendbReady: z.boolean(),
  /** The builder's own MCP servers, each with its state and switch. */
  mcpServers: z.array(YourMcpServerDto),
  /** Said above the servers, such as a `CLAUDE_CONFIG_DIR` in the shell that 10db doesn't follow; else null. */
  mcpNotice: z.string().nullable(),
});
export type TrustSettingsDto = z.infer<typeof TrustSettingsDto>;

/** `GET|PUT /projects/:projectId/trust`. */
export const ProjectTrustDto = z.object({
  overrides: TrustOverrides,
  effective: TrustSwitches,
  preview: SetupPreviewDto,
});
export type ProjectTrustDto = z.infer<typeof ProjectTrustDto>;
