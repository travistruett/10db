import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AreaDef, ProjectInput } from '@10db/contracts';
import { z } from 'zod';

/** Where the eval set lives: one JSON file per case, beside the project every case runs in. */
export const EVAL_DIR = resolve(import.meta.dirname, '../../evals/lane-pipeline');
export const CASES_DIR = join(EVAL_DIR, 'cases');
export const PROJECT_FILE = join(EVAL_DIR, 'project.json');
export const BASELINES_DIR = join(EVAL_DIR, 'baselines');

/**
 * What a case is in the set for, beside being a real task: a build that leaned on its plan's detail,
 * or a lane rule its work presses on. Every rule is graded on every case; a tag only makes sure the
 * set keeps a case that tempts each one.
 */
export const CaseTag = {
  PlanDetail: 'plan-detail',
  RuleClaims: 'rule-claims',
  RuleCommitTool: 'rule-commit-tool',
  RuleNoPush: 'rule-no-push',
  RuleDeps: 'rule-deps',
} as const;
export type CaseTag = (typeof CaseTag)[keyof typeof CaseTag];

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * One past merged task: its text and criteria as the lane got them, the commit it started from, and
 * the squash commit that merged it, whose diff from the base is the reference answer.
 */
export const EvalCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  areas: z.array(z.string().min(1)).min(1),
  baseCommit: Sha,
  mergedCommit: Sha,
  tags: z.array(z.enum(CaseTag)).default([]),
});
export type EvalCase = z.infer<typeof EvalCase>;

/** The areas every case's project is made with, as 10db's own project divides the repo. */
export const EvalProject = z.strictObject({
  areas: z.array(AreaDef).min(1),
});
export type EvalProject = z.infer<typeof EvalProject>;

/** Every case file in `dir`, validated at the file boundary and sorted by id. */
export function loadCases(dir: string): EvalCase[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => EvalCase.parse(JSON.parse(readFileSync(join(dir, name), 'utf8'))))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The eval project's areas, checked as a project would be on create. */
export function loadEvalProject(path: string): EvalProject {
  const project = EvalProject.parse(JSON.parse(readFileSync(path, 'utf8')));
  ProjectInput.parse({ name: 'eval', repoPath: '/eval', areas: project.areas });
  return project;
}
