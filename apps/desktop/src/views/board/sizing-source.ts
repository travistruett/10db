import { EffectiveRigorSource, TaskKindSource, type TaskDto, type TaskKind } from '@10db/contracts';

type SizedRigor = Pick<
  TaskDto,
  'effectiveRigor' | 'effectiveRigorSource' | 'effectiveRigorReason' | 'sizedByRules'
>;

const RIGOR_FALLBACK: Readonly<Record<EffectiveRigorSource, string>> = {
  [EffectiveRigorSource.Judge]: 'Rigor the judge chose',
  [EffectiveRigorSource.Rules]: 'Raised by the task’s kinds',
  [EffectiveRigorSource.Agent]: 'Rigor an agent set',
  [EffectiveRigorSource.Builder]: 'Rigor you set',
  [EffectiveRigorSource.Default]: 'The project’s default',
};

/**
 * What explains the rigor: the reason the one who set it gave, else a line for who it was, and "Sized by
 * rules" appended while no judge answer has been applied.
 */
function rigorExplanation(task: SizedRigor): string {
  const why = task.effectiveRigorReason ?? RIGOR_FALLBACK[task.effectiveRigorSource];
  return task.sizedByRules ? `${why} · Sized by rules` : why;
}

/**
 * The drawer's line under the rigor: why it is what it is. An agent's reason says who gave it, as the judge's
 * and the rules' own sentences do.
 */
export function rigorSourceLine(task: SizedRigor): string {
  const explanation = rigorExplanation(task);
  if (
    task.effectiveRigorSource === EffectiveRigorSource.Agent &&
    task.effectiveRigorReason !== null
  )
    return `An agent: ${explanation}`;
  return `${explanation.charAt(0).toUpperCase()}${explanation.slice(1)}`;
}

const KIND_WORD: Readonly<Record<TaskKind['source'], string>> = {
  [TaskKindSource.Judge]: 'judged',
  [TaskKindSource.Rules]: 'rules',
  [TaskKindSource.Agent]: 'agent',
  [TaskKindSource.Builder]: 'you',
};

const KIND_TOOLTIP: Readonly<Record<TaskKind['source'], string>> = {
  [TaskKindSource.Judge]: 'The judge said the task touches it',
  [TaskKindSource.Rules]: 'The task’s areas imply it',
  [TaskKindSource.Agent]: 'An agent gave the task this kind',
  [TaskKindSource.Builder]: 'You set this kind',
};

/** A kind's badge: its label and who gave it ("Docs · judged"), with a tooltip that says how. */
export function kindBadge(
  label: string,
  source: TaskKind['source'],
): { readonly label: string; readonly tooltip: string } {
  return { label: `${label} · ${KIND_WORD[source]}`, tooltip: KIND_TOOLTIP[source] };
}
