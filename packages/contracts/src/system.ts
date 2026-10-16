import { z } from 'zod';

/** The tools the system check looks for on the login PATH. */
export const ToolName = { Claude: 'claude', Git: 'git', Docker: 'docker' } as const;
export type ToolName = (typeof ToolName)[keyof typeof ToolName];

export const ToolCheck = z.object({
  name: z.enum(ToolName),
  path: z.string().nullable(),
  version: z.string().nullable(),
  required: z.boolean(),
});
export type ToolCheck = z.infer<typeof ToolCheck>;

/** What `GET /system` reports: where each tool is, and whether the login-shell capture worked. */
export const SystemCheckDto = z.object({
  loginEnv: z.object({
    source: z.enum(['login_shell', 'inherited']),
    warning: z.string().nullable(),
  }),
  tools: z.array(ToolCheck),
});
export type SystemCheckDto = z.infer<typeof SystemCheckDto>;
