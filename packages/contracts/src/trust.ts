import { z } from 'zod';
import { JudgeKind } from './agent-capabilities';
import { AccountId } from './ids';

// What comes along into each lane, pass and Plan session (Settings › Trust): one switch per kind of
// setup, on by default, app-wide with a per-project override. A session reads them when it starts.

/** The switches, in the order Settings shows them. */
export const TRUST_SWITCH_KEYS = [
  'web',
  'projectInstructions',
  'yourInstructions',
  'yourSkills',
  'yourPlugins',
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
};

/** A project's own switches; an absent key follows the app's. */
export const TrustOverrides = TrustSwitches.partial();
export type TrustOverrides = z.infer<typeof TrustOverrides>;

/** The switches a project's sessions use: each override wins its field, and `plugins` merges per plugin. */
export function effectiveTrust(app: TrustSwitches, overrides: TrustOverrides): TrustSwitches {
  const merged: TrustSwitches = { ...app, plugins: { ...app.plugins } };
  for (const key of TRUST_SWITCH_KEYS) {
    const value = overrides[key];
    if (value !== undefined) merged[key] = value;
  }
  Object.assign(merged.plugins, overrides.plugins ?? {});
  return merged;
}

/** What would load into a project's next session, and what was left out and why. */
export const SetupPreviewDto = z.object({
  skills: z.array(z.string()),
  plugins: z.array(z.string()),
  leftOut: z.array(z.object({ what: z.string(), why: z.string() })),
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
});
export type TrustSettingsDto = z.infer<typeof TrustSettingsDto>;

/** `GET|PUT /projects/:projectId/trust`. */
export const ProjectTrustDto = z.object({
  overrides: TrustOverrides,
  effective: TrustSwitches,
  preview: SetupPreviewDto,
});
export type ProjectTrustDto = z.infer<typeof ProjectTrustDto>;
