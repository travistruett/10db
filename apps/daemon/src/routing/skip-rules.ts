import type { FlowStepDef, SkipRule, TaskDto } from '@10db/contracts';

export type TaskShape = Pick<TaskDto, 'riskTags' | 'acceptanceCriteria'>;

function holds(rule: SkipRule, task: TaskShape): boolean {
  switch (rule.kind) {
    case 'unless_risk':
      return rule.tags.some((t) => task.riskTags.includes(t));
    case 'unless_criteria_over':
      return task.acceptanceCriteria.length > rule.count;
  }
}

function describeRule(rule: SkipRule): string {
  switch (rule.kind) {
    case 'unless_risk':
      return `no ${rule.tags.join(' or ')} risk`;
    case 'unless_criteria_over':
      return `${String(rule.count)} or fewer acceptance criteria`;
  }
}

/** Why a step is skipped for this task, or null when it runs. A step runs when any of its rules holds. */
export function skipReason(step: FlowStepDef, task: TaskShape): string | null {
  if (step.skip.length === 0 || step.skip.some((rule) => holds(rule, task))) return null;
  return step.skip.map(describeRule).join(' and ');
}
