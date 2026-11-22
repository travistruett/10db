import { LinearVia, type LinearSignInRowDto } from '@10db/contracts';
import { Alert, Divider, Skeleton, Stack, Text } from '@mantine/core';
import { IconListDetails } from '@tabler/icons-react';
import { useProjects } from '../../../daemon/queries';
import { useLinearSignIns } from '../../../daemon/sign-in-queries';
import { IntegrationCard } from './integration-card';
import { LinearProjectRow } from './project-rows';

/** How one account reaches Linear, as a line: the way, or the words that say how to set it up. */
function lineOf(row: LinearSignInRowDto): string {
  if (row.via === LinearVia.None) return row.note ?? 'No Linear sign-in.';
  const how = row.via === LinearVia.Connector ? 'the claude.ai connector' : 'your Linear server';
  return row.signedIn === false
    ? `Through ${how}; not signed in. ${row.note ?? ''}`.trim()
    : `Agents reach Linear through ${how}.`;
}

/**
 * Settings › Integrations › Linear: how agents reach Linear (one line while the accounts agree, one per
 * account when they differ), then one row per project with its team.
 */
export function LinearCard() {
  const linear = useLinearSignIns();
  const projects = useProjects();
  if (linear.isPending) return <Skeleton height={120} radius="md" />;
  const rows = linear.data?.rows ?? [];
  const lines = rows.map((row) => ({ row, line: lineOf(row) }));
  const agree = new Set(lines.map((l) => l.line)).size <= 1;
  return (
    <IntegrationCard
      mark={<IconListDetails size={20} stroke={1.5} aria-hidden />}
      name="Linear"
      focusName="linear"
      status={null}
      purpose="Reaches Linear through each account's own connection; 10db keeps no Linear key."
      withoutIt="Linear's issues don't come in and results don't go back."
    >
      {linear.isError ? (
        <Alert color="red" title="Couldn't read the Linear sign-ins">
          {linear.error.message}
        </Alert>
      ) : (
        <Stack gap="xs">
          {rows.length === 0 ? (
            <Text size="sm" c="dimmed">
              No account runs agents yet. Add one under Accounts.
            </Text>
          ) : agree ? (
            <Text size="sm" c="dimmed">
              {lines[0]?.line}
            </Text>
          ) : (
            lines.map(({ row, line }) => (
              <Text key={row.accountId} size="sm" c="dimmed">
                {row.accountLabel}: {line}
              </Text>
            ))
          )}
          {(projects.data ?? []).length === 0 ? null : <Divider />}
          {(projects.data ?? []).map((project) => (
            <LinearProjectRow
              key={project.id}
              project={project}
              row={rows.find((r) => r.accountId === project.accountId)}
            />
          ))}
        </Stack>
      )}
    </IntegrationCard>
  );
}
