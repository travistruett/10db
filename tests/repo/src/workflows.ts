import { globSync } from 'node:fs';
import { parse } from 'yaml';
import { readRepoFile, repoRoot } from './workspace';

export interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
}

export interface WorkflowJob {
  if?: string;
  env?: Record<string, string>;
  permissions?: unknown;
  environment?: unknown;
  steps?: WorkflowStep[];
}

export interface Workflow {
  on: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, WorkflowJob>;
}

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
