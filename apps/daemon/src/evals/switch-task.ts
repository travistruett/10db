import type { EvalSuiteDto, EvalSwitchBody } from '@10db/contracts';
import type { EvalSkill, EvalTaskDraft } from './new-eval-task';

/**
 * The task that switches a suite's model binding: the winning report and cost, every suite that shares the
 * slot (each to be run before the change merges), and the project's eval skill. An agent edits the code and
 * runs free checks only; 10db never edits code or spends.
 */
export function switchTaskDraft(
  suite: EvalSuiteDto,
  request: EvalSwitchBody,
  suites: readonly EvalSuiteDto[],
  skills: readonly EvalSkill[],
): EvalTaskDraft {
  const winning = suite.latest?.models.find((m) => m.model === request.model);
  const slot = request.slot ?? winning?.slot ?? null;
  const target = slot ?? suite.label;
  const report =
    suite.latest === null || winning === undefined
      ? 'No result file naming the model was found; the sweep that picked it wrote one.'
      : `Winning report: \`${suite.latest.path}\`, ${winning.passed ? 'passed' : 'did not pass'}${
          winning.costUsd === null ? '' : `, cost $${winning.costUsd.toFixed(4)}`
        }.`;
  const sharing =
    slot === null
      ? [suite]
      : suites.filter((s) => s.latest?.models.some((m) => m.slot === slot) === true);
  const listed = sharing.some((s) => s.key === suite.key) ? sharing : [suite, ...sharing];
  const skillLine =
    skills.length === 0
      ? ''
      : `The project's eval skills, for the suites' formats: ${skills
          .map((s) => `\`${s.name}\` (${s.paths.map((p) => `\`${p}\``).join(', ')})`)
          .join('; ')}.`;
  const description = [
    `Switch ${target} to \`${request.model}\`. A sweep on the suite "${suite.label}" found it the cheapest model that passes every gate.`,
    report,
    "Change the model binding the way this project does (look for where the slot or the suite's model is named: a slot table, a config line or a constant) and change nothing else.",
    [
      'Suites on this slot. List each in the pull request: the builder runs each from its Evals block before merging; 10db never runs them for you.',
      ...listed.map((s) => `- ${s.label} (\`${s.key}\`)`),
    ].join('\n'),
    skillLine,
    'Edit code and run free checks only: never run the live command or any paid model call.',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  return {
    title: `Switch ${target} to ${request.model}`,
    why: 'A sweep found a cheaper model that passes the suite; the binding is code the builder owns.',
    description,
    acceptanceCriteria: [
      `${target} names ${request.model}`,
      'The pull request lists every suite on the slot to run before merging',
      'No live command or paid model call was run',
    ],
  };
}
