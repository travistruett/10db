import type { ShapeProposalDto, ShapeTaskSizeDto } from '@10db/contracts';
import { Box, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';
import { kindLabel } from './proposal-text';
import { ProposalRow, type RowAction, type RowHandlers } from './proposal-row';
import type { RowReview } from './review-lines';
import { SectionKey, type ProposedGroups } from './proposed-groups';

interface Block {
  readonly section: SectionKey;
  readonly rows: readonly ShapeProposalDto[];
  /** A dimmed line under the section's first row. */
  readonly note?: string;
}

function blocksOf(groups: ProposedGroups): Block[] {
  return [
    { section: SectionKey.Goals, rows: groups.goals },
    { section: SectionKey.Tasks, rows: groups.looseTasks },
    { section: SectionKey.Changes, rows: groups.changes },
    { section: SectionKey.Landings, rows: groups.landings },
    { section: SectionKey.Records, rows: groups.records },
    {
      section: SectionKey.Questions,
      rows: groups.questions,
      note: 'Sent when people arrive (goals phase 3)',
    },
  ];
}

export interface ProposedListProps {
  readonly groups: ProposedGroups;
  /** Each proposed task's derived size, and its actual once converted and finished (§8). */
  readonly sizes: readonly ShapeTaskSizeDto[];
  /** The row's menu items: Remove Draft Goal on a converted goal, Withdraw Decision… on a decision. */
  readonly actionsFor: (row: ShapeProposalDto) => readonly RowAction[];
  /** The ceremony, findings and rehearsal questions of a pending goal or task, or undefined for any other row. */
  readonly reviewOf?: (row: ShapeProposalDto) => RowReview | undefined;
  /** Edit, pin, restore, drop and Why? on a row. */
  readonly handlers: RowHandlers;
}

/**
 * The rows of the sidebar as one hairline-divided list, each kind labelled in a narrow left column.
 * A list, not cards (DESIGN.md); ↑/↓ move between the rows, and Earlier holds the superseded ones.
 */
export function ProposedList({ groups, sizes, actionsFor, reviewOf, handlers }: ProposedListProps) {
  const sizesOf = (row: ShapeProposalDto) => sizes.filter((s) => s.proposalId === row.id);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const rows = blocksOf(groups).flatMap((block) =>
    block.rows.map((row, index) => ({
      row,
      section: block.section,
      label: index === 0 ? kindLabel(row) : null,
      note: index === 0 ? block.note : undefined,
    })),
  );

  return (
    <Box component="ul" aria-label="Proposed rows" m={0} p={0} style={{ listStyle: 'none' }}>
      {rows.map(({ row, section, label, note }, index) => (
        <ProposalRow
          key={row.id}
          row={row}
          label={label}
          note={note}
          section={section}
          tabbable={index === 0}
          sizes={sizesOf(row)}
          actions={actionsFor(row)}
          review={reviewOf?.(row)}
          handlers={handlers}
        />
      ))}
      {groups.earlier.length === 0 ? null : (
        <>
          <Box component="li" style={{ listStyle: 'none', borderTop: ROW_BORDER }}>
            <UnstyledButton
              aria-expanded={earlierOpen}
              data-section={SectionKey.Earlier}
              onClick={() => {
                setEarlierOpen((o) => !o);
              }}
              py={8}
            >
              <Text size="xs" c="dimmed" component="span">
                {earlierOpen ? (
                  <IconChevronDown size={14} stroke={1.5} aria-hidden="true" />
                ) : (
                  <IconChevronRight size={14} stroke={1.5} aria-hidden="true" />
                )}{' '}
                Earlier ({groups.earlier.length})
              </Text>
            </UnstyledButton>
          </Box>
          {earlierOpen
            ? groups.earlier.map((row) => (
                <ProposalRow
                  key={row.id}
                  row={row}
                  label={kindLabel(row)}
                  note={undefined}
                  section={SectionKey.Earlier}
                  tabbable={false}
                  sizes={sizesOf(row)}
                  actions={[]}
                  handlers={handlers}
                />
              ))
            : null}
        </>
      )}
    </Box>
  );
}

const ROW_BORDER = '1px solid var(--mantine-color-default-border)';
