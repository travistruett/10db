import { z } from 'zod';

/** `GET /health`: liveness plus the protocol version the UI checks before talking further. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  protocolVersion: z.int().positive(),
  startedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
