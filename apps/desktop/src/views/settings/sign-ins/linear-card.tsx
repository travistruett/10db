import { LinearVia, type LinearSignInRowDto } from '@10db/contracts';
import { Alert, Skeleton, Stack, Text } from '@mantine/core';
import { IconListDetails } from '@tabler/icons-react';
import { useLinearSignIns } from '../../../daemon/sign-in-queries';
import { ConnectionStatus, ConnectionTone } from '../connection-status';
import { IntegrationCard } from './integration-card';

function RowStatus({ row }: { readonly row: LinearSignInRowDto }) {
  if (row.via === LinearVia.None)
    return <ConnectionStatus tone={ConnectionTone.Off} label="Not set up" />;
  const how = row.via === LinearVia.Connector ? 'claude.ai connector' : 'your server';
  if (row.signedIn === false)
    return <ConnectionStatus tone={ConnectionTone.NeedsYou} label={`Not signed in · ${how}`} />;
  return <ConnectionStatus tone={ConnectionTone.Works} label={`Through ${how}`} />;
}

/** Settings › Sign-ins › Linear: one line per agent account saying how it reaches Linear, or how to set that up. */
export function LinearCard() {
  const linear = useLinearSignIns();
  if (linear.isPending) return <Skeleton height={120} radius="md" />;
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
          {linear.data.rows.length === 0 ? (
            <Text size="sm" c="dimmed">
              No account runs agents yet. Add one under Accounts.
            </Text>
          ) : null}
          {linear.data.rows.map((row) => (
            <Stack key={row.accountId} gap={2}>
              <Text size="sm" fw={500}>
                {row.accountLabel}
              </Text>
              <RowStatus row={row} />
              {row.note === null ? null : (
                <Text size="xs" c="dimmed">
                  {row.note}
                </Text>
              )}
            </Stack>
          ))}
        </Stack>
      )}
    </IntegrationCard>
  );
}
