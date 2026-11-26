import { z } from 'zod';
import { ProjectId, WorkstreamId } from './ids';

/** What a run's change to an eval's definition files did, read from the patch's lines and never judged by a model. */
export const EvalDefinitionChangeKind = {
  BarLowered: 'bar_lowered',
  CasesRemoved: 'cases_removed',
  GoldenChanged: 'golden_changed',
  GraderChanged: 'grader_changed',
  ModelJudgeAdded: 'model_judge_added',
  Unclassified: 'unclassified',
} as const;
export type EvalDefinitionChangeKind =
  (typeof EvalDefinitionChangeKind)[keyof typeof EvalDefinitionChangeKind];

/** One kind of change to a definition file, with the patch line that showed it (empty for a whole-file kind). */
export const EvalDefinitionChange = z.object({
  kind: z.enum(EvalDefinitionChangeKind),
  line: z.string(),
});
export type EvalDefinitionChange = z.infer<typeof EvalDefinitionChange>;

/** A definition file's classification as a watchpoint hit keeps it, with the suite the file defines. */
export const EvalDefinitionHit = z.object({
  suiteKey: z.string().min(1),
  changes: z.array(EvalDefinitionChange).min(1),
  /** The classification as the builder reads it, naming each line read. */
  reason: z.string(),
});
export type EvalDefinitionHit = z.infer<typeof EvalDefinitionHit>;

/** `eval.definition_changed`: a run changed a suite's definition file. */
export const EvalDefinitionChangedData = z.object({
  projectId: ProjectId,
  workstreamId: WorkstreamId,
  suiteKey: z.string().min(1),
  path: z.string(),
  kinds: z.array(z.enum(EvalDefinitionChangeKind)).min(1),
});
export type EvalDefinitionChangedData = z.infer<typeof EvalDefinitionChangedData>;
