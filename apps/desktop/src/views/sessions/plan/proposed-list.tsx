import type {
  ProjectId,
  ShapePreviewDto,
  ShapeProposalDto,
  ShapeTaskSizeDto,
} from '@10db/contracts';
import { Box } from '@mantine/core';
import type { ReactNode } from 'react';
import { GoalTaskRow } from './goal-task-row';
import { PlanSection } from './plan-section';
import classes from './plan-rows.module.css';
import { PreviewPanel, RUN_SECTION } from './preview-panel';
import { ProposalRow, type RowAction, type RowHandlers } from './proposal-row';
import type { OpenRow } from './row-line';
import type { RowReview } from './review-lines';
import { isConverted, SectionKey, type ProposedGroups } from './proposed-groups';

interface Block {
  readonly section: SectionKey;
  readonly name: string;
  readonly rows: readonly ShapeProposalDto[];
  /** A dimmed line under the section's name. */
  readonly note?: string;
}

/** The sections after the goals, each holding one kind of row. */
function blocksOf(groups: ProposedGroups): Block[] {
  return [
    {
      section: SectionKey.Tasks,
      // Tasks under no goal: beside goals they are the other tasks, and otherwise simply the tasks.
      name: groups.goals.length === 0 ? 'Tasks' : 'Other tasks',
      rows: groups.looseTasks,
    },
    { section: SectionKey.Changes, name: 'Changes', rows: groups.changes },
    { section: SectionKey.Landings, name: 'Landings', rows: groups.landings },
    { section: SectionKey.Records, name: 'Decisions', rows: groups.records },
    {
      section: SectionKey.Questions,
      name: 'Questions for others',
      rows: groups.questions,
      note: 'Sent when people arrive (goals phase 3)',
    },
  ].filter((block) => block.rows.length > 0);
}

/** What is folded before the builder folds anything: the run preview and Earlier. */
export const FOLDED_AT_FIRST: ReadonlySet<string> = new Set([RUN_SECTION, SectionKey.Earlier]);

export interface ProposedListProps {
  readonly projectId: ProjectId;
  readonly groups: ProposedGroups;
  /** Each proposed task's derived size, and its actual once converted and finished (§8). */
  readonly sizes: readonly ShapeTaskSizeDto[];
  readonly preview: ShapePreviewDto;
  /** The folded sections, by a kind's section key or `RUN_SECTION`; `onFold` flips one. */
  readonly folded: ReadonlySet<string>;
  readonly onFold: (key: string) => void;
  /** The row's menu items: Remove Draft Goal on a converted goal, Withdraw Decision on a decision. */
  readonly actionsFor: (row: ShapeProposalDto) => readonly RowAction[];
  /** The ceremony, findings and rehearsal questions of a pending goal or task, or undefined for any other row. */
  readonly reviewOf?: (row: ShapeProposalDto) => RowReview | undefined;
  /** Edit, pin, restore, drop and Why? on a row. */
  readonly handlers: RowHandlers;
  /** The Plan's round: in the first, every row is new, so none is marked. */
  readonly round: number;
  /** The panel's one open row: opening another closes it. */
  readonly open: OpenRow | null;
  readonly onOpenChange: (next: OpenRow | null) => void;
}

/**
 * The Plan's rows on the panel's surface: each goal under its bright title with its tasks, then a
 * folding section for Loose tasks, Decisions and the rest, How it would run, and Earlier for the
 * superseded ones. ↑/↓ move between the rows of the open sections.
 */
export function ProposedList({
  projectId,
  groups,
  sizes,
  preview,
  folded,
  onFold,
  actionsFor,
  reviewOf,
  handlers,
  open,
  onOpenChange: setOpen,
  round,
}: ProposedListProps) {
  const sizesOf = (row: ShapeProposalDto) => sizes.filter((s) => s.proposalId === row.id);
  const blocks = blocksOf(groups);
  // The Tab key reaches the first row on screen: a goal's head, or the first open section's first row.
  const firstId = (groups.goals[0] ?? blocks.find((b) => !folded.has(b.section))?.rows[0])?.id;
  // A converted row is marked apart, so "N accepted" lands on it whichever kind it is and a kind's
  // own count lands on a pending row.
  const sectionOf = (row: ShapeProposalDto, own: SectionKey): SectionKey =>
    isConverted(row) ? SectionKey.Converted : own;
  /** A goal's tasks as rows, under its head or under it in Earlier. */
  const tasksOf = (goal: ShapeProposalDto): ReactNode => {
    if (goal.kind !== 'goal') return null;
    const review = reviewOf?.(goal);
    const own = sizesOf(goal);
    return (
      <Box component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
        {goal.body.tasks.map((task) => (
          <GoalTaskRow
            key={task.key}
            goal={goal}
            task={task}
            size={own.find((s) => s.key === task.key)}
            review={review?.tasks.find((t) => t.key === task.key)}
            handlers={handlers}
            open={open}
            onOpenChange={setOpen}
          />
        ))}
      </Box>
    );
  };
  const rowOf = (row: ShapeProposalDto, own: SectionKey, children?: ReactNode) => (
    <ProposalRow
      firstRound={round <= 1}
      projectId={projectId}
      key={row.id}
      row={row}
      section={sectionOf(row, own)}
      tabbable={row.id === firstId}
      sizes={sizesOf(row)}
      actions={actionsFor(row)}
      review={reviewOf?.(row)}
      handlers={handlers}
      open={open}
      onOpenChange={setOpen}
      {...(row.kind === 'goal' ? { head: true } : {})}
    >
      {children}
    </ProposalRow>
  );

  return (
    <Box component="ul" aria-label="Plan rows" m={0} p={0} className={classes['sections']}>
      {groups.goals.map((goal) => (
        <Box component="li" key={goal.id} className={classes['section']}>
          {rowOf(goal, SectionKey.Goals, tasksOf(goal))}
        </Box>
      ))}
      {blocks.map((block) => (
        <PlanSection
          key={block.section}
          name={block.name}
          count={block.rows.length}
          {...(block.note === undefined ? {} : { note: block.note })}
          folded={folded.has(block.section)}
          onFold={() => {
            onFold(block.section);
          }}
        >
          <Box component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
            {block.rows.map((row) => rowOf(row, block.section))}
          </Box>
        </PlanSection>
      ))}
      <PreviewPanel
        preview={preview}
        folded={folded.has(RUN_SECTION)}
        onFold={() => {
          onFold(RUN_SECTION);
        }}
      />
      {groups.earlier.length === 0 ? null : (
        <PlanSection
          name="Earlier"
          count={groups.earlier.length}
          section={SectionKey.Earlier}
          folded={folded.has(SectionKey.Earlier)}
          onFold={() => {
            onFold(SectionKey.Earlier);
          }}
        >
          <Box component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
            {groups.earlier.map((row) => (
              <ProposalRow
                firstRound={round <= 1}
                projectId={projectId}
                key={row.id}
                row={row}
                section={SectionKey.Earlier}
                tabbable={false}
                sizes={sizesOf(row)}
                actions={[]}
                handlers={handlers}
                open={open}
                onOpenChange={setOpen}
              >
                {tasksOf(row)}
              </ProposalRow>
            ))}
          </Box>
        </PlanSection>
      )}
    </Box>
  );
}
