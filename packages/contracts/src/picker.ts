import { z } from 'zod';
import { TaskDto } from './entities';
import { ProjectId } from './ids';
import { ClaimKind } from './states';
import { StepPlanDto } from './steps';

/** The most tasks a proposal offers at once: the largest lane cap a project can have. */
export const PICK_MAX = 16;

/** The `size` query parameter of a proposal. */
export const PickSize = z.coerce.number().int().min(1).max(PICK_MAX);

export const PickerClaim = z.object({ kind: z.enum(ClaimKind), name: z.string() });
export type PickerClaim = z.infer<typeof PickerClaim>;

/** One Ready task as the picker sees it (spec §5.2.1); the approval sheet shows it (spec §5.2.4). */
export const PickerCandidate = z.object({
  task: TaskDto,
  /** Ticked when the sheet opens: within the size and free of conflicts. */
  proposed: z.boolean(),
  /** An earlier workstream for the task ended without finishing. */
  resumed: z.boolean(),
  /** The longest chain of open tasks waiting on this one. */
  unblocks: z.int().min(0),
  claims: z.array(PickerClaim),
  /** Why the picker left it out; null when it was proposed or only the size kept it out. */
  conflict: z.string().nullable(),
  plan: StepPlanDto.nullable(),
  planError: z.string().nullable(),
});
export type PickerCandidate = z.infer<typeof PickerCandidate>;

export const PickerProposalDto = z.object({
  projectId: ProjectId,
  size: z.int().min(1).max(PICK_MAX),
  candidates: z.array(PickerCandidate),
});
export type PickerProposalDto = z.infer<typeof PickerProposalDto>;
