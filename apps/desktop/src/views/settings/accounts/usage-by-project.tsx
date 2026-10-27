import type { AccountId } from '@10db/contracts';
import { Group, Skeleton, Stack, Table, Text } from '@mantine/core';
import { useAccountUsage } from '../../../daemon/account-queries';
import { formatTokens, formatUsd, monthLabel } from './usage-text';

/** The daemon's current month on one account, in total and per project. */
export function UsageByProject({ accountId }: { readonly accountId: AccountId }) {
  const usage = useAccountUsage(accountId);
  if (usage.isPending) return <Skeleton h={48} aria-label="Loading usage" />;
  if (usage.isError) return <Text c="dimmed">Usage unavailable</Text>;
  const { month, total, byProject } = usage.data;
  const metered = total.costUsd !== null;
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={500}>{monthLabel(month)}</Text>
        <Text size="sm" c="dimmed">
          {formatTokens(total.tokensIn + total.tokensOut)} tokens
          {total.costUsd === null ? '' : ` · ${formatUsd(total.costUsd)}`}
        </Text>
      </Group>
      {byProject.length === 0 ? (
        <Text size="sm" c="dimmed">
          No sessions this month
        </Text>
      ) : (
        <Table aria-label="Usage by project" verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Project</Table.Th>
              <Table.Th ta="right">In</Table.Th>
              <Table.Th ta="right">Out</Table.Th>
              <Table.Th ta="right">Cached</Table.Th>
              {metered ? <Table.Th ta="right">Cost</Table.Th> : null}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {byProject.map((p) => (
              <Table.Tr key={p.projectId}>
                <Table.Td>{p.projectName}</Table.Td>
                <Table.Td ta="right">{formatTokens(p.tokensIn)}</Table.Td>
                <Table.Td ta="right">{formatTokens(p.tokensOut)}</Table.Td>
                <Table.Td ta="right">{formatTokens(p.tokensCached)}</Table.Td>
                {metered ? (
                  <Table.Td ta="right">{p.costUsd === null ? '' : formatUsd(p.costUsd)}</Table.Td>
                ) : null}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
