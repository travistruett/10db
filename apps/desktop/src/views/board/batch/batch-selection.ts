import {
  WorkspaceMode,
  type PickerCandidate,
  type PickerProposalDto,
  type TaskId,
} from '@10db/contracts';
import type { SheetMode } from './sheet-mode';

export function initialSelection(proposal: PickerProposalDto): ReadonlySet<TaskId> {
  return new Set(proposal.candidates.filter((c) => c.proposed).map((c) => c.task.id));
}

export function toggle(selection: ReadonlySet<TaskId>, id: TaskId): ReadonlySet<TaskId> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The ticked tasks in the picker's order, which becomes their launch order. */
export function orderedSelection(
  proposal: PickerProposalDto,
  selection: ReadonlySet<TaskId>,
): TaskId[] {
  return proposal.candidates.filter((c) => selection.has(c.task.id)).map((c) => c.task.id);
}

const WHERE: Record<WorkspaceMode, string> = {
  [WorkspaceMode.Shared]: 'Your folder',
  [WorkspaceMode.Worktree]: 'a separate copy',
};

/**
 * The daemon refuses a start where a ticked task depends on another ticked task that runs in the
 * other place (it can't build on work in a checkout it doesn't share). A local project has no
 * placement, so nothing is said there.
 */
function crossPlacementBlockers(ticked: readonly PickerCandidate[]): string[] {
  const byId = new Map(ticked.map((c) => [c.task.id, c.task]));
  return ticked.flatMap(({ task }) =>
    task.dependsOn.flatMap((depId) => {
      const dep = byId.get(depId);
      if (dep === undefined || dep.workspaceMode === task.workspaceMode) return [];
      return [
        `${task.title} runs in ${WHERE[task.workspaceMode]} but needs ${dep.title}, which runs in ${WHERE[dep.workspaceMode]}. Tasks that depend on each other must run in the same place: change where one of them runs.`,
      ];
    }),
  );
}

/**
 * Why the ticked tasks can't start. A shared area is not a blocker: the scheduler runs those tasks
 * one after the other. A busy batch, a missing title, a plan the daemon would refuse, or a
 * dependency that runs in the other placement is.
 */
export function startBlockers(
  proposal: PickerProposalDto,
  selection: ReadonlySet<TaskId>,
  mode: SheetMode,
  title: string,
): string[] {
  if (mode.kind === 'busy') return [mode.reason];
  const ticked = proposal.candidates.filter((c) => selection.has(c.task.id));
  if (ticked.length === 0) return ['Tick at least one task'];
  const untitled = mode.kind === 'new_batch' && title.trim() === '' ? ['Name the batch'] : [];
  return [
    ...untitled,
    ...ticked.flatMap((c) => {
      if (c.planError !== null) return [`${c.task.title}: ${c.planError}`];
      if (c.plan === null) return [`${c.task.title} has no step plan`];
      if (c.plan.overBudget.length > 0) return [`${c.task.title} is over the budget ceiling`];
      return [];
    }),
    ...(mode.kind === 'local' ? [] : crossPlacementBlockers(ticked)),
  ];
}
