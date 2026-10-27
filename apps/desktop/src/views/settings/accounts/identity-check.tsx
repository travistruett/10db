import {
  AccountKind,
  AccountProblem,
  type AccountDto,
  type AccountIdentityDto,
} from '@10db/contracts';
import { Alert, Button, Stack, Text } from '@mantine/core';
import { useCheckAccountIdentity, usePatchAccount } from '../../../daemon/account-queries';

interface Offer {
  readonly label: string;
  readonly value: string;
  /** Set when confirming replaces a different recorded identity. */
  readonly replaces: boolean;
}

/**
 * What confirming the probe's result would record. It follows the daemon's refusal, never a local
 * comparison: only a refusal that waits on the builder's say-so (unconfirmed, or a different login)
 * offers its seen identity. Null: nothing to offer.
 */
function identityOffer(account: AccountDto, result: AccountIdentityDto): Offer | null {
  const { refusal } = result;
  if (account.kind === AccountKind.ClaudeSubscription) {
    if (refusal?.seenIdentity == null) return null;
    if (refusal.problem === AccountProblem.Unconfirmed)
      return {
        label: `Confirm ${refusal.seenIdentity}`,
        value: refusal.seenIdentity,
        replaces: false,
      };
    if (refusal.problem === AccountProblem.IdentityMismatch)
      return {
        label: `Confirm ${refusal.seenIdentity}`,
        value: refusal.seenIdentity,
        replaces: account.expectedIdentity !== null,
      };
    return null;
  }
  // A gateway never takes an expected identity; the daemon refuses it.
  if (account.kind === AccountKind.AnthropicApiKey || account.kind === AccountKind.Bedrock) {
    const { organization } = result;
    if (refusal !== null || organization === null || account.expectedIdentity !== null) return null;
    return { label: `Require ${organization}`, value: organization, replaces: false };
  }
  return null;
}

/** Waiting on the builder is yellow; a refusal that needs a fix is red. */
function refusalColor(problem: AccountProblem): 'yellow' | 'red' {
  switch (problem) {
    case AccountProblem.Unconfirmed:
    case AccountProblem.SignedOut:
    case AccountProblem.SecretMissing:
    case AccountProblem.KeychainUnavailable:
      return 'yellow';
    case AccountProblem.IdentityMismatch:
    case AccountProblem.WrongCredentials:
    case AccountProblem.SecretChanged:
    case AccountProblem.CannotBill:
      return 'red';
  }
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
        size="md"
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
            <Alert color={refusalColor(refusal.problem)} role="alert">
              {refusal.message}
            </Alert>
          )}
          {offer === null ? null : (
            <Stack gap={4} align="flex-start">
              <Button
                size="md"
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
