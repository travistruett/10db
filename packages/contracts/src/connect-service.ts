import { z } from 'zod';
import { ProjectId } from './ids';

/** The services Connect can set up for a project's account: an MCP server added, approved and signed in. */
export const ConnectableService = z.enum(['linear']);
export type ConnectableService = z.infer<typeof ConnectableService>;

/** What the builder reads on each service's button. */
export const CONNECTABLE_SERVICE_LABELS: Readonly<Record<ConnectableService, string>> = {
  linear: 'Linear',
};

/** `POST /settings/connect/:service`: the project whose account is connected. */
export const ConnectServiceInput = z.strictObject({ projectId: ProjectId });
export type ConnectServiceInput = z.infer<typeof ConnectServiceInput>;

/** Where Connect leaves the account: what the builder does next, if anything. */
export const ConnectNext = {
  /** The browser is open on the service's sign-in; `mcp_sign_in.changed` says when it ends. */
  SigningIn: 'signing_in',
  /** The service already works for the account. */
  SignedIn: 'signed_in',
  /** Claude Code's own `/mcp` finishes the sign-in; 10db can't. */
  ClaudeCode: 'claude_code',
} as const;
export type ConnectNext = (typeof ConnectNext)[keyof typeof ConnectNext];

export const ConnectServiceDto = z.strictObject({ next: z.enum(ConnectNext) });
export type ConnectServiceDto = z.infer<typeof ConnectServiceDto>;
