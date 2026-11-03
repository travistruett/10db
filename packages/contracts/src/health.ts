import { z } from 'zod';
import { CommitSha } from './self-update';

/** `GET /health`: liveness plus the protocol version the UI checks before talking further. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  protocolVersion: z.int().positive(),
  startedAt: z.iso.datetime(),
  /** The commit this app was built from; null for a source run (dev, tests) and for an older daemon. */
  commit: CommitSha.nullable().default(null),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
