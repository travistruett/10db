import { z } from 'zod';
import { AccountId, type ProjectId, type ShapeAttachmentId } from './ids';

// The Figma round trip of a Plan mock-up. A mock-up sent to Figma keeps a link to its frame, and a
// project keeps the one draft file its mock-ups go to; both live in `app_settings` under these keys.

/** The frame a mock-up was sent to: the file, the node in it and the link that opens it. */
export const FigmaFrame = z.strictObject({
  fileKey: z.string().min(1),
  nodeId: z.string().min(1),
  fileUrl: z.string().min(1),
});
export type FigmaFrame = z.infer<typeof FigmaFrame>;

/** The draft file a project's mock-ups go to, one page per send. */
export const FigmaFile = z.strictObject({ fileKey: z.string().min(1) });
export type FigmaFile = z.infer<typeof FigmaFile>;

/** The `app_settings` key of a mock-up's frame. */
export const figmaFrameKey = (attachmentId: ShapeAttachmentId): string =>
  `figma-frame.${attachmentId}`;

/** The `app_settings` key of a project's draft file. */
export const figmaFileKey = (projectId: ProjectId): string => `figma-file.${projectId}`;

/** What a button on a mock-up asks the agent to do. */
export const FigmaAction = { Open: 'open', BringBack: 'bring-back' } as const;
export type FigmaAction = (typeof FigmaAction)[keyof typeof FigmaAction];

export const FigmaPressInput = z.strictObject({ action: z.enum(FigmaAction) });
export type FigmaPressInput = z.infer<typeof FigmaPressInput>;

/** What a mock-up shows of Figma: the link to its frame once sent, and the press waiting to be carried out. */
export const FigmaLinkDto = z.strictObject({
  fileUrl: z.string().nullable(),
  pending: z.enum(FigmaAction).nullable(),
});
export type FigmaLinkDto = z.infer<typeof FigmaLinkDto>;

/** How an account reaches Figma: a claude.ai connector, a server of the builder's, or not at all. */
export const FigmaVia = { Connector: 'connector', Server: 'server', None: 'none' } as const;
export type FigmaVia = (typeof FigmaVia)[keyof typeof FigmaVia];

/** One agent account's way to Figma; `note` is the line to show. */
export const FigmaSignInRowDto = z.strictObject({
  accountId: AccountId,
  accountLabel: z.string(),
  via: z.enum(FigmaVia),
  signedIn: z.boolean().nullable(),
  note: z.string().nullable(),
  /** True when the account's connectors were not read: `none` is then a maybe, not a no. */
  unchecked: z.boolean(),
});
export type FigmaSignInRowDto = z.infer<typeof FigmaSignInRowDto>;

/** `GET /settings/sign-ins/figma`: one row per agent account, from cached reads only. */
export const FigmaSignInsDto = z.strictObject({ rows: z.array(FigmaSignInRowDto) });
export type FigmaSignInsDto = z.infer<typeof FigmaSignInsDto>;
