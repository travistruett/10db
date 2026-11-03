import type {
  CeremonyReason,
  ShapeCeremonyDto,
  ShapeFindingDto,
  ShapeProposalDto,
  ShapeViewDto,
} from '@10db/contracts';

// Shape spec §7. What the sidebar and the Convert modal say about a row's ceremony, the reviewers'
// findings and the implementer rehearsal. Pure, so the words are tested apart from the screen.

export type RehearsalState = 'rehearsed' | 'rehearsing' | 'not_rehearsed';

export interface TaskReview {
  readonly key: string;
  readonly state: RehearsalState;
  /** The rehearsal's open questions about this task. */
  readonly questions: readonly ShapeFindingDto[];
}

export interface RowReview {
  readonly ceremony: ShapeCeremonyDto | undefined;
  /** A goal's tasks in its order; a loose task is its own single task. */
  readonly tasks: readonly TaskReview[];
  /** The scope and engineering reviewers' open findings about the effort. */
  readonly findings: readonly ShapeFindingDto[];
  /** Findings and questions already resolved or dismissed. */
  readonly settled: number;
}

const taskKeysOf = (row: ShapeProposalDto): string[] => {
  if (row.kind === 'goal') return row.body.tasks.map((t) => t.key);
  return row.kind === 'task' ? [row.key] : [];
};

/** What the review has to say about one pending goal or task row. */
export function rowReview(view: ShapeViewDto, row: ShapeProposalDto): RowReview {
  const mine = view.findings.filter((f) => f.effortKey === row.key);
  const open = (f: ShapeFindingDto): boolean => f.state === 'open';
  return {
    ceremony: view.ceremony.find((c) => c.proposalId === row.id),
    tasks: taskKeysOf(row).map((key): TaskReview => {
      const mark = view.rehearsals.find((r) => r.proposalId === row.id && r.key === key);
      return {
        key,
        state:
          mark?.rehearsed === true
            ? 'rehearsed'
            : view.turn.rehearsing
              ? 'rehearsing'
              : 'not_rehearsed',
        questions: mine.filter((f) => f.kind === 'question' && f.taskKey === key && open(f)),
      };
    }),
    findings: mine.filter((f) => f.kind === 'finding' && open(f)),
    settled: mine.filter((f) => !open(f)).length,
  };
}

const REASONS: Record<CeremonyReason, string> = {
  loose_l: 'an L task',
  goal_xl: 'a goal over 8 hours',
  many_tasks: 'more than 5 tasks',
  one_way_path: 'it touches a one-way path',
};

/** "Spec required: an L task · not written yet", or null when the effort goes direct. */
export function ceremonyLine(ceremony: ShapeCeremonyDto): string | null {
  if (ceremony.skippedByYou) return 'Spec skipped by you';
  if (ceremony.ceremony !== 'spec') return null;
  const written = ceremony.specWritten ? 'written' : 'not written yet';
  return ceremony.reasons.length === 0
    ? `Spec · ${written}`
    : `Spec required: ${ceremony.reasons.map((r) => REASONS[r]).join(', ')} · ${written}`;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * What Convert warns about, and never blocks on (§7): open rehearsal questions and review findings of
 * the proposals being converted, a spec that is required and missing, and a rehearsal still running.
 */
export function convertWarnings(
  view: ShapeViewDto,
  rows: readonly ShapeProposalDto[],
  rehearsing: boolean,
): string[] {
  const reviews = rows.map((row) => ({ row, review: rowReview(view, row) }));
  const questions = reviews.reduce(
    (n, { review }) => n + review.tasks.reduce((m, t) => m + t.questions.length, 0),
    0,
  );
  const findings = reviews.reduce((n, { review }) => n + review.findings.length, 0);
  const missing = reviews.flatMap(({ row, review }) =>
    review.ceremony?.ceremony === 'spec' && !review.ceremony.specWritten ? [row.key] : [],
  );
  return [
    ...(rehearsing ? ['The rehearsal is still running'] : []),
    ...(questions === 0
      ? []
      : [
          `${String(questions)} rehearsal ${plural(questions, 'question is', 'questions are')} open`,
        ]),
    ...(findings === 0
      ? []
      : [`${String(findings)} review ${plural(findings, 'finding is', 'findings are')} open`]),
    ...missing.map((key) => `${key} needs a spec and has none`),
  ];
}
