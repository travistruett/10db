import { Delivery, RiskTag, WorkspaceMode, type ProjectDto } from '@10db/contracts';

/** Where a new task is proposed to work, and why it is a separate copy when the rule says so. */
export interface PlacementProposal {
  readonly workspaceMode: WorkspaceMode;
  /** Stored with the task so it survives a later change to the project's isolate list; null when the rule didn't match. */
  readonly reason: string | null;
}

/** What a task is declared to touch: its areas (hazard names included) and its risk tags. */
interface TaskTouches {
  readonly areas: readonly string[];
  readonly riskTags: readonly RiskTag[];
  /** What the caller asked for; it counts only for a task the rule doesn't match. */
  readonly workspaceMode?: WorkspaceMode | undefined;
}

type ProjectPlacement = Pick<ProjectDto, 'delivery' | 'workspaceMode'> & {
  readonly isolate: readonly string[];
};

/** The name a risk tag adds to the reason; a tag the rule ignores has none. */
const RISK_TAG_TOUCHES: Partial<Record<RiskTag, string>> = {
  [RiskTag.Migration]: 'migrations',
  [RiskTag.Dependency]: 'dependencies',
};

/**
 * Where a task is proposed to work when it is made (task placement spec, P2). Every entry point that
 * builds a task asks here, so the same input gets the same answer: the builder MCP's `create_task`, an
 * accepted proposal and the task API.
 *
 * A task whose areas name an entry in the project's `isolate` list, or whose risk tags include
 * migration or dependency, gets a separate copy and a stored reason, whatever the caller asked for:
 * only the builder overrides it, later, from the task's placement control. Any other task takes the
 * placement the caller named, else the project's default, with no reason. A project with local delivery
 * has no separate copies, so its tasks are always shared.
 */
export function proposePlacement(project: ProjectPlacement, task: TaskTouches): PlacementProposal {
  if (project.delivery !== Delivery.PullRequest)
    return { workspaceMode: WorkspaceMode.Shared, reason: null };
  const isolated = new Set(project.isolate);
  const touches = new Set<string>();
  for (const area of task.areas) if (isolated.has(area)) touches.add(area);
  for (const tag of task.riskTags) {
    const name = RISK_TAG_TOUCHES[tag];
    if (name !== undefined) touches.add(name);
  }
  if (touches.size > 0)
    return { workspaceMode: WorkspaceMode.Worktree, reason: `touches ${[...touches].join(', ')}` };
  return { workspaceMode: task.workspaceMode ?? project.workspaceMode, reason: null };
}
