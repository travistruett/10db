import { BatchState, Delivery, type ProjectViewDto } from '@10db/contracts';

/** How the sheet starts work, from the project's delivery mode and current batch (delivery spec §5). */
export type SheetMode =
  | { readonly kind: 'local' }
  | { readonly kind: 'new_batch' }
  | { readonly kind: 'join'; readonly title: string }
  | { readonly kind: 'fix'; readonly title: string }
  | { readonly kind: 'busy'; readonly title: string; readonly reason: string };

export function sheetMode(project: Pick<ProjectViewDto, 'delivery' | 'currentBatch'>): SheetMode {
  if (project.delivery === Delivery.Local) return { kind: 'local' };
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

/** The Start button says what will happen. */
export function submitLabel(mode: SheetMode, count: number): string {
  switch (mode.kind) {
    case 'local':
      return `Start ${tasks(count)}`;
    case 'new_batch':
      return `Start a batch of ${tasks(count)}`;
    case 'join':
    case 'busy':
      return `Add ${tasks(count)} to ${mode.title}`;
    case 'fix':
      return `Add ${tasks(count, 'fix task')} to ${mode.title}`;
  }
}
