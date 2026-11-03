import type { GoalDigestDto, GoalDto } from '@10db/contracts';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Group,
  List,
  Progress,
  Skeleton,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { useRetryWorkstream } from '../../daemon/queries';
import { useNow } from '../../shell/relative';
import { failureLine } from '../board/task-state';
import { formatTokens } from './format-tokens';
import { shortAgo } from './short-ago';
import { StatusDot } from './status-dot';
import { barCounts, teamLine, type TaskRow } from './task-rows';

/** Where the window of changes stands: the daemon's answer to opening the goal. */
export interface OpenedDigest {
  readonly data: GoalDigestDto | undefined;
  readonly error: string | null;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** A section of the open goal: a small dimmed title over its content. */
function Zone({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" fw={600} tt="uppercase">
        {title}
      </Text>
      {children}
    </Stack>
  );
}

/** A line that opens and closes the section under it; closed until the builder opens it. */
function Disclosure({
  title,
  summary,
  children,
}: {
  readonly title: string;
  readonly summary?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <Box>
      <UnstyledButton
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Group gap={6} wrap="nowrap" align="center">
          <Chevron size={14} stroke={1.5} aria-hidden style={{ flex: 'none' }} />
          <Text size="sm" fw={500}>
            {title}
          </Text>
          {summary ? (
            <Text size="sm" c="dimmed">
              {summary}
            </Text>
          ) : null}
        </Group>
      </UnstyledButton>
      <Box id={regionId} hidden={!open} pl={20} pt={open ? 6 : 0}>
        {open ? children : null}
      </Box>
    </Box>
  );
}

/** The bar's segments, in the colors the Board gives their states: green only for what has merged. */
const SEGMENTS = [
  { key: 'merged', color: 'green', label: 'merged' },
  { key: 'inReview', color: 'blue', label: 'in review' },
  { key: 'inProgress', color: 'cyan', label: 'in progress' },
  { key: 'ready', color: 'gray', label: 'ready' },
  { key: 'notStarted', color: 'dark', label: 'not started' },
] as const;

/** The goal's tasks as a bar split by state, with the counts beside it. */
export function GoalBar({
  digest,
  rows,
}: {
  readonly digest: GoalDigestDto;
  readonly rows: readonly TaskRow[];
}) {
  const counts = barCounts(digest.progress, rows);
  const shown = SEGMENTS.filter((s) => counts[s.key] > 0);
  const line = shown.map((s) => `${String(counts[s.key])} ${s.label}`).join(' · ');
  return (
    <Group gap="sm" wrap="nowrap">
      <Progress.Root w={200} size="sm" style={{ flex: 'none' }}>
        {counts.total === 0
          ? null
          : shown.map((s) => (
              <Progress.Section
                key={s.key}
                value={(counts[s.key] / counts.total) * 100}
                color={s.color}
                aria-label={`${String(counts[s.key])} ${s.label}`}
              />
            ))}
      </Progress.Root>
      <Text size="sm">{counts.total === 0 ? 'No tasks yet' : line}</Text>
    </Group>
  );
}

/**
 * What needs the builder: the open Inbox cards on the goal's tasks, and each task whose run failed
 * with its Retry. Draws nothing when neither exists.
 */
export function NeedsYou({
  digest,
  rows,
}: {
  readonly digest: GoalDigestDto;
  readonly rows: readonly TaskRow[];
}) {
  const retry = useRetryWorkstream();
  const cards = [...digest.waitingOn.recent, ...digest.waitingOn.earlier];
  const failed = rows.flatMap((row) => (row.failed ? [{ row, ws: row.failed }] : []));
  if (cards.length === 0 && failed.length === 0) return null;
  return (
    <Zone title="Needs you">
      <Stack gap={4}>
        {cards.map((card) => (
          <Group key={card.inboxItemId} gap="xs" wrap="nowrap" justify="space-between">
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
              <StatusDot color="yellow" />
              <Text size="sm" lineClamp={1}>
                {card.title}
              </Text>
            </Group>
            <Anchor component={Link} to="/inbox" size="sm" style={{ flex: 'none' }}>
              Inbox ›
            </Anchor>
          </Group>
        ))}
        {failed.map(({ row, ws }) => (
          <Group key={ws.id} gap="xs" wrap="nowrap" justify="space-between">
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
              <StatusDot color="red" />
              <Tooltip
                label={ws.failureReason}
                disabled={!ws.failureReason}
                withArrow
                multiline
                maw={360}
                openDelay={300}
              >
                <Text size="sm" lineClamp={2}>
                  {`Failed: ${row.label}. ${failureLine(ws)}`}
                </Text>
              </Tooltip>
            </Group>
            <Button
              size="compact-xs"
              variant="light"
              loading={retry.isPending && retry.variables.id === ws.id}
              onClick={() => {
                retry.mutate({ id: ws.id });
              }}
            >
              Retry
            </Button>
          </Group>
        ))}
        {retry.error ? (
          <Alert color="red" title="The daemon refused that">
            {retry.error.message}
          </Alert>
        ) : null}
      </Stack>
    </Zone>
  );
}

/** Agent prose names the sessions it came from; the line keeps the words and the tooltip the ids. */
export function withoutSessionIds(text: string): string {
  return text
    .replace(/\s*\(\s*ses_\w+(?:\s*,\s*ses_\w+)*\s*\)/g, '')
    .replace(/\bses_\w+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** One item of the window: a single clamped line, whole in its tooltip. */
function OneLine({ text, full }: { readonly text: string; readonly full: string }) {
  return (
    <Tooltip label={full} withArrow multiline maw={420} openDelay={300}>
      <Text size="sm" lineClamp={1}>
        {text}
      </Text>
    </Tooltip>
  );
}

interface Delta<T> {
  readonly recent: readonly T[];
  readonly earlier: readonly T[];
}

function DeltaLines<T>({
  label,
  row,
  line,
}: {
  readonly label: string;
  readonly row: Delta<T>;
  readonly line: (value: T) => ReactNode;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const shown = showEarlier ? [...row.recent, ...row.earlier] : row.recent;
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {shown.length === 0 ? (
        <Text size="sm" c="dimmed">
          None
        </Text>
      ) : null}
      {shown.map((value, index) => (
        <Box key={index}>{line(value)}</Box>
      ))}
      {row.earlier.length > 0 ? (
        <Box>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => {
              setShowEarlier(!showEarlier);
            }}
          >
            {showEarlier ? 'Hide Earlier' : 'Show Earlier'}
          </Button>
        </Box>
      ) : null}
    </Stack>
  );
}

/** The collapsed "Since you last looked" section: the deviations and decisions of the window. */
export function SinceYouLooked({ opened }: { readonly opened: OpenedDigest }) {
  const now = useNow();
  const { data: window, error } = opened;
  const since = window?.since ?? null;
  const counts = window
    ? [
        window.deviations.recent.length > 0
          ? plural(window.deviations.recent.length, 'deviation')
          : null,
        window.decisions.recent.length > 0
          ? plural(window.decisions.recent.length, 'decision')
          : null,
      ].filter((part) => part !== null)
    : [];
  const title =
    since === null
      ? 'Since you last looked'
      : `Since you last looked (${shortAgo(since, now).replace(' ago', '')})`;
  const summary = window ? (counts.length === 0 ? 'nothing new' : counts.join(' · ')) : undefined;
  return (
    <Stack gap="xs">
      {error ? (
        <Alert color="red" title="Couldn't load what changed">
          {error}
        </Alert>
      ) : (
        <Disclosure title={title} {...(summary ? { summary } : {})}>
          {window === undefined ? (
            <Skeleton height={12} width="50%" role="presentation" />
          ) : (
            <Stack gap="xs">
              <DeltaLines
                label="Deviations"
                row={window.deviations}
                line={(d) => <OneLine text={withoutSessionIds(d.summary)} full={d.summary} />}
              />
              <DeltaLines
                label="Decisions"
                row={window.decisions}
                line={(d) => <OneLine text={d.choice} full={`${d.question}\n${d.choice}`} />}
              />
            </Stack>
          )}
        </Disclosure>
      )}
    </Stack>
  );
}

/** The collapsed "About this goal" section: the objective and the criteria, read-only. */
export function AboutGoal({ goal }: { readonly goal: GoalDto }) {
  return (
    <Disclosure title="About this goal" summary="objective, criteria">
      <Stack gap="xs">
        <Zone title="Objective">
          <Text size="sm">{goal.objective}</Text>
          {goal.caresMost ? (
            <Text size="sm" c="dimmed">{`Cares most about: ${goal.caresMost}`}</Text>
          ) : null}
        </Zone>
        <Zone title="Criteria">
          {goal.criteria.length === 0 ? (
            <Text size="sm" c="dimmed">
              None yet.
            </Text>
          ) : (
            <List size="sm" spacing={4}>
              {goal.criteria.map((c) => (
                <List.Item key={c.id}>{c.text}</List.Item>
              ))}
            </List>
          )}
        </Zone>
      </Stack>
    </Disclosure>
  );
}

function costLine(cost: GoalDigestDto['cost']): string {
  const parts = [
    `${formatTokens(cost.tokens)} tokens`,
    plural(cost.sessions, 'session'),
    cost.dollars === null ? null : `$${cost.dollars.toFixed(2)}`,
  ];
  return parts.filter((part) => part !== null).join(' · ');
}

/** The one dimmed line that ends the goal: who works on it and what it has cost. */
export function GoalFooter({ digest }: { readonly digest: GoalDigestDto }) {
  const team = teamLine(digest.team);
  return (
    <Text size="xs" c="dimmed">
      {team === '' ? costLine(digest.cost) : `${team} · ${costLine(digest.cost)}`}
    </Text>
  );
}
