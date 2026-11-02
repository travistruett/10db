import type { GoalDigestDto } from '@10db/contracts';
import { Alert, Box, Button, Group, Progress, Skeleton, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useNow } from '../../shell/relative';
import { formatTokens } from './format-tokens';
import { progressLine } from './goal-status';
import { shortAgo } from './short-ago';
import { StatusDot } from './status-dot';

/** Where the window of changes stands: the daemon's answer to opening the goal. */
export interface OpenedDigest {
  readonly data: GoalDigestDto | undefined;
  readonly error: string | null;
}

const LABEL_WIDTH = '9rem';

function Row({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <Box style={{ display: 'flex', gap: 'var(--mantine-spacing-md)', alignItems: 'baseline' }}>
      <Text component="dt" size="sm" c="dimmed" style={{ flex: `0 0 ${LABEL_WIDTH}` }}>
        {label}
      </Text>
      <Box component="dd" m={0} style={{ flex: 1, minWidth: 0 }}>
        {children}
      </Box>
    </Box>
  );
}

function None() {
  return (
    <Text size="sm" c="dimmed">
      None
    </Text>
  );
}

interface Delta<T> {
  readonly recent: readonly T[];
  readonly earlier: readonly T[];
}

/**
 * A row of what changed: the items in the window, and the rest behind Show Earlier. A row with
 * nothing in either says "None"; while the window is still loading it shows skeleton lines.
 */
function DeltaRow<T>({
  label,
  since,
  row,
  item,
}: {
  readonly label: string;
  readonly since: string | null;
  /** Undefined until the window answers. */
  readonly row: Delta<T> | undefined;
  readonly item: (value: T) => ReactNode;
}) {
  const now = useNow();
  const [showEarlier, setShowEarlier] = useState(false);
  const heading = since === null ? label : `${label} · since ${shortAgo(since, now)}`;
  if (row === undefined) {
    return (
      <Row label={heading}>
        <Skeleton height={12} width="50%" role="presentation" />
      </Row>
    );
  }
  const shown = showEarlier ? [...row.recent, ...row.earlier] : row.recent;
  return (
    <Row label={heading}>
      <Stack gap={2}>
        {shown.length === 0 ? <None /> : null}
        {shown.map((value, index) => (
          <Group key={index} gap={6} wrap="nowrap" align="baseline">
            {item(value)}
          </Group>
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
    </Row>
  );
}

function costLine(cost: GoalDigestDto['cost']): string {
  const parts = [
    `${formatTokens(cost.tokens)} tokens`,
    `${String(cost.sessions)} ${cost.sessions === 1 ? 'session' : 'sessions'}`,
    cost.dollars === null ? null : `$${cost.dollars.toFixed(2)}`,
  ];
  return parts.filter((part) => part !== null).join(' · ');
}

function nextLine(next: NonNullable<GoalDigestDto['next']>): string {
  if (next.waitsOn.length === 0) return next.title;
  const waits = next.waitsOn.map((t) => t.title).join(' and ');
  return `${next.title} when ${waits} ${next.waitsOn.length === 1 ? 'is' : 'are'} done`;
}

export interface GoalDigestProps {
  /** The goal's current state, from the list: every row but the Δ ones is read from it. */
  readonly live: GoalDigestDto;
  /** The window of changes since the last visit, which the Δ rows are read from. */
  readonly opened: OpenedDigest;
}

/** The digest of one goal (§8): progress, who is working, what is next, and what changed since the last visit. */
export function GoalDigest({ live, opened }: GoalDigestProps) {
  const now = useNow();
  const { data: window } = opened;
  const since = window?.since ?? null;
  const total = live.progress.total;
  const pct = total === 0 ? 0 : (live.progress.done / total) * 100;
  // A failed load leaves the Δ rows out rather than showing skeleton lines for ever.
  const failed = opened.error !== null;

  return (
    <Stack gap="xs">
      {opened.error ? (
        <Alert color="red" title="Couldn't load what changed">
          {opened.error}
        </Alert>
      ) : null}
      <Box component="dl" m={0} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Row label="Progress">
          <Group gap="sm" wrap="nowrap">
            <Progress.Root w={160} size="sm">
              <Progress.Section value={pct} aria-label="Tasks done" />
            </Progress.Root>
            <Text size="sm">{progressLine(live)}</Text>
          </Group>
        </Row>
        <Row label="Working now">
          <Stack gap={2}>
            {live.workingNow.length === 0 ? <None /> : null}
            {live.workingNow.map((w) => (
              <Group key={w.workstreamId} gap={6} wrap="nowrap" align="baseline">
                <StatusDot color="blue" />
                <Text size="sm">
                  {`${w.persona} · ${w.model}@${w.effort} · ${w.taskTitle} · step ${String(w.stepNumber)} of ${String(w.stepCount)}`}
                </Text>
              </Group>
            ))}
          </Stack>
        </Row>
        <Row label="Team">
          {live.team.length === 0 ? (
            <None />
          ) : (
            <Text size="sm">{live.team.map((m) => `${m.persona} ${m.model}`).join(' · ')}</Text>
          )}
        </Row>
        {failed ? null : (
          <DeltaRow
            label="Waiting on"
            since={since}
            row={window?.waitingOn}
            item={(w) => (
              <>
                <StatusDot color="yellow" />
                <Text size="sm">{`${w.assigneeName} · ${w.title} · Inbox · ${shortAgo(w.at, now)}`}</Text>
              </>
            )}
          />
        )}
        <Row label="Next">
          {live.next ? <Text size="sm">{nextLine(live.next)}</Text> : <None />}
        </Row>
        {failed ? null : (
          <>
            <DeltaRow
              label="Deviations"
              since={since}
              row={window?.deviations}
              item={(d) => <Text size="sm">{d.summary}</Text>}
            />
            <DeltaRow
              label="Decisions"
              since={since}
              row={window?.decisions}
              item={(d) => (
                <>
                  <Text size="sm">{d.choice}</Text>
                  <Text size="xs" c="dimmed">
                    {d.question}
                  </Text>
                </>
              )}
            />
          </>
        )}
        <Row label="Cost">
          <Text size="sm">{costLine(live.cost)}</Text>
        </Row>
      </Box>
    </Stack>
  );
}
