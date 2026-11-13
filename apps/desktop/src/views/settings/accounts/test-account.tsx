import type { AccountDto } from '@10db/contracts';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { DaemonRequestError } from '../../../daemon/client';
import { useTestAccount } from '../../../daemon/judge-queries';

/** One tiny call with the account's own key; a refusal is an answer shown beside the button, not an error page. */
export function TestAccount({ account }: { readonly account: AccountDto }) {
  const test = useTestAccount(account.id);
  const result = test.data;
  return (
    <Stack gap="xs" align="flex-start">
      <Group gap="sm">
        <Button
          variant="default"
          loading={test.isPending}
          disabled={!account.secretSet}
          onClick={() => {
            test.mutate();
          }}
        >
          Test
        </Button>
        {result?.ok === true ? (
          <Text size="sm">
            Works · {Math.round(result.latencyMs)} ms
            {result.costUsd === null ? '' : ` · $${result.costUsd.toFixed(4)}`}
          </Text>
        ) : null}
      </Group>
      {result?.ok === false ? (
        <Alert color="red" role="alert">
          {result.error}
        </Alert>
      ) : null}
      {test.error ? (
        <Alert color="red" role="alert">
          {test.error instanceof DaemonRequestError
            ? test.error.message
            : "Couldn't reach the daemon."}
        </Alert>
      ) : null}
    </Stack>
  );
}
