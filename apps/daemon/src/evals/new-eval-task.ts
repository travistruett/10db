import type { EvalSuiteDto, NewEvalBody } from '@10db/contracts';
import type { Git } from '../git';

/** A project's own skill for writing evals, found at HEAD. */
export interface EvalSkill {
  readonly name: string;
  /** Every tracked `SKILL.md` it is kept in: `.claude/skills` for Claude, `.agents/skills` for Codex. */
  readonly paths: readonly string[];
}

/** What the task that drafts an eval is made of; the caller adds areas and files it. */
export interface EvalTaskDraft {
  readonly title: string;
  readonly why: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
}

const SKILL_FILE = /^\.(?:claude|agents)\/skills\/([^/]+)\/SKILL\.md$/u;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILLS_BYTES = 1024 * 1024;
/** How many existing suites the brief names as format examples. */
const EXAMPLE_SUITES = 5;

const frontmatterField = (text: string, field: string): string =>
  new RegExp(`^${field}:[ \\t]*(.*)$`, 'mu').exec(text.split(/^---$/mu)[1] ?? '')?.[1] ?? '';

/**
 * The project's skills that are about evals, by their front matter's name or description, read from the
 * tracked `SKILL.md` files at HEAD. A skill kept for both agents is one entry with both paths.
 */
export async function findEvalSkills(
  git: Pick<Git, 'surveyTexts'>,
  repoPath: string,
  tracked: ReadonlySet<string>,
): Promise<EvalSkill[]> {
  const files = [...tracked].filter((path) => SKILL_FILE.test(path)).sort();
  if (files.length === 0) return [];
  const read = await git.surveyTexts(repoPath, files, {
    maxBytes: MAX_SKILL_BYTES,
    maxTotalBytes: MAX_SKILLS_BYTES,
  });
  const byName = new Map<string, string[]>();
  for (const [path, text] of read.texts) {
    const folder = SKILL_FILE.exec(path)?.[1];
    if (folder === undefined) continue;
    const name = frontmatterField(text, 'name').replaceAll(/^['"]|['"]$/gu, '') || folder;
    if (!/\bevals?\b/iu.test(`${name} ${frontmatterField(text, 'description')}`)) continue;
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  return [...byName].map(([name, paths]) => ({ name, paths }));
}

const section = (heading: string, text: string): string =>
  `## ${heading}\n${text === '' ? 'Not stated.' : text}`;

function skillLines(skills: readonly EvalSkill[]): string {
  if (skills.length === 0)
    return 'The project has no eval skill. Follow the format of its existing eval files below.';
  return [
    "Write the eval by the project's own eval skill. Use it by name when your agent lists it; otherwise read its file as the format:",
    ...skills.map((s) => `- \`${s.name}\`: ${s.paths.map((p) => `\`${p}\``).join(', ')}`),
  ].join('\n');
}

function exampleLines(suites: readonly EvalSuiteDto[]): string {
  const named = suites
    .filter((s) => s.definitionPaths.length > 0)
    .slice(0, EXAMPLE_SUITES)
    .map((s) => `- ${s.label}: ${s.definitionPaths.map((p) => `\`${p}\``).join(', ')}`);
  return named.length === 0 ? '' : ['Existing suites to match in format:', ...named].join('\n');
}

const ORIGIN_LINES = {
  page: 'Asked for from the Evals page.',
  gap: 'Asked for from a row of the No Eval tab: LLM work no suite covers.',
  plan_eval: "Asked for from a goal's proposed eval in a Shape plan.",
  pick_models:
    "Asked for from the suite's drawer, Let 10db Pick Models: change the suite's live command so it reads the models to run from an environment variable, which 10db sets to a comma-separated list of model ids to try other models and compare cost. Follow the pattern of ampsio's `MODELS ?=` make variable (a default the command keeps when the variable is unset), then record the variable's name in the suite's manifest `live.models` (`env`, and `ids`: `openrouter` or the project's own `choices`). Run free checks only: never run the live command or any paid model call.",
} as const satisfies Record<NewEvalBody['origin'], string>;

/** The task that has a lane draft one eval: its rationale as the brief, and never the paid run. */
export function evalTaskDraft(
  request: NewEvalBody,
  skills: readonly EvalSkill[],
  suites: readonly EvalSuiteDto[],
): EvalTaskDraft {
  const where =
    request.where.length === 0
      ? ''
      : ['The code the eval is about:', ...request.where.map((p) => `- \`${p}\``)].join('\n');
  const description = [
    ORIGIN_LINES[request.origin],
    section('Decision', request.decision),
    section('Evidence', request.evidence),
    section('Oracle', request.oracle),
    section('Coverage and bar', request.coverageAndBar),
    section('Models', request.models),
    section('Execution', request.execution),
    where,
    skillLines(skills),
    exampleLines(suites),
    "Draft the cases, the graders and the free companion arm (the one that runs without a paid model) in the project's own format, and open a pull request. Never run the live command or any paid model call.",
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  return {
    title: `Write the eval for ${request.behavior}`,
    why: 'An eval is what tells a change to this behavior from a regression.',
    description,
    acceptanceCriteria: [
      "The cases and graders are drafted in the project's own eval format",
      'A free companion arm runs without a paid model call',
      'The live arm was not run',
    ],
  };
}
