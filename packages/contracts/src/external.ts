import { z } from 'zod';

/** The tracker an external task link points at. */
export const ExternalKind = { Linear: 'linear' } as const;
export type ExternalKind = (typeof ExternalKind)[keyof typeof ExternalKind];

/** The issue a task was made from: its tracker, readable id (AMP-119), the tracker's own id and its page. */
const ExternalLinkFields = z.object({
  kind: z.enum(ExternalKind),
  id: z.string().min(1).max(64),
  issueId: z.string().min(1).max(128),
  url: z.url({ protocol: /^https$/ }).max(2048),
});
/** A link's page lives on its tracker's own host. */
const TRACKER_HOST: Readonly<Record<ExternalKind, string>> = { linear: 'linear.app' };

export const ExternalLink = ExternalLinkFields.refine(
  (link) => URL.canParse(link.url) && new URL(link.url).hostname === TRACKER_HOST[link.kind],
  { message: 'The url must be on the tracker named by kind', path: ['url'] },
);
export type ExternalLink = z.infer<typeof ExternalLinkFields>;

/** The Linear workspace and team a project is bound to, as the sign-in read them. */
export const LinearBinding = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  teamId: z.string().min(1),
  teamKey: z.string().min(1),
  teamName: z.string().min(1),
});
export type LinearBinding = z.infer<typeof LinearBinding>;
