import type { HumanTouchDayDto, ProjectId } from '@10db/contracts';
import { Alert, Stack, Table, Text, Title } from '@mantine/core';
import { useHumanTouch } from '../../daemon/human-touch-queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';

/** "Nov 3" for a `YYYY-MM-DD` UTC day, the way the daemon cut it. */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** One decimal, none when whole; a dash for a day no task ran. */
function perTask(value: number | null): string {
  return value === null ? '–' : String(Number(value.toFixed(1)));
}

/** The table's scroll width, kept by its placeholder. */
const TABLE_MIN_WIDTH = 720;

const COLUMNS = [
  'Day',
  'Permission',
  'Question',
  'Workstream failed',
  'Other flag',
  'Proposal',
  'Review',
  'Check',
  'Plan',
  'Move report',
  'Acceptance',
  'Look',
  'Cards',
  'Per task',
  'Waited on an answer',
  'Waited on a retry',
] as const;

function DayRow({ day }: { readonly day: HumanTouchDayDto }) {
  return (
    <Table.Tr>
      <Table.Td>{dayLabel(day.day)}</Table.Td>
      <Table.Td>{day.permission}</Table.Td>
      <Table.Td>{day.question}</Table.Td>
      <Table.Td>{day.workstreamFailed}</Table.Td>
      <Table.Td>{day.flag}</Table.Td>
      <Table.Td>{day.proposal}</Table.Td>
      <Table.Td>{day.review}</Table.Td>
      <Table.Td>{day.check}</Table.Td>
      <Table.Td>{day.plan}</Table.Td>
      <Table.Td>{day.moveReport}</Table.Td>
      <Table.Td>{day.acceptance}</Table.Td>
      <Table.Td>{day.watchpoint}</Table.Td>
      <Table.Td>{day.cards}</Table.Td>
      <Table.Td>{perTask(day.cardsPerTask)}</Table.Td>
      <Table.Td>{`${String(Math.round(day.waitingMinutes))} min`}</Table.Td>
      <Table.Td>{`${String(Math.round(day.failedMinutes))} min`}</Table.Td>
    </Table.Tr>
  );
}

/**
 * How often a person was needed, per day for the last 14: the Inbox cards raised by kind, the cards per
 * task that ran, the minutes work waited on an answer, and the minutes a failed run waited for a retry
 * (apart, so each figure says one thing). Days are UTC days, today first.
 */
export function HumanTouchPanel({ projectId }: { readonly projectId: ProjectId | null }) {
  const touch = useHumanTouch(projectId);
  return (
    <Stack gap="xs">
      <Title order={3}>Human Touch</Title>
      <Text size="sm" c="dimmed">
        Cards raised each day, cards per task that ran, minutes work waited on an answer, and
        minutes a failed run waited for a retry, counted apart (UTC days)
      </Text>
      {touch.isError ? (
        <Alert color="red" title="Couldn't load how often a person was needed">
          {touch.error.message}
        </Alert>
      ) : null}
      {touch.isLoading ? (
        <PageLoading
          shape={PageLoadingShape.Table}
          label="Loading human touch"
          columns={COLUMNS.map((title) => ({ title }))}
          rows={7}
          minWidth={TABLE_MIN_WIDTH}
        />
      ) : null}
      {touch.isSuccess ? (
        <RaisedPanel>
          <Table.ScrollContainer minWidth={TABLE_MIN_WIDTH}>
            <Table aria-label="How often a person was needed">
              <Table.Thead>
                <Table.Tr>
                  {COLUMNS.map((name) => (
                    <Table.Th key={name}>{name}</Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {touch.data.days.map((day) => (
                  <DayRow key={day.day} day={day} />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </RaisedPanel>
      ) : null}
    </Stack>
  );
}
