import {
  RIGOR_FIGURES_PERIODS,
  type AcceptanceChecking,
  type AcceptanceRow,
  type ProjectId,
  type RigorFiguresPeriod,
} from '@10db/contracts';
import { Alert, Anchor, Loader, SegmentedControl, Stack, Table, Text, Title } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAcceptanceFigures } from '../../daemon/acceptance-queries';
import { RaisedPanel } from '../../shell/raised-panel';

/** Why acceptance isn't checking, shown under the counts. */
function notCheckingLine(checking: AcceptanceChecking): string | null {
  if (checking.on) return null;
  return checking.reason === 'no_account'
    ? "Acceptance isn't checking: no account can answer decisions"
    : "Acceptance isn't checking: it's off in Settings";
}

function periodOf(value: string): RigorFiguresPeriod | null {
  return RIGOR_FIGURES_PERIODS.find((p) => String(p) === value) ?? null;
}

const when = (iso: string): string => new Date(iso).toLocaleString();

/** One count with the newest runs behind it; a row opens its task on the Board. */
function RunList({
  label,
  count,
  rows,
}: {
  readonly label: string;
  readonly count: number;
  readonly rows: readonly AcceptanceRow[];
}) {
  const navigate = useNavigate();
  return (
    <Stack gap={4}>
      <Title order={4}>{`${label} ${String(count)}`}</Title>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          None in this period
        </Text>
      ) : (
        <RaisedPanel>
          <Table aria-label={`${label} runs`}>
            <Table.Tbody>
              {rows.map((row, i) => (
                <Table.Tr key={`${row.taskId}-${row.at}-${String(i)}`}>
                  <Table.Td>
                    <Anchor
                      component="button"
                      type="button"
                      size="sm"
                      onClick={() => {
                        void navigate({ to: '/board', search: { task: row.taskId } });
                      }}
                    >
                      {row.title}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{row.by === undefined ? '' : `by ${row.by}`}</Table.Td>
                  <Table.Td>{when(row.at)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </RaisedPanel>
      )}
    </Stack>
  );
}

/**
 * What acceptance did over a period: tasks that finished with nothing to ask, runs a check sent back
 * (acceptance, review or QA), and acceptance cards that came to the builder.
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
          <RunList
            label="Completed"
            count={figures.data.completed}
            rows={figures.data.rows.completed}
          />
          <RunList
            label="Sent back"
            count={figures.data.sentBack}
            rows={figures.data.rows.sentBack}
          />
          <RunList
            label="Sent to you"
            count={figures.data.sentToYou}
            rows={figures.data.rows.sentToYou}
          />
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
