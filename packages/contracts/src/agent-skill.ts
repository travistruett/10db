import { z } from 'zod';

/** The header the 10db-task skill sends with every call, carrying its `VERSION`. */
export const SKILL_VERSION_HEADER = 'x-10db-skill-version';

/** The agent tools 10db links its skill into: Claude Code's `~/.claude/skills`, Codex's `~/.agents/skills`. */
export const AgentSkillTool = { ClaudeCode: 'claude_code', Codex: 'codex' } as const;
export type AgentSkillTool = (typeof AgentSkillTool)[keyof typeof AgentSkillTool];

/**
 * What is at one link path: 10db's link, nothing, a link of someone else's (left as it is), or a real folder
 * or file (left as it is).
 */
export const AgentSkillLinkState = {
  Linked: 'linked',
  Missing: 'missing',
  PointsElsewhere: 'points_elsewhere',
  InTheWay: 'in_the_way',
} as const;
export type AgentSkillLinkState = (typeof AgentSkillLinkState)[keyof typeof AgentSkillLinkState];

/** Why this daemon installs nothing: it runs from source, or on a data dir other than the app's. */
export const AgentSkillNotInstallable = {
  FromSource: 'from_source',
  OtherDataDir: 'other_data_dir',
} as const;
export type AgentSkillNotInstallable =
  (typeof AgentSkillNotInstallable)[keyof typeof AgentSkillNotInstallable];

export const AgentSkillLink = z.object({
  tool: z.enum(AgentSkillTool),
  path: z.string(),
  state: z.enum(AgentSkillLinkState),
  /** The link's own text when it points somewhere else; null otherwise. */
  target: z.string().nullable(),
});
export type AgentSkillLink = z.infer<typeof AgentSkillLink>;

export const AgentSkillStatus = z.object({
  enabled: z.boolean(),
  installable: z.union([z.literal(true), z.object({ reason: z.enum(AgentSkillNotInstallable) })]),
  /** The version this daemon ships; null when it ships none. */
  version: z.string().nullable(),
  /** The version of the copy in `installedPath`; null when there is none. */
  installedVersion: z.string().nullable(),
  installedPath: z.string(),
  links: z.array(AgentSkillLink),
  /** The last install's failure, in words; null when it succeeded or never ran. */
  error: z.string().nullable(),
});
export type AgentSkillStatus = z.infer<typeof AgentSkillStatus>;

export const AgentSkillInput = z.object({ enabled: z.boolean() });
export type AgentSkillInput = z.infer<typeof AgentSkillInput>;

/** What the skill prints about itself: the version the daemon ships and the app's build commit. */
export const AgentSkillInfo = z.object({
  version: z.string().nullable(),
  appCommit: z.string().nullable(),
});
export type AgentSkillInfo = z.infer<typeof AgentSkillInfo>;
