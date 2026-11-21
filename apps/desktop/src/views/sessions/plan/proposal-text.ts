import type { ShapeProposalDto } from '@10db/contracts';
import { isConverted } from './proposed-groups';

// The words the Plan uses for a row: its title, what it becomes, and the dimmed line that says Convert
// has made it.

/** The row's title: what the builder reads it by. */
export function proposalTitle(row: ShapeProposalDto): string {
  switch (row.kind) {
    case 'goal':
    case 'task':
    case 'landing':
      return row.body.title;
    case 'decision':
      return row.body.choice;
    case 'principle':
      return row.body.statement;
    case 'question':
      return row.body.text;
    case 'change_task':
      return row.body.title ?? 'Change to a task on the Board';
    case 'remove_task':
      return 'Remove a task from the Board';
  }
}

/** Where Convert puts a row, as the Convert modal says it. */
export function destination(row: ShapeProposalDto): string {
  switch (row.kind) {
    case 'goal':
      return `draft goal, its ${taskCount(row.body.tasks.length)} to Backlog`;
    case 'task':
      return row.body.goalId === undefined ? 'to Backlog' : 'to Backlog, under its goal';
    case 'change_task':
      return 'changes a task on the Board';
    case 'remove_task':
      return 'removes a task from the Board';
    case 'decision':
    case 'principle':
      return 'to Knowledge';
    case 'landing':
      return 'its tasks share one pull request';
    case 'question':
      return 'stored; sent when people arrive';
  }
}

const taskCount = (n: number): string => `${String(n)} ${n === 1 ? 'task' : 'tasks'}`;

/** The dimmed line under a converted row; null for a row Convert hasn't made. */
export function convertedLine(row: ShapeProposalDto, liveLine?: string): string | null {
  if (!isConverted(row)) return null;
  if (row.converted?.withdrawn === true) return 'Withdrawn';
  switch (row.kind) {
    case 'principle':
      if (row.converted?.retired === true) return 'Retired from Knowledge';
      return row.converted?.superseded === true
        ? 'Accepted · replaced by a later principle'
        : 'Accepted · in Knowledge';
    case 'decision':
      return row.converted?.superseded === true
        ? 'Accepted · replaced by a later decision'
        : 'Accepted · in Knowledge';
    case 'question':
      return 'Accepted · stored, sent when people arrive';
    case 'goal':
    case 'task':
      return liveLine === undefined ? 'Accepted · on the Board' : `On the Board · ${liveLine}`;
    case 'change_task':
    case 'remove_task':
    case 'landing':
      return 'Accepted · on the Board';
  }
}

/** The state dot before a row's title: the first of accepted, the round's mark, pinned, else proposed. */
export function rowDot(
  row: ShapeProposalDto,
  live: 'running' | 'done' | null = null,
): { readonly label: string; readonly color: string } {
  if (isConverted(row)) {
    if (live === 'running') return { label: 'Running', color: 'blue' };
    if (live === 'done') return { label: 'Done', color: 'teal' };
    return { label: 'Accepted', color: 'teal' };
  }
  switch (row.mark) {
    case 'new':
      return { label: 'New this round', color: 'blue' };
    case 'changed':
      return { label: 'Changed this round', color: 'blue' };
    case 'moved':
      return { label: 'Moved to Earlier', color: 'gray' };
    case null:
      return row.pinned.length > 0
        ? { label: 'Pinned', color: 'yellow' }
        : { label: 'Proposed', color: 'gray' };
  }
}

/** The short fact a row's chip carries when it has no size: a decision's scope, who a question is for. */
export function rowChipMeta(row: ShapeProposalDto): string {
  switch (row.kind) {
    case 'landing':
      return `${taskCount(row.body.keys.length)} · 1 pull request`;
    case 'question':
      return `for ${row.body.for}`;
    case 'decision':
    case 'principle':
      return row.body.scope === 'area' ? `area ${row.body.area ?? ''}` : row.body.scope;
    case 'goal':
    case 'task':
    case 'change_task':
    case 'remove_task':
      return '';
  }
}
