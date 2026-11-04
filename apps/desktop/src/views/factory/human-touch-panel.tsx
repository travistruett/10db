import type { HumanTouchDayDto, ProjectId } from '@10db/contracts';
import { Alert, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useHumanTouch } from '../../daemon/human-touch-queries';

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

const COLUMNS = [
  'Day',
  'Permission',
  'Question',
  'Workstream failed',
  'Other flag',
  'Proposal',
  'Review',
  'Check',
  'Cards',
  'Per task',
  'Waited',
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
      <Table.Td>{day.cards}</Table.Td>
      <Table.Td>{perTask(day.cardsPerTask)}</Table.Td>
      <Table.Td>{`${String(Math.round(day.waitingMinutes))} min`}</Table.Td>
    </Table.Tr>
  );
}

/**
 * How often a person was needed, per day for the last 14: the Inbox cards raised by kind, the cards per
 * task that ran, and the minutes work waited on an answer. Days are UTC days, today first.
 */
export function HumanTouchPanel({ projectId }: { readonly projectId: ProjectId | null }) {
  const touch = useHumanTouch(projectId);
  return (
    <Stack gap="xs">
      <Title order={3}>Human touch</Title>
      <Text size="sm" c="dimmed">
        Cards raised each day, cards per task that ran, and minutes work waited on an answer (UTC
        days)
      </Text>
      {touch.isError ? (
        <Alert color="red" title="Couldn't load how often a person was needed">
          {touch.error.message}
        </Alert>
      ) : null}
      {touch.isLoading ? <Loader size="sm" aria-label="Loading human touch" /> : null}
      {touch.isSuccess ? (
        <Table.ScrollContainer minWidth={720}>
          <Table aria-label="How often a person was needed" striped withTableBorder>
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
      ) : null}
    </Stack>
  );
}
