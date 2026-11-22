import type { ShapeProposalDto } from '@10db/contracts';
import { isConverted } from './proposed-groups';

// The words the Plan uses for a row: its title, what it becomes, and the dimmed line that says Convert
// has made it.

/** The row's title: what the builder reads it by. */
export function proposalTitle(row: ShapeProposalDto): string {
  switch (row.kind) {
    case 'task':
      // As the Board does: a task is named by its headline, a few plain words, when it has one.
      return row.body.headline === '' ? row.body.title : row.body.headline;
    case 'goal':
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

/** What Accept does with a row, as the Accept dialog says it. */
export function destination(row: ShapeProposalDto): string {
  switch (row.kind) {
    case 'goal':
      return `Becomes a draft goal; its ${taskCount(row.body.tasks.length)} go to the Board's Backlog`;
    case 'task':
      return row.body.goalId === undefined
        ? "Goes to the Board's Backlog"
        : "Goes to the Board's Backlog, under its goal";
    case 'change_task':
      return 'Changes a task on the Board';
    case 'remove_task':
      return 'Removes a task from the Board';
    case 'decision':
    case 'principle':
      return 'Goes to Knowledge';
    case 'landing':
      return 'Its tasks share one pull request';
    case 'question':
      return 'Kept, and asked when people join';
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

/**
 * The dot before a row's title: blue for what the latest round created or changed, the one color the
 * Plan draws. Every other row has none; the mark's words (`markText`) say it too.
 */
export function rowDot(
  row: ShapeProposalDto,
): { readonly label: string; readonly color: string } | null {
  if (isConverted(row)) return null;
  switch (row.mark) {
    case 'new':
      return { label: 'New This Round', color: 'blue' };
    case 'changed':
      return { label: 'Changed This Round', color: 'blue' };
    case 'moved':
    case null:
      return null;
  }
}

/** What the latest round did to a row, until the next round (spec §6); null when it did nothing. */
export function markText(row: ShapeProposalDto): string | null {
  switch (row.mark) {
    case 'new':
      return 'New';
    case 'changed':
      return 'Changed';
    case 'moved':
      return 'Moved to Earlier';
    case null:
      return null;
  }
}

/** What a row is when its card names something else: an addition under Loose tasks, a principle under Decisions. */
export function kindChip(row: ShapeProposalDto): string | null {
  switch (row.kind) {
    case 'task':
      // An issue drafted from Linear names its issue; a task added to a goal says so.
      return row.body.external?.id ?? (row.body.goalId === undefined ? null : 'Added');
    case 'principle':
      return 'Principle';
    case 'remove_task':
      return 'Removal';
    case 'goal':
    case 'decision':
    case 'question':
    case 'landing':
    case 'change_task':
      return null;
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
