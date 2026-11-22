import { Box, Text, UnstyledButton } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { useId, type ReactNode } from 'react';
import classes from './plan-rows.module.css';

export interface PlanSectionProps {
  /** The section's name: Loose tasks, Decisions, How it would run, Earlier. */
  readonly name: string;
  readonly count?: number;
  /** A dim line at the head's right, such as the run preview's totals. */
  readonly aside?: string;
  /** A dim line under the head, shown while the section is open. */
  readonly note?: string;
  readonly folded: boolean;
  readonly onFold: () => void;
  /** Marks the head for the summary line's jump, when the section's rows can't take it. */
  readonly section?: string;
  readonly children?: ReactNode;
}

/**
 * A section of the Plan on the panel's own surface: a dim name that folds it, with the chevron hanging
 * in the gutter so the name starts on the rows' title edge, and its rows under it.
 */
export function PlanSection({
  name,
  count,
  aside,
  note,
  folded,
  onFold,
  section,
  children,
}: PlanSectionProps) {
  const regionId = useId();
  return (
    <Box component="li" className={classes['section']}>
      <UnstyledButton
        className={classes['sectionHead']}
        aria-expanded={!folded}
        aria-controls={folded ? undefined : regionId}
        onClick={onFold}
        {...(section === undefined ? {} : { 'data-section': section })}
      >
        <IconChevronRight
          size={14}
          stroke={1.5}
          aria-hidden="true"
          className={classes['chevron']}
          data-open={folded ? undefined : true}
        />
        <Text component="span" fz={12} fw={600} c="dimmed">
          {name}
        </Text>
        {count === undefined ? null : (
          <Text
            component="span"
            fz={12}
            fw={500}
            c="dimmed"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {count}
          </Text>
        )}
        {aside === undefined ? null : (
          <Text component="span" fz={12} c="dimmed" truncate="end" className={classes['aside']}>
            {aside}
          </Text>
        )}
      </UnstyledButton>
      {folded ? null : (
        <div id={regionId}>
          {note === undefined ? null : (
            <Text fz={12} c="dimmed" px={12} mb={4}>
              {note}
            </Text>
          )}
          {children}
        </div>
      )}
    </Box>
  );
}
