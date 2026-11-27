import {
  EvalBarChoice,
  EvalCaseVerdict,
  EvalCheckKind,
  EvalPick,
  type EvalSuiteDto,
  type NewEvalBody,
} from '@10db/contracts';
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
    .map((s) => `- ${quoted(s.label)}: ${s.definitionPaths.map((p) => `\`${p}\``).join(', ')}`);
  return named.length === 0 ? '' : ['Existing suites to match in format:', ...named].join('\n');
}

const ORIGIN_LINES = {
  page: 'Asked for from the Evals page.',
  gap: 'Asked for from a row of the No Eval tab: LLM work no suite covers.',
  plan_eval: "Asked for from a goal's proposed eval in a Shape plan.",
  pick_models:
    "Asked for from the suite's drawer, Let 10db Pick Models: change the suite's live command so it reads the models to run from an environment variable, which 10db sets to a comma-separated list of model ids to try other models and compare cost. Follow the pattern of ampsio's `MODELS ?=` make variable (a default the command keeps when the variable is unset), then record the variable's name in the suite's manifest `live.models` (`env`, and `ids`: `openrouter` or the project's own `choices`). Run free checks only: never run the live command or any paid model call.",
} as const satisfies Record<NewEvalBody['origin'], string>;

const CHECK_LINES = {
  [EvalCheckKind.Rule]:
    'A rule or test: an exact answer, a contains or does-not-contain check, or a command that passes. Prefer this; it is the cheapest and the most reliable.',
  [EvalCheckKind.Judge]:
    "An AI judge reads each result. Before trusting it, run it on the good and bad examples above and report how often it agrees with the builder's marks; fix the judge's instructions until it does.",
  [EvalCheckKind.Review]:
    'The builder reads the results. Leave a short review list instead of an automatic grade.',
} as const satisfies Record<EvalCheckKind, string>;

const BAR_LINES = {
  [EvalBarChoice.EveryTime]: 'Every time: a model must pass every case.',
  [EvalBarChoice.NineInTen]: '9 in 10: a model must pass at least 90% of the cases.',
  [EvalBarChoice.SevenInTen]: '7 in 10: a model must pass at least 70% of the cases.',
} as const satisfies Record<EvalBarChoice, string>;

const PICK_LINES = {
  [EvalPick.Cheapest]: 'When several models pass, prefer the cheapest.',
  [EvalPick.Best]: 'When several models pass, prefer the best score.',
} as const satisfies Record<EvalPick, string>;

/** The default the brief states: a free check in the gate, and a paid run only on the builder's click. */
const EXECUTION_DEFAULT =
  "The free check (the one that needs no paid model) runs in the project's gate. A paid run happens only when the builder starts it.";

const oneLine = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

/** Text read from a report or a manifest, as one quoted line so it can't pass for an instruction. */
export const quoted = (text: string): string =>
  JSON.stringify(oneLine(text.replaceAll(/\p{Cc}/gu, ' ')));

/** The sections the builder wrote in their own words; one left empty is left out. */
const written = (heading: string, text: string): string =>
  text === '' ? '' : section(heading, text);

function caseLines(cases: NewEvalBody['cases']): string {
  if (cases.length === 0) return '';
  const row = (c: NewEvalBody['cases'][number]): string =>
    `- ${c.verdict === EvalCaseVerdict.Good ? 'Good' : 'Bad'}: ${JSON.stringify(oneLine(c.input))}${c.reason === '' ? '' : ` (${oneLine(c.reason)})`}`;
  return [
    section(
      'Real examples',
      'The builder marked each one. Use them as cases; never change a mark.',
    ),
    ...cases.map(row),
  ].join('\n');
}

function modelLines(request: NewEvalBody): string {
  const parts = [
    request.modelIds.length === 0
      ? ''
      : ['Models to compare:', ...request.modelIds.map((m) => `- \`${m}\``)].join('\n'),
    request.costCapUsd === null
      ? ''
      : `Keep one paid run under $${String(request.costCapUsd)}; the eval must say what a run costs.`,
    request.pick === null ? '' : PICK_LINES[request.pick],
  ].filter((part) => part !== '');
  return parts.length === 0 ? '' : section('Models and cost', parts.join('\n'));
}

function checkLines(request: NewEvalBody): string {
  if (request.check === null && request.checkRule === '') return written('Oracle', request.oracle);
  return section(
    'How to tell good from bad',
    [
      request.check === null ? '' : CHECK_LINES[request.check],
      request.checkRule === '' ? '' : `The check looks at: ${oneLine(request.checkRule)}`,
      request.oracle,
    ]
      .filter((part) => part !== '')
      .join('\n'),
  );
}

function barLines(request: NewEvalBody): string {
  if (request.bar === null) return written('Coverage and bar', request.coverageAndBar);
  return section(
    'The bar',
    [BAR_LINES[request.bar], request.coverageAndBar].filter((p) => p !== '').join('\n'),
  );
}

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
    written('What it should do well', request.goal),
    written('Decision', request.decision),
    written('Evidence', request.evidence),
    caseLines(request.cases),
    checkLines(request),
    barLines(request),
    written('Models', request.models),
    modelLines(request),
    section('Execution', [EXECUTION_DEFAULT, request.execution].filter((p) => p !== '').join('\n')),
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
