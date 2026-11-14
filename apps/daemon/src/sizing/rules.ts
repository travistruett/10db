import {
  TaskKindSource,
  type KindDto,
  type Rigor,
  type TaskDto,
  type TaskKind,
} from '@10db/contracts';

/** What the judge answered for a task, already folded: the kinds it gives and the rigor it chose. */
export interface JudgedSizing {
  readonly kinds: readonly TaskKind[];
  readonly rigor?: { readonly value: Rigor; readonly reason: string };
}

export interface RulesSizing {
  readonly kinds: readonly TaskKind[];
  /** Only ever the judge's: the rules store no rigor, and `effectiveRigor` raises the rigor by the kinds. */
  readonly rigor?: { readonly value: Rigor; readonly source: 'judge'; readonly reason: string };
}

const PINNED: readonly TaskKind['source'][] = [TaskKindSource.Builder, TaskKindSource.Agent];

/**
 * What the rules settle for a task. In order:
 *
 * - the kinds the builder or an agent gave stay;
 * - each kind whose `impliedBy` names one of the task's areas is added from the rules, unless the builder
 *   took it off; a rules kind no longer implied is gone;
 * - the judge's kinds (`judged`, when given) follow, never one already held, taken off or unknown. A judge
 *   kind the task holds from an earlier sizing is dropped when no answer is given: it was for older text.
 */
export function sizeByRules(input: {
  readonly task: Pick<TaskDto, 'areas' | 'kinds' | 'kindsOff'>;
  readonly kinds: readonly Pick<KindDto, 'key' | 'impliedBy'>[];
  readonly judged?: JudgedSizing;
}): RulesSizing {
  const { task } = input;
  const result: TaskKind[] = task.kinds.filter((k) => PINNED.includes(k.source));
  const off = new Set(task.kindsOff);
  const holds = (key: string): boolean => result.some((k) => k.key === key);

  for (const kind of input.kinds) {
    if (off.has(kind.key) || holds(kind.key)) continue;
    if (kind.impliedBy.some((name) => task.areas.includes(name)))
      result.push({ key: kind.key, source: TaskKindSource.Rules });
  }
  for (const judged of input.judged?.kinds ?? []) {
    if (off.has(judged.key) || holds(judged.key)) continue;
    if (!input.kinds.some((k) => k.key === judged.key)) continue;
    result.push({ key: judged.key, source: TaskKindSource.Judge });
  }
  const rigor = input.judged?.rigor;
  return {
    kinds: result,
    ...(rigor === undefined ? {} : { rigor: { ...rigor, source: 'judge' as const } }),
  };
}
