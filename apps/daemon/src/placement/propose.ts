import { Delivery, WorkspaceMode, type KindDto, type ProjectDto } from '@10db/contracts';

/** Where a new task is proposed to work, and why it is a separate copy when the rule says so. */
export interface PlacementProposal {
  readonly workspaceMode: WorkspaceMode;
  /** Stored with the task so it survives a later change to the project's isolate list; null when the rule didn't match. */
  readonly reason: string | null;
}

/** What a task is declared to touch: its areas (hazard names included) and the kinds it has. */
interface TaskTouches {
  readonly areas: readonly string[];
  /** The rows of the kinds the task names, in the builder's order. */
  readonly kinds: readonly Pick<KindDto, 'key' | 'label' | 'ownCopy'>[];
  /** What the caller asked for; it counts only for a task the rule doesn't match. */
  readonly workspaceMode?: WorkspaceMode | undefined;
}

type ProjectPlacement = Pick<ProjectDto, 'delivery' | 'workspaceMode'> & {
  readonly isolate: readonly string[];
  /** A Workbench pass of the project still holds Your folder (W9). */
  readonly passHoldsFolder?: boolean;
};

/** Why a task goes to a separate copy while a pass holds the project's folder. */
export const PASS_HOLDS_FOLDER_REASON = 'Your folder is in a UI Workbench pass';

/** How the seeded kinds that ask for their own copy read after "touches"; any other kind reads as its label. */
const SEEDED_TOUCHED_NAME: Readonly<Record<string, string>> = {
  migration: 'migrations',
  dependency: 'dependencies',
};

function touchedName(kind: Pick<KindDto, 'key' | 'label'>): string {
  return SEEDED_TOUCHED_NAME[kind.key] ?? kind.label.trim();
}

/**
 * Where a task is proposed to work when it is made (task placement spec, P2). Every entry point that
 * builds a task asks here, so the same input gets the same answer: the builder MCP's `create_task`, an
 * accepted proposal and the task API.
 *
 * A task whose areas name an entry in the project's `isolate` list, or that has a kind whose work
 * needs its own copy (`ownCopy`), gets a separate copy and a stored reason, whatever the caller asked for:
 * only the builder overrides it, later, from the task's placement control. Any other task takes the
 * placement the caller named, else the project's default, with no reason. A project with local delivery
 * has no separate copies, so its tasks are always shared.
 *
 * While a Workbench pass holds Your folder (W9), a task that would work there gets a separate copy
 * and says why; in a local project it stays shared and waits for the pass instead.
 */
export function proposePlacement(project: ProjectPlacement, task: TaskTouches): PlacementProposal {
  if (project.delivery !== Delivery.PullRequest)
    return { workspaceMode: WorkspaceMode.Shared, reason: null };
  const isolated = new Set(project.isolate);
  const touches = new Set<string>();
  for (const area of task.areas) if (isolated.has(area)) touches.add(area);
  for (const kind of task.kinds) if (kind.ownCopy) touches.add(touchedName(kind));
  if (touches.size > 0)
    return { workspaceMode: WorkspaceMode.Worktree, reason: `touches ${[...touches].join(', ')}` };
  const asked = task.workspaceMode ?? project.workspaceMode;
  if (asked === WorkspaceMode.Shared && project.passHoldsFolder === true)
    return { workspaceMode: WorkspaceMode.Worktree, reason: PASS_HOLDS_FOLDER_REASON };
  return { workspaceMode: asked, reason: null };
}
