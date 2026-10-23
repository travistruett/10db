import { globSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { readRepoFile, repoRoot } from './workspace';

// Loose objects: a key these tests don't model still reaches them, because the secrets checks read
// whole jobs as JSON.
const WorkflowStep = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

const WorkflowJob = z.looseObject({
  if: z.string().optional(),
  'runs-on': z.string().optional(),
  'timeout-minutes': z.number().int().positive().optional(),
  container: z
    .union([z.string(), z.looseObject({ image: z.string(), options: z.string().optional() })])
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  permissions: z.unknown().optional(),
  environment: z.union([z.string(), z.looseObject({ name: z.string() })]).optional(),
  steps: z.array(WorkflowStep).optional(),
});
export type WorkflowJob = z.infer<typeof WorkflowJob>;

const Workflow = z.looseObject({
  on: z.record(z.string(), z.unknown()),
  permissions: z.unknown().optional(),
  jobs: z.record(z.string(), WorkflowJob),
});
export type Workflow = z.infer<typeof Workflow>;

export const releaseWorkflowPaths = {
  release: '.github/workflows/release.yml',
  releasePlease: '.github/workflows/release-please.yml',
  dryRun: '.github/workflows/release-dry-run.yml',
} as const;

/** Repo-relative paths of every workflow file, sorted. GitHub runs both extensions. */
export function workflowPaths(root: string = repoRoot): string[] {
  return globSync(['.github/workflows/*.yml', '.github/workflows/*.yaml'], { cwd: root }).sort();
}

/** A workflow whose YAML doesn't have the shape these tests read. */
export class WorkflowShapeError extends Error {
  override readonly name = 'WorkflowShapeError';
}

/** Parses workflow YAML; `source` names it in a shape error. */
export function parseWorkflow(text: string, source: string): Workflow {
  const result = Workflow.safeParse(parse(text));
  if (result.success) return result.data;
  const issues = result.error.issues.map(
    (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
  );
  throw new WorkflowShapeError(`${source}: ${issues.join('; ')}`);
}

/** Parses a workflow file, given its repo-relative path. */
export function readWorkflow(path: string): Workflow {
  return parseWorkflow(readRepoFile(path), path);
}

/**
 * The job ids of a workflow, in file order. A job id is the name GitHub reports as the check, so
 * these are the names a ruleset's required status checks must match.
 */
export function workflowJobNames(path: string): string[] {
  return Object.keys(readWorkflow(path).jobs);
}

/** The name of the environment a job is bound to, whichever form the YAML uses. */
export function environmentOf(job: WorkflowJob | undefined): string | undefined {
  const environment = job?.environment;
  return typeof environment === 'object' ? environment.name : environment;
}

export function stepsOf(job: WorkflowJob | undefined): readonly WorkflowStep[] {
  return job?.steps ?? [];
}

export function allSteps(path: string): readonly WorkflowStep[] {
  return Object.values(readWorkflow(path).jobs).flatMap((job) => stepsOf(job));
}

// Comments carry the version a SHA pin stands for, and parsed YAML drops them, so this reads the raw text.
export function usesLines(text: string): { readonly ref: string; readonly comment: string }[] {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)[ \t]*(#.*)?$/gm)].map((match) => ({
    ref: match[1] ?? '',
    comment: (match[2] ?? '').trim(),
  }));
}
