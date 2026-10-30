import {
  BranchName,
  landingText,
  taskLandingFor,
  type BatchDto,
  type ProjectDto,
  type TaskDto,
  type TaskLanding,
} from '@10db/contracts';

/** A landing as the form holds it: the kind, and the branch text typed so far (kept while another kind is chosen). */
export interface LandingDraft {
  readonly kind: TaskLanding['kind'];
  readonly branch: string;
}

/** The project's default, as a task starts from it. */
export function draftFor(project: Pick<ProjectDto, 'landing'>): LandingDraft {
  return draftOf(taskLandingFor(project.landing));
}

export function draftOf(landing: TaskLanding): LandingDraft {
  return { kind: landing.kind, branch: landing.kind === 'branch' ? landing.branch : '' };
}

export type DraftLanding =
  | { readonly ok: true; readonly landing: TaskLanding }
  | { readonly ok: false; readonly error: string };

/** The landing to send, or the plain-words reason the typed branch is not one. */
export function landingFromDraft(draft: LandingDraft): DraftLanding {
  switch (draft.kind) {
    case 'base':
      return { ok: true, landing: { kind: 'base' } };
    case 'hold':
      return { ok: true, landing: { kind: 'hold' } };
    case 'branch': {
      const branch = draft.branch.trim();
      if (branch === '') return { ok: false, error: 'Name the branch this task merges into' };
      if (!BranchName.safeParse(branch).success)
        return { ok: false, error: 'Enter a branch name such as feature/search' };
      return { ok: true, landing: { kind: 'branch', branch } };
    }
  }
}

/** True when the draft would send something other than what the task already has. */
export function landingChanged(current: TaskLanding, draft: LandingDraft): boolean {
  if (draft.kind !== current.kind) return true;
  return current.kind === 'branch' && draft.branch.trim() !== current.branch;
}

/** The three choices, the first naming the project's base branch. */
export function landingOptions(baseBranch: string): readonly {
  readonly value: TaskLanding['kind'];
  readonly label: string;
}[] {
  return [
    { value: 'base', label: `Merge into ${baseBranch}` },
    { value: 'branch', label: 'Merge into another branch' },
    { value: 'hold', label: 'Hold for my review' },
  ];
}

/**
 * Where the task's work will land, in a line. Once the task has a batch the batch decides, since
 * its pull request is what lands.
 */
export function landingLine(
  task: Pick<TaskDto, 'landing'>,
  batch: Pick<BatchDto, 'baseBranch' | 'autoMerge'> | undefined,
  projectBase: string,
): string {
  if (batch)
    return landingText(
      batch.autoMerge ? { kind: 'branch', branch: batch.baseBranch } : { kind: 'hold' },
      batch.baseBranch,
    );
  return landingText(task.landing, projectBase);
}
