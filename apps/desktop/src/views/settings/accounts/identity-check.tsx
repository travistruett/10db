import { AccountKind, type AccountDto, type AccountIdentityDto } from '@10db/contracts';
import { Alert, Button, Stack, Text } from '@mantine/core';
import { useCheckAccountIdentity, usePatchAccount } from '../../../daemon/account-queries';

/** What confirming the probe's result would record, and the button's wording. Null: nothing to offer. */
function identityOffer(
  account: AccountDto,
  result: AccountIdentityDto,
): { readonly label: string; readonly value: string; readonly replaces: boolean } | null {
  if (account.kind === AccountKind.ClaudeSubscription) {
    const { email } = result;
    if (email === null || email === account.expectedIdentity) return null;
    return {
      label: `Confirm ${email}`,
      value: email,
      replaces: account.expectedIdentity !== null,
    };
  }
  // A gateway never takes an expected identity; the daemon refuses it.
  if (account.kind === AccountKind.AnthropicApiKey || account.kind === AccountKind.Bedrock) {
    const { organization } = result;
    if (organization === null || account.expectedIdentity !== null) return null;
    return { label: `Require ${organization}`, value: organization, replaces: false };
  }
  return null;
}

/**
 * Runs the identity probe on a click, never on its own: it starts Claude Code. Confirming records
 * exactly what the probe saw for this account.
 */
export function IdentityCheck({ account }: { readonly account: AccountDto }) {
  const check = useCheckAccountIdentity();
  const patch = usePatchAccount(account.id);
  const isSubscription = account.kind === AccountKind.ClaudeSubscription;
  // The result belongs to the account it was read for.
  const result = check.data?.accountId === account.id ? check.data : null;
  const offer = result === null ? null : identityOffer(account, result);
  const refusal = result?.refusal ?? null;

  return (
    <Stack gap="xs">
      <Button
        variant="default"
        loading={check.isPending}
        onClick={() => {
          check.mutate(account.id);
        }}
      >
        {isSubscription ? 'Check sign-in' : 'Check'}
      </Button>
      {check.isPending ? (
        <Text size="sm" c="dimmed">
          Starting Claude Code to read the account…
        </Text>
      ) : null}
      {check.isError ? (
        <Alert color="red" role="alert">
          {check.error.message}
        </Alert>
      ) : null}
      {result === null ? null : (
        <Stack gap="xs">
          {result.email === null ? null : <Text size="sm">Signed in as {result.email}</Text>}
          {result.organization === null ? null : (
            <Text size="sm">Organization: {result.organization}</Text>
          )}
          {refusal === null ? null : (
            <Alert color={refusal.problem === 'unconfirmed' ? 'yellow' : 'red'} role="alert">
              {refusal.message}
            </Alert>
          )}
          {offer === null ? null : (
            <Stack gap={4} align="flex-start">
              <Button
                loading={patch.isPending}
                onClick={() => {
                  patch.mutate(
                    { expectedIdentity: offer.value },
                    {
                      onSuccess: () => {
                        check.reset();
                      },
                    },
                  );
                }}
              >
                {offer.label}
              </Button>
              {offer.replaces ? (
                <Text size="xs" c="dimmed">
                  Sessions on this account will run as {offer.value} from now on.
                </Text>
              ) : null}
            </Stack>
          )}
          {patch.isError ? (
            <Alert color="red" role="alert">
              {patch.error.message}
            </Alert>
          ) : null}
        </Stack>
      )}
    </Stack>
  );
}
