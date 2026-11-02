import { BatchState, Delivery, WorkspaceMode, type ProjectViewDto } from '@10db/contracts';

/** How the sheet starts work, from the project's delivery mode and current batch (delivery spec §5). */
export type SheetMode =
  | { readonly kind: 'local' }
  | { readonly kind: 'new_batch' }
  | { readonly kind: 'worktrees' }
  | { readonly kind: 'join'; readonly title: string }
  | { readonly kind: 'fix'; readonly title: string }
  | { readonly kind: 'busy'; readonly title: string; readonly reason: string };

/**
 * `placements` are the ticked tasks' placements. A start of separate copies makes a batch per
 * task, so the shared batch never gets in its way; a mix follows the shared batch for the tasks
 * that go in Your folder, and `currentBatch` is that shared batch.
 */
export function sheetMode(
  project: Pick<ProjectViewDto, 'delivery' | 'currentBatch'>,
  placements: readonly WorkspaceMode[] = [],
): SheetMode {
  if (project.delivery === Delivery.Local) return { kind: 'local' };
  if (placements.length > 0 && placements.every((p) => p === WorkspaceMode.Worktree))
    return { kind: 'worktrees' };
  const batch = project.currentBatch;
  if (batch === null) return { kind: 'new_batch' };
  const { title } = batch;
  switch (batch.state) {
    case BatchState.Open:
      return { kind: 'join', title };
    case BatchState.Failed:
      return { kind: 'fix', title };
    case BatchState.Cutting:
      return {
        kind: 'busy',
        title,
        reason: `${title} is still cutting its branch; start when it is open`,
      };
    case BatchState.Shipping:
      return { kind: 'busy', title, reason: `${title} is shipping; start once it has shipped` };
    case BatchState.Shipped:
    case BatchState.Closed:
    case BatchState.Abandoned:
      return { kind: 'new_batch' };
  }
}

const tasks = (n: number, word = 'task') => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

const inCopies = (n: number) =>
  n === 1 ? '1 task in a separate copy' : `${String(n)} tasks in separate copies`;

const withCopies = (label: string, copies: number) =>
  copies === 0 ? label : `${label} and start ${inCopies(copies)}`;

/** The Start button says what will happen; `copies` of the `count` tasks go in separate copies. */
export function submitLabel(mode: SheetMode, count: number, copies = 0): string {
  switch (mode.kind) {
    case 'local':
      return `Start ${tasks(count)}`;
    case 'worktrees':
      return `Start ${inCopies(count)}`;
    case 'new_batch':
      return withCopies(`Start a batch of ${tasks(count - copies)}`, copies);
    case 'join':
    case 'busy':
      return withCopies(`Add ${tasks(count - copies)} to ${mode.title}`, copies);
    case 'fix':
      return withCopies(`Add ${tasks(count - copies, 'fix task')} to ${mode.title}`, copies);
  }
}
