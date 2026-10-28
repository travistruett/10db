import {
  AccountKind,
  AccountSecretInput,
  type AccountDto,
  type SupportedAccountKind,
} from '@10db/contracts';
import { Alert, Badge, Button, Stack, Text, TextInput } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { ZodError } from 'zod';
import { accountKeys } from '../../../daemon/account-queries';
import { sendAccountSecret } from '../../../daemon/account-secret';
import { DaemonRequestError } from '../../../daemon/client';
import { useDaemon } from '../../../daemon/provider';

/** All the form keeps: where the request is, never the secret itself. */
type SecretFormState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'failed'; readonly message: string };

const UNREACHABLE = "Couldn't reach the daemon; paste the secret again to retry";
const NOT_UNDERSTOOD =
  "The daemon answered in a form this version of 10db doesn't understand; check the badge before pasting again.";

function failureMessage(error: unknown): string {
  if (error instanceof DaemonRequestError) return error.message;
  // The answer arrived but failed its schema: the Keychain write may still have happened.
  if (error instanceof ZodError) return NOT_UNDERSTOOD;
  return UNREACHABLE;
}

function secretLabel(kind: SupportedAccountKind): string {
  switch (kind) {
    case AccountKind.AnthropicApiKey:
      return 'API key';
    case AccountKind.Gateway:
      return 'Gateway token';
    case AccountKind.Bedrock:
      return 'Bedrock bearer token';
    case AccountKind.ClaudeSubscription:
      return 'Secret';
  }
}

/**
 * A write-only field for a keyed account's secret. It is uncontrolled and read once from the form on
 * submit, then cleared before anything is awaited, so the value lives only in the local that the
 * request uses. It is sent outside TanStack Query and never shown again.
 */
export function SecretForm({ account }: { readonly account: AccountDto }) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const [state, setState] = useState<SecretFormState>({ kind: 'idle' });

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const entered = new FormData(form).get('secret');
    form.reset();
    // reset() restores the default without going through the value setter, so React DOM's own copy of
    // the last value (its value tracker) would keep the secret; setting the property replaces it.
    const field = form.elements.namedItem('secret');
    if (field instanceof HTMLInputElement) field.value = '';
    // A second submit while one is in flight is dropped, after its field has been cleared too.
    if (state.kind === 'saving') return;
    const parsed = AccountSecretInput.safeParse({
      secret: typeof entered === 'string' ? entered : '',
    });
    if (!parsed.success) {
      setState({
        kind: 'failed',
        message: parsed.error.issues[0]?.message ?? 'Not a valid secret',
      });
      return;
    }
    setState({ kind: 'saving' });
    try {
      await sendAccountSecret(client, account.id, parsed.data);
      setState({ kind: 'saved' });
    } catch (error) {
      setState({ kind: 'failed', message: failureMessage(error) });
    } finally {
      // The daemon may have written the secret even when its answer was unusable.
      await queryClient.invalidateQueries({ queryKey: accountKeys.all });
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <Stack gap="xs" align="flex-start">
        {account.secretSet ? (
          <Badge color="green">Secret set</Badge>
        ) : (
          <Badge color="yellow">No secret yet</Badge>
        )}
        <TextInput
          w="100%"
          size="md"
          type="password"
          name="secret"
          label={secretLabel(account.kind)}
          description="Stored in your login Keychain, never in 10db's database. It can't be shown again; paste it again to replace it."
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
        />
        {state.kind === 'saved' ? (
          <Text size="sm">Secret saved to your login Keychain.</Text>
        ) : null}
        {state.kind === 'failed' ? (
          <Alert color="red" role="alert" w="100%">
            {state.message}
          </Alert>
        ) : null}
        <Button type="submit" size="md" loading={state.kind === 'saving'}>
          {account.secretSet ? 'Replace secret' : 'Save secret'}
        </Button>
      </Stack>
    </form>
  );
}
