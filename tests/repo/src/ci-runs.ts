import { z } from 'zod';

/** GitHub's list of a workflow's runs, as far as the scripts that read CI's timings use it. */
export const WorkflowRuns = z.object({
  workflow_runs: z.array(z.object({ id: z.number().int().positive(), head_sha: z.string() })),
});

/** GitHub's list of one run's artifacts. */
export const RunArtifacts = z.object({
  artifacts: z.array(z.object({ name: z.string(), expired: z.boolean() })),
});
