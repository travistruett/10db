import { globSync } from 'node:fs';
import { parse } from 'yaml';
import { readRepoFile, repoRoot } from './workspace';

export interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

export interface WorkflowJob {
  if?: string;
  'runs-on'?: string;
  env?: Record<string, string>;
  permissions?: unknown;
  environment?: string | { name: string };
  steps?: WorkflowStep[];
}

export interface Workflow {
  on: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, WorkflowJob>;
}

export const releaseWorkflowPaths = {
  release: '.github/workflows/release.yml',
  releasePlease: '.github/workflows/release-please.yml',
  dryRun: '.github/workflows/release-dry-run.yml',
} as const;

/** Repo-relative paths of every workflow file, sorted. GitHub runs both extensions. */
export function workflowPaths(root: string = repoRoot): string[] {
  return globSync(['.github/workflows/*.yml', '.github/workflows/*.yaml'], { cwd: root }).sort();
}

/** Parses a workflow file, given its repo-relative path. */
export function readWorkflow(path: string): Workflow {
  return parse(readRepoFile(path)) as Workflow;
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
