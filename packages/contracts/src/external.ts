import { z } from 'zod';

/** The tracker an external task link points at. */
export const ExternalKind = { Linear: 'linear' } as const;
export type ExternalKind = (typeof ExternalKind)[keyof typeof ExternalKind];

/** The issue a task was made from: its tracker, readable id (AMP-119), the tracker's own id and its page. */
export const ExternalLink = z.object({
  kind: z.enum(ExternalKind),
  id: z.string().min(1).max(64),
  issueId: z.string().min(1).max(128),
  url: z.url().max(2048),
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
