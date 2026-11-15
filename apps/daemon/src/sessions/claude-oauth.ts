import { z } from 'zod';

/**
 * The `oauth` block of a `~/.claude.json` http or sse entry, as Claude Code reads it. A key it doesn't read,
 * such as a client secret, is refused so the block never carries one.
 */
export const ClaudeOAuth = z.strictObject({
  clientId: z.string().min(1).optional(),
  callbackPort: z.int().min(1024).max(65535).optional(),
  authServerMetadataUrl: z.url({ protocol: /^https$/ }).optional(),
  scopes: z.string().min(1).optional(),
  xaa: z.boolean().optional(),
});
export type ClaudeOAuth = z.infer<typeof ClaudeOAuth>;
