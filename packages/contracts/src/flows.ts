import { z } from 'zod';
import { FlowId } from './ids';
import { HyphenatedKey } from './keys';
import { RiskTag, StepRole } from './states';

/** A step is skipped unless its condition holds for the task. */
export const SkipRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unless_risk'), tags: z.array(z.enum(RiskTag)).min(1) }),
  z.object({ kind: z.literal('unless_criteria_over'), count: z.int().min(0) }),
]);
export type SkipRule = z.infer<typeof SkipRule>;

export const FlowStepDef = z.object({
  role: z.enum(StepRole),
  /** The score this step needs, in index points, before floors (spec §5.2). */
  need: z.number().min(0).max(100),
  skip: z.array(SkipRule).default([]),
  /** A persona for this step only, over the team's binding for the role. */
  persona: HyphenatedKey.nullable().default(null),
});
export type FlowStepDef = z.infer<typeof FlowStepDef>;

/** Every flow implements; plans come before the first implement step, review and QA after it; implement is never skipped. */
const FlowSteps = z
  .array(FlowStepDef)
  .min(1)
  .superRefine((steps, ctx) => {
    const firstImplement = steps.findIndex((s) => s.role === StepRole.Implement);
    if (firstImplement === -1) {
      ctx.addIssue({ code: 'custom', message: 'A flow needs an implement step' });
      return;
    }
    steps.forEach((step, i) => {
      if (step.role === StepRole.Implement && step.skip.length > 0)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'skip'],
          message: 'An implement step is never skipped',
        });
      if ((step.role === StepRole.Review || step.role === StepRole.Qa) && i < firstImplement)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'role'],
          message: 'Review and QA come after implement',
        });
      if ((step.role === StepRole.Plan || step.role === StepRole.PlanReview) && i > firstImplement)
        ctx.addIssue({
          code: 'custom',
          path: [i, 'role'],
          message: 'Plan and plan review come before implement',
        });
    });
  });

export const FlowInput = z.object({ name: HyphenatedKey, steps: FlowSteps });
export type FlowInput = z.input<typeof FlowInput>;

export const FlowPatch = z.object({ steps: FlowSteps });
export type FlowPatch = z.input<typeof FlowPatch>;

export const FlowDto = z.object({
  id: FlowId,
  name: HyphenatedKey,
  steps: z.array(FlowStepDef),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type FlowDto = z.infer<typeof FlowDto>;
