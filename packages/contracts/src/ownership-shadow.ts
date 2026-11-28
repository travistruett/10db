import { z } from 'zod';
import { BuilderOwns } from './card-decider';
import { BatchId, JudgeCallId, ProjectId } from './ids';

/** One question's reading by the judge: its answer and how sure it was; null when the call gave none. */
export const OwnershipShadowReading = z
  .strictObject({ yes: z.boolean(), confidence: z.number().min(0).max(1) })
  .nullable();
export type OwnershipShadowReading = z.infer<typeof OwnershipShadowReading>;

/**
 * What an `ownership.shadow` event holds: the judge's answers to the ownership test's questions for one root
 * batch's pull request, with what the test made of them. It is logged to be scored, and nothing reads it to act.
 */
export const OwnershipShadowData = z.strictObject({
  projectId: ProjectId,
  /** The root batch whose pull request was asked about; the event's entity. */
  batchId: BatchId,
  /** The call's row in `judge_calls`. */
  callId: JudgeCallId,
  /** By question id (`one_way_door`, `product_and_taste`, `promise`). */
  answers: z.record(z.string(), OwnershipShadowReading),
  /** How many guardrail paths the pull request changes; null when its diff could not be read. */
  guardrailHits: z.int().nonnegative().nullable(),
  owns: z.array(z.enum(BuilderOwns)),
  doubt: z.array(z.string()),
});
export type OwnershipShadowData = z.infer<typeof OwnershipShadowData>;
