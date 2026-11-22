import { z } from 'zod';
import { ChatId } from './ids';

/** The tracker an external task link points at. */
export const ExternalKind = { Linear: 'linear' } as const;
export type ExternalKind = (typeof ExternalKind)[keyof typeof ExternalKind];

/** The issue a task was made from: its tracker, readable id (AMP-119), the tracker's own id and its page. */
export const ExternalLink = z.object({
  kind: z.enum(ExternalKind),
  id: z.string().min(1).max(64),
  issueId: z.string().min(1).max(128),
  url: z.url({ protocol: /^https$/ }).max(2048),
});
export type ExternalLink = z.infer<typeof ExternalLink>;

/** The Linear workspace and team a project is bound to, as the sign-in read them. */
export const LinearBinding = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  teamId: z.string().min(1),
  teamKey: z.string().min(1),
  teamName: z.string().min(1),
});
export type LinearBinding = z.infer<typeof LinearBinding>;

/** What a project's Linear binding is doing: a check in a session, or why the last one refused. */
export const LinearCheckDto = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('checking'),
    teamKey: z.string(),
    /** The session that reads the workspace, for the card's link to it. */
    chatId: ChatId,
  }),
  z.strictObject({ state: z.literal('refused'), teamKey: z.string(), reason: z.string() }),
]);
export type LinearCheckDto = z.infer<typeof LinearCheckDto>;

/** A project's Linear: the team it is linked to and the check in flight or refused, if any. */
export const ProjectLinearDto = z.strictObject({
  binding: LinearBinding.nullable(),
  check: LinearCheckDto.nullable(),
});
export type ProjectLinearDto = z.infer<typeof ProjectLinearDto>;

/** `POST /projects/:projectId/integrations/linear/check`: the team to look up, by its key (AMP). */
export const LinearCheckInput = z.strictObject({
  teamKey: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,16}$/, 'A team key is letters and digits, such as AMP'),
});
export type LinearCheckInput = z.infer<typeof LinearCheckInput>;

/** What the session reads through the builder's Linear sign-in and hands to `link_linear_team`. */
export const LinkLinearTeamInput = z.object({
  workspace: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  /** The team the key names, or null when the workspace has none. */
  team: z
    .object({ id: z.string().min(1), key: z.string().min(1), name: z.string().min(1) })
    .nullable(),
});
export type LinkLinearTeamInput = z.infer<typeof LinkLinearTeamInput>;
