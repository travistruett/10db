import { RIGOR_FIGURES_PERIODS, type ProjectId, type RigorFiguresPeriod } from '@10db/contracts';
import { Alert, Loader, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useAcceptanceFigures } from '../../daemon/acceptance-queries';
import { notCheckingLine } from '../board/acceptance-line';

function periodOf(value: string): RigorFiguresPeriod | null {
  return RIGOR_FIGURES_PERIODS.find((p) => String(p) === value) ?? null;
}

/**
 * What acceptance did over a period: tasks that finished with nothing to ask, runs a check sent back
 * (acceptance, review or QA), and acceptance cards that came to the builder. The Board's counts link here.
 */
export function AcceptancePanel({ projectId }: { readonly projectId: ProjectId | null }) {
  const [days, setDays] = useState<RigorFiguresPeriod>(7);
  const figures = useAcceptanceFigures(projectId, days);
  const notChecking = figures.isSuccess ? notCheckingLine(figures.data.checking) : null;
  return (
    <Stack gap="xs">
      <Title order={3}>Acceptance</Title>
      <Text size="sm" c="dimmed">
        Whether each finished task did what its criteria asked
      </Text>
      <SegmentedControl
        size="xs"
        w="fit-content"
        aria-label="Acceptance period"
        data={RIGOR_FIGURES_PERIODS.map((p) => ({ value: String(p), label: `${String(p)} days` }))}
        value={String(days)}
        onChange={(value) => {
          const next = periodOf(value);
          if (next !== null) setDays(next);
        }}
      />
      {figures.isError ? (
        <Alert color="red" title="Couldn't load the acceptance counts">
          {figures.error.message}
        </Alert>
      ) : null}
      {figures.isLoading ? <Loader size="sm" aria-label="Loading acceptance counts" /> : null}
      {figures.isSuccess ? (
        <>
          <Table aria-label="Acceptance counts" striped withTableBorder>
            <Table.Tbody>
              <Table.Tr>
                <Table.Th>Completed</Table.Th>
                <Table.Td>{figures.data.completed}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Sent back</Table.Th>
                <Table.Td>{figures.data.sentBack}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Sent to you</Table.Th>
                <Table.Td>{figures.data.sentToYou}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
          {notChecking === null ? null : (
            <Text size="sm" c="dimmed">
              {notChecking}
            </Text>
          )}
        </>
      ) : null}
    </Stack>
  );
}
