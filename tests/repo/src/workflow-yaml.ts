import { parse } from 'yaml';
import { readRepoFile } from './workspace';

interface WorkflowStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly 'runs-on'?: string;
  readonly environment?: string | { readonly name: string };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

export const releaseWorkflowPaths = {
  release: '.github/workflows/release.yml',
  releasePlease: '.github/workflows/release-please.yml',
  dryRun: '.github/workflows/release-dry-run.yml',
} as const;

export function readWorkflow(path: string): Workflow {
  // The file is repo-owned and the release tests pin its shape, so the cast is the check.
  return parse(readRepoFile(path)) as Workflow;
}

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
