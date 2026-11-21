import type { ProjectId, ShapeProposalDto, ShapeTaskSizeDto } from '@10db/contracts';
import { Box, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { GoalTaskRow } from './goal-task-row';
import { CardName, PlanCard } from './plan-card';
import { ProposalRow, type RowAction, type RowHandlers } from './proposal-row';
import type { OpenRow } from './row-line';
import type { RowReview } from './review-lines';
import { isConverted, SectionKey, type ProposedGroups } from './proposed-groups';

interface Block {
  readonly section: SectionKey;
  readonly name: string;
  readonly rows: readonly ShapeProposalDto[];
  /** A dimmed line under the card's name. */
  readonly note?: string;
}

/** The cards after the goals, each holding one kind of row. */
function blocksOf(groups: ProposedGroups): Block[] {
  return [
    { section: SectionKey.Tasks, name: 'Loose tasks', rows: groups.looseTasks },
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

export interface ProposedListProps {
  readonly projectId: ProjectId;
  readonly groups: ProposedGroups;
  /** Each proposed task's derived size, and its actual once converted and finished (§8). */
  readonly sizes: readonly ShapeTaskSizeDto[];
  /** The row's menu items: Remove Draft Goal on a converted goal, Withdraw Decision on a decision. */
  readonly actionsFor: (row: ShapeProposalDto) => readonly RowAction[];
  /** The ceremony, findings and rehearsal questions of a pending goal or task, or undefined for any other row. */
  readonly reviewOf?: (row: ShapeProposalDto) => RowReview | undefined;
  /** Edit, pin, restore, drop and Why? on a row. */
  readonly handlers: RowHandlers;
}

/**
 * The Plan's rows as cards: a card for each goal, holding its tasks, then Loose tasks, Decisions and
 * the rest. ↑/↓ move between the rows, and Earlier holds the superseded ones.
 */
export function ProposedList({
  projectId,
  groups,
  sizes,
  actionsFor,
  reviewOf,
  handlers,
}: ProposedListProps) {
  const sizesOf = (row: ShapeProposalDto) => sizes.filter((s) => s.proposalId === row.id);
  const [earlierOpen, setEarlierOpen] = useState(false);
  // One row of the panel is open at a time: opening another closes it.
  const [open, setOpen] = useState<OpenRow | null>(null);
  const blocks = blocksOf(groups);
  // The Tab key reaches the first row on screen: a goal's head, or the first card's first row.
  const firstId = (groups.goals[0] ?? blocks[0]?.rows[0])?.id;
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
      <Box component="ul" m={0} p={0} pl={12} style={{ listStyle: 'none' }}>
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
    <Box
      component="ul"
      aria-label="Plan rows"
      m={0}
      p={0}
      style={{ listStyle: 'none', display: 'grid', gap: 12 }}
    >
      {groups.goals.map((goal) => (
        <PlanCard key={goal.id} head={null}>
          {rowOf(goal, SectionKey.Goals, tasksOf(goal))}
        </PlanCard>
      ))}
      {blocks.map((block) => (
        <PlanCard
          key={block.section}
          head={
            <CardName
              name={block.name}
              count={block.rows.length}
              {...(block.note === undefined ? {} : { note: block.note })}
            />
          }
        >
          <Box component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
            {block.rows.map((row) => rowOf(row, block.section))}
          </Box>
        </PlanCard>
      ))}
      {groups.earlier.length === 0 ? null : (
        <PlanCard
          head={
            <UnstyledButton
              aria-expanded={earlierOpen}
              data-section={SectionKey.Earlier}
              onClick={() => {
                setEarlierOpen((o) => !o);
              }}
              px={14}
              mb={8}
            >
              <Text fz={13} c="dimmed" component="span">
                {earlierOpen ? (
                  <IconChevronDown size={14} stroke={1.5} aria-hidden="true" />
                ) : (
                  <IconChevronRight size={14} stroke={1.5} aria-hidden="true" />
                )}{' '}
                Earlier {groups.earlier.length}
              </Text>
            </UnstyledButton>
          }
        >
          {earlierOpen ? (
            <Box component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
              {groups.earlier.map((row) => (
                <ProposalRow
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
          ) : null}
        </PlanCard>
      )}
    </Box>
  );
}
