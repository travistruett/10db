import {
  Badge,
  Box,
  HoverCard,
  Stack,
  Text,
  UnstyledButton,
  type MantineColor,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import classes from './factory-overview.module.css';
import { StatusDot } from './status-dot';

export interface GoalRowProps {
  readonly title: string;
  /** The short status in the state column: "Running", "Waiting on Mark Ellis". */
  readonly status: string;
  /** The status waits on the builder, so it reads yellow. */
  readonly waitsOnYou?: boolean;
  /** The merged count, "2/5", in its own right-aligned column. */
  readonly count?: string | undefined;
  /** The news as a small badge at the row's right edge, "3 new". */
  readonly news?: string | undefined;
  /** The mechanics the row leaves out, one a line, in a card on hover: progress, questions, lanes, news. */
  readonly details?: readonly string[];
  /** The row's whole verdict, for assistive tech: status, details and news. Absent, the row's text names it. */
  readonly label?: string;
  /** The status dot's color; a row that is not a goal's status (the Done line) has none. */
  readonly color?: MantineColor;
  /** A small bar of where the goal's tasks stand, in the bar column between the title and the line. */
  readonly bar?: ReactNode;
  readonly expanded: boolean;
  /** The region's rows are goal rows themselves (the Done line), so it keeps the card's columns: no inset. */
  readonly flush?: boolean;
  readonly onToggle: () => void;
  /** The region under the row; rendered only while the row is open. */
  readonly children: ReactNode;
}

/**
 * One row of the goal list, on the project card's shared columns (chevron, dot, title, bar, a short status,
 * the merged count, the news), so its edges match the task lines under it; the mechanics behind the status
 * are in a card on hover, and the whole verdict is the row's accessible name. The row is a button that
 * opens and closes the region under it, with no border or shadow of its own. Rows are separated by hairlines, and the open row's whole area takes the
 * control background. Escape inside the open region closes it and returns to the button.
 */
export function GoalRow({
  title,
  status,
  waitsOnYou = false,
  count,
  news,
  details = [],
  label,
  color,
  bar,
  expanded,
  flush = false,
  onToggle,
  children,
}: GoalRowProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const regionId = `${id}-region`;
  const button = useRef<HTMLButtonElement>(null);
  const Chevron = expanded ? IconChevronDown : IconChevronRight;

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !expanded) return;
    // A dialog opened from the region closes on its own Escape and leaves the goal open.
    if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
    // A row inside another open row's region closes alone.
    event.stopPropagation();
    onToggle();
    button.current?.focus();
  }

  return (
    <Box
      onKeyDown={onKeyDown}
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: expanded ? 'var(--mantine-color-default)' : undefined,
      }}
    >
      <HoverCard
        position="bottom-start"
        openDelay={400}
        shadow="md"
        // The row's button keeps its own expanded state and name; the card only repeats details.
        withRoles={false}
        disabled={details.length === 0}
      >
        <HoverCard.Target>
          <UnstyledButton
            ref={button}
            w="100%"
            py={10}
            className={classes['cols']}
            aria-expanded={expanded}
            aria-controls={regionId}
            aria-label={label}
            onClick={() => {
              onToggle();
              // macOS WebKit, the app's window, gives a clicked button no focus, and Escape needs it here.
              button.current?.focus();
            }}
            style={{ borderRadius: 'var(--mantine-radius-md)' }}
          >
            <Chevron size={16} stroke={1.5} aria-hidden />
            <Box style={{ display: 'inline-flex', justifySelf: 'center' }}>
              {color ? <StatusDot color={color} /> : null}
            </Box>
            <Text id={titleId} fw={600} size="sm" truncate>
              {title}
            </Text>
            <Box>{bar}</Box>
            <Text
              size="sm"
              c={waitsOnYou ? 'yellow' : 'dimmed'}
              truncate
              className={classes['goalStatus']}
            >
              {status}
            </Text>
            {count === undefined ? null : (
              <Text size="xs" c="dimmed" className={classes['goalCount']}>
                {count}
              </Text>
            )}
            {news === undefined ? null : (
              <Badge
                size="xs"
                variant="light"
                color="gray"
                tt="none"
                maw="100%"
                className={classes['goalNews']}
              >
                {news}
              </Badge>
            )}
          </UnstyledButton>
        </HoverCard.Target>
        {/* Words only, so the card never takes a click meant for the rows it lies over. */}
        <HoverCard.Dropdown style={{ pointerEvents: 'none' }}>
          <Stack gap={4}>
            {details.map((detail) => (
              <Text key={detail} size="xs">
                {detail}
              </Text>
            ))}
          </Stack>
        </HoverCard.Dropdown>
      </HoverCard>
      {expanded ? (
        <Box
          id={regionId}
          role="region"
          aria-labelledby={titleId}
          px={flush ? 0 : 'md'}
          pt={flush ? 0 : 'xs'}
          pb={flush ? 0 : 'md'}
        >
          {children}
        </Box>
      ) : null}
    </Box>
  );
}
