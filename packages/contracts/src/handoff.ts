import { z } from 'zod';
import { HandoffId, SessionId, WorkstreamId } from './ids';

const Lines = z.array(z.string().min(1));

/** The six-part handoff the agent writes (spec §5.3). 10db adds the git-derived facts itself. */
export const HandoffInput = z.object({
  objective: z.object({ task: z.string().min(1), acceptanceCriteria: Lines, nonGoals: Lines }),
  progress: z.object({ done: Lines, notDone: Lines, nextAction: z.string().min(1) }),
  codeState: z.object({ uncommittedSummary: z.string() }),
  reasoning: z.object({ decisions: Lines, tradeOffs: Lines, rejected: Lines }),
  validation: z.object({
    checks: z.array(z.object({ command: z.string().min(1), result: z.string().min(1) })),
    environmentProblems: Lines,
  }),
  continuity: z.object({
    blockers: Lines,
    pendingQuestions: Lines,
    backgroundJobs: Lines,
    notes: z.string(),
  }),
});
export type HandoffInput = z.infer<typeof HandoffInput>;

export const HandoffDto = z.object({
  id: HandoffId,
  workstreamId: WorkstreamId,
  sessionId: SessionId,
  content: HandoffInput,
  gitHead: z.string(),
  gitChangedFiles: z.array(z.string()),
  gitCommits: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type HandoffDto = z.infer<typeof HandoffDto>;
