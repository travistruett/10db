import { ShapeProposalState, type ShapeProposalDto } from '@10db/contracts';

// Shape spec §4: the Proposed list is one list in sections, each kind in its own labelled block, and
// a summary line over it counts them.

export const SectionKey = {
  Goals: 'goals',
  Tasks: 'tasks',
  Changes: 'changes',
  Landings: 'landings',
  Records: 'records',
  Questions: 'questions',
  Earlier: 'earlier',
} as const;
export type SectionKey = (typeof SectionKey)[keyof typeof SectionKey];

export interface ProposedGroups {
  readonly goals: ShapeProposalDto[];
  /** Loose tasks, and additions to a goal already converted. */
  readonly looseTasks: ShapeProposalDto[];
  /** Changes and removals of work already converted. */
  readonly changes: ShapeProposalDto[];
  readonly landings: ShapeProposalDto[];
  /** Decisions and principles. */
  readonly records: ShapeProposalDto[];
  readonly questions: ShapeProposalDto[];
  /** Superseded rows, collapsed. */
  readonly earlier: ShapeProposalDto[];
}

/** Whether Convert has made this row's goal, task or decision. */
export const isConverted = (row: ShapeProposalDto): boolean =>
  row.state === ShapeProposalState.Accepted;

/**
 * Sorts the conversation's rows into the list's sections, in the order the daemon made them. A
 * dropped row (rejected) is a tombstone, not a row; a converted one stays in its section.
 */
export function groupProposals(proposals: readonly ShapeProposalDto[]): ProposedGroups {
  const groups: { [K in keyof ProposedGroups]: ShapeProposalDto[] } = {
    goals: [],
    looseTasks: [],
    changes: [],
    landings: [],
    records: [],
    questions: [],
    earlier: [],
  };
  for (const row of proposals) {
    if (row.state === ShapeProposalState.Rejected) continue;
    if (row.state === ShapeProposalState.Superseded) {
      groups.earlier.push(row);
      continue;
    }
    switch (row.kind) {
      case 'goal':
        groups.goals.push(row);
        break;
      case 'task':
        groups.looseTasks.push(row);
        break;
      case 'change_task':
      case 'remove_task':
        groups.changes.push(row);
        break;
      case 'landing':
        groups.landings.push(row);
        break;
      case 'decision':
      case 'principle':
        groups.records.push(row);
        break;
      case 'question':
        groups.questions.push(row);
        break;
    }
  }
  return groups;
}

/** The rows the latest round created, changed or moved to Earlier (spec §6 What changed, and why). */
export const roundChanges = (proposals: readonly ShapeProposalDto[]): ShapeProposalDto[] =>
  proposals.filter((row) => row.mark !== null && row.state !== ShapeProposalState.Rejected);

export interface SummaryPart {
  readonly text: string;
  /** The section the count jumps to. */
  readonly section: SectionKey;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

const pending = (rows: readonly ShapeProposalDto[]): number =>
  rows.filter((r) => !isConverted(r)).length;

/**
 * The counts under the Proposed header: "1 goal · 3 loose · 2 to record". A count is of what is
 * still pending; what Convert already made is counted apart, last.
 */
export function summaryParts(groups: ProposedGroups): SummaryPart[] {
  const parts: SummaryPart[] = [];
  const add = (n: number, text: string, section: SectionKey): void => {
    if (n > 0) parts.push({ text, section });
  };
  const goals = pending(groups.goals);
  add(goals, plural(goals, 'goal'), SectionKey.Goals);
  const loose = pending(groups.looseTasks);
  add(loose, `${String(loose)} loose`, SectionKey.Tasks);
  const changes = pending(groups.changes);
  add(changes, plural(changes, 'change'), SectionKey.Changes);
  const landings = pending(groups.landings);
  add(landings, plural(landings, 'pull request'), SectionKey.Landings);
  const records = pending(groups.records);
  add(records, `${String(records)} to record`, SectionKey.Records);
  const questions = pending(groups.questions);
  add(questions, plural(questions, 'question'), SectionKey.Questions);
  const converted = [groups.goals, groups.looseTasks, groups.changes, groups.records].reduce(
    (sum, rows) => sum + rows.filter(isConverted).length,
    0,
  );
  add(converted, `${String(converted)} converted`, SectionKey.Goals);
  return parts;
}
