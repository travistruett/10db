import { z } from 'zod';
import { TrustSwitches } from './trust';

type ValueOf<T> = T[keyof T];

/** The four limits every judge holds a session to (trust line §2). */
export const LimitName = {
  DestroysData: 'destroys_data',
  SendsDataOut: 'sends_data_out',
  ReadsSecrets: 'reads_secrets',
  WritesLive: 'writes_live',
} as const;
export type LimitName = ValueOf<typeof LimitName>;

/** Where a session runs: a lane and a pass do the work, Plan and chat talk it through. */
export const TrustSurface = { Lane: 'lane', Pass: 'pass', Plan: 'plan', Chat: 'chat' } as const;
export type TrustSurface = ValueOf<typeof TrustSurface>;

/** One rule of the policy: a short label, as Claude Code's own rules lead with, then the sentence. */
export const PolicyLine = z.strictObject({ label: z.string().min(1), text: z.string().min(1) });
export type PolicyLine = z.infer<typeof PolicyLine>;

export const LimitLine = PolicyLine.extend({ name: z.enum(LimitName) });
export type LimitLine = z.infer<typeof LimitLine>;

/**
 * What one session is held to, whoever judges it: the four limits, the environment the judge reads
 * them in, the coordination lines of its surface, and whether a person is in the session.
 */
export const TrustPolicy = z.strictObject({
  surface: z.enum(TrustSurface),
  attended: z.boolean(),
  limits: z.array(LimitLine).length(4),
  environment: z.array(z.string().min(1)),
  coordination: z.array(PolicyLine),
  /** What grants allow past a limit; empty until grants exist. */
  allow: z.array(z.string().min(1)),
  switches: TrustSwitches,
});
export type TrustPolicy = z.infer<typeof TrustPolicy>;

export const LIVE_SYSTEM_MAX_CHARS = 200;
export const LIVE_SYSTEMS_MAX = 50;

/**
 * A host, cloud profile or namespace the judge treats as live. One line: no control or line-separator
 * character, and never `$defaults`, which would splice Claude Code's own rules into a rendered list.
 */
export const LiveSystem = z
  .string()
  .trim()
  .min(1)
  .max(LIVE_SYSTEM_MAX_CHARS, {
    message: `A live system is at most ${String(LIVE_SYSTEM_MAX_CHARS)} characters`,
  })
  .regex(/^[^\p{Cc}\u2028\u2029]+$/u, {
    message: 'A live system is one line, with no control characters',
  })
  .refine((s) => !s.includes('$defaults'), { message: 'A live system cannot name $defaults' });
export type LiveSystem = z.infer<typeof LiveSystem>;

/** `GET|PUT /projects/:projectId/live-systems`. */
export const LiveSystemsDto = z.strictObject({
  liveSystems: z.array(LiveSystem).max(LIVE_SYSTEMS_MAX, {
    message: `A project has at most ${String(LIVE_SYSTEMS_MAX)} live systems`,
  }),
});
export type LiveSystemsDto = z.infer<typeof LiveSystemsDto>;
