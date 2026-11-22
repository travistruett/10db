import type { ShapeProposalDto } from '@10db/contracts';
import { isConverted } from './proposed-groups';

// The words the Proposed list uses for a row: its title, what it becomes, and the dimmed line that
// says Convert has made it.

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

/** The small label in the narrow left column. */
export function kindLabel(row: ShapeProposalDto): string {
  switch (row.kind) {
    case 'goal':
      return 'Goal';
    case 'task':
      return row.body.goalId === undefined ? 'Task' : 'Added';
    case 'change_task':
      return 'Change';
    case 'remove_task':
      return 'Remove';
    case 'landing':
      return 'Landing';
    case 'decision':
      return 'Decision';
    case 'principle':
      return 'Principle';
    case 'question':
      return 'Ask';
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
      if (row.converted?.alreadyOnBoard === true) return 'Already on the Board';
      return liveLine === undefined ? 'Accepted · on the Board' : `On the Board · ${liveLine}`;
    case 'change_task':
    case 'remove_task':
    case 'landing':
      return 'Accepted · on the Board';
  }
}

/** What the latest round did to a row, until the next round (spec §6); null when it did nothing. */
export function markText(row: ShapeProposalDto): string | null {
  switch (row.mark) {
    case 'new':
      return 'new';
    case 'changed':
      return 'changed';
    case 'moved':
      return 'moved to Earlier';
    case null:
      return null;
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

/** The short facts shown after a title on a collapsed row. */
export function rowMeta(row: ShapeProposalDto): string {
  switch (row.kind) {
    case 'goal':
      return taskCount(row.body.tasks.length);
    case 'task':
      return [
        ...(row.body.external === undefined ? [] : [row.body.external.id]),
        row.body.size ?? 'sized by history',
        row.body.areas.join(', '),
      ].join(' · ');
    case 'landing':
      return `${taskCount(row.body.keys.length)} · 1 pull request`;
    case 'question':
      return `for ${row.body.for}`;
    case 'decision':
    case 'principle':
      return row.body.scope === 'area' ? `area ${row.body.area ?? ''}` : row.body.scope;
    case 'change_task':
    case 'remove_task':
      return '';
  }
}
