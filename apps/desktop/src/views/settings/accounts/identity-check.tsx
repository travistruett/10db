import {
  AccountKind,
  AccountProblem,
  signsInWithLogin,
  type AccountDto,
  type AccountIdentityDto,
} from '@10db/contracts';
import { Alert, Button, Stack, Text } from '@mantine/core';
import { useEffect } from 'react';
import { useCheckAccountIdentity, usePatchAccount } from '../../../daemon/account-queries';

interface Offer {
  readonly label: 'Confirm' | 'Require';
  readonly value: string;
  /** What confirming means. An identity can be long, so it is here and never on the button. */
  readonly effect: string;
}

/** A workspace ID or organization has no spaces to wrap at. */
const WRAP_ANYWHERE = { overflowWrap: 'anywhere' } as const;

/**
 * What confirming the probe's result would record. It follows the daemon's refusal, never a local
 * comparison: only a refusal that waits on the builder's say-so (unconfirmed, or a different login)
 * offers its seen identity. Null: nothing to offer.
 */
function identityOffer(account: AccountDto, result: AccountIdentityDto): Offer | null {
  const { refusal } = result;
  if (signsInWithLogin(account.kind)) {
    if (refusal?.seenIdentity == null) return null;
    if (refusal.problem === AccountProblem.Unconfirmed)
      return {
        label: 'Confirm',
        value: refusal.seenIdentity,
        effect: `Sessions on this account will run as ${refusal.seenIdentity}.`,
      };
    if (refusal.problem === AccountProblem.IdentityMismatch)
      return {
        label: 'Confirm',
        value: refusal.seenIdentity,
        effect:
          account.expectedIdentity === null
            ? `Sessions on this account will run as ${refusal.seenIdentity}.`
            : `Sessions on this account will run as ${refusal.seenIdentity} from now on.`,
      };
    return null;
  }
  // A gateway never takes an expected identity; the daemon refuses it.
  if (account.kind === AccountKind.AnthropicApiKey || account.kind === AccountKind.Bedrock) {
    const { organization } = result;
    if (refusal !== null || organization === null || account.expectedIdentity !== null) return null;
    return {
      label: 'Require',
      value: organization,
      effect: `Sessions on this account must report ${organization}.`,
    };
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
    case AccountProblem.StartTimeout:
      return 'yellow';
    case AccountProblem.IdentityMismatch:
    case AccountProblem.WrongCredentials:
    case AccountProblem.SecretChanged:
    case AccountProblem.CannotBill:
      return 'red';
  }
}

/**
 * Runs the identity probe on a click or when a browser sign-in has just finished, never otherwise: it starts Claude Code or Codex. Confirming records
 * exactly what the probe saw for this account.
 */
export function IdentityCheck({
  account,
  checkRequests = 0,
}: {
  readonly account: AccountDto;
  /** Counts the sign-ins that just finished; each increase runs the check, as a click would. */
  readonly checkRequests?: number;
}) {
  const check = useCheckAccountIdentity();
  const patch = usePatchAccount(account.id);
  const isSubscription = signsInWithLogin(account.kind);
  // The result belongs to the account it was read for.
  const result = check.data?.accountId === account.id ? check.data : null;
  const offer = result === null ? null : identityOffer(account, result);
  const refusal = result?.refusal ?? null;
  const { mutate: runCheck } = check;
  useEffect(() => {
    if (checkRequests > 0) runCheck(account.id);
  }, [checkRequests, account.id, runCheck]);

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
          Starting {account.kind === AccountKind.CodexSignin ? 'Codex' : 'Claude Code'} to read the
          account…
        </Text>
      ) : null}
      {check.isError ? (
        <Alert color="red" role="alert">
          {check.error.message}
        </Alert>
      ) : null}
      {result === null ? null : (
        <Stack gap="xs">
          {result.email === null ? null : (
            <Text size="sm" style={WRAP_ANYWHERE}>
              Signed in as {result.email}
            </Text>
          )}
          {result.organization === null ? null : (
            <Text size="sm" style={WRAP_ANYWHERE}>
              {account.kind === AccountKind.CodexSignin ? 'Workspace' : 'Organization'}:{' '}
              {result.organization}
            </Text>
          )}
          {result.models.length === 0 ? null : (
            <Stack gap={2}>
              <Text size="sm">Models this account offers</Text>
              {result.models.map((model) => (
                <Text key={model} size="sm" c="dimmed">
                  {model}
                </Text>
              ))}
            </Stack>
          )}
          {refusal === null ? null : (
            <Alert color={refusalColor(refusal.problem)} role="alert">
              {refusal.message}
            </Alert>
          )}
          {offer === null ? null : (
            <Stack gap={4} align="flex-start">
              <Text size="sm" style={WRAP_ANYWHERE}>
                {offer.effect}
              </Text>
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
