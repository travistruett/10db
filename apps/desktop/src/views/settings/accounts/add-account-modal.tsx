import {
  AccountKind,
  AccountSecretInput,
  SUPPORTED_ACCOUNT_KINDS,
  type AccountId,
  type SupportedAccountKind,
} from '@10db/contracts';
import { Alert, Button, Checkbox, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { accountKeys, useCreateAccount } from '../../../daemon/account-queries';
import { sendAccountSecret } from '../../../daemon/account-secret';
import { DaemonRequestError } from '../../../daemon/client';
import { useJudgeStatus, usePatchJudge } from '../../../daemon/judge-queries';
import { useDaemon } from '../../../daemon/provider';
import { ACCOUNT_KIND_LABEL } from '../account-kind-label';
import { AccountFields } from './account-fields';
import {
  emptyAccountForm,
  FORM_ERROR,
  toAccountInput,
  type AccountFormValues,
} from './account-form-values';

const KIND_OPTIONS = SUPPORTED_ACCOUNT_KINDS.map((kind) => ({
  value: kind,
  label: ACCOUNT_KIND_LABEL[kind],
}));

function isSupportedKind(value: string | null): value is SupportedAccountKind {
  return SUPPORTED_ACCOUNT_KINDS.some((kind) => kind === value);
}

const KEY_FIELD = 'secret';

/** Why a step after the account was made failed, in words the builder can act on. */
function stepFailure(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : "Couldn't reach the daemon";
}

function AddAccountForm({
  onClose,
  onCreated,
  initialKind,
}: {
  readonly onClose: () => void;
  readonly onCreated: (id: AccountId) => void;
  readonly initialKind: SupportedAccountKind;
}) {
  const [values, setValues] = useState<AccountFormValues>(() => emptyAccountForm(initialKind));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const create = useCreateAccount();
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const judge = useJudgeStatus();
  const patchJudge = usePatchJudge();
  // Null until the builder touches the box: it then follows whether decisions run on an account yet.
  const [runDecisions, setRunDecisions] = useState<boolean | null>(null);
  const [made, setMade] = useState<{ readonly id: AccountId; readonly problem: string } | null>(
    null,
  );
  const isRouter = values.kind === AccountKind.OpenRouter;
  const runsDecisions = runDecisions ?? judge.data?.account === null;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (made !== null) {
      onClose();
      onCreated(made.id);
      return;
    }
    // The key is read once and the field cleared before anything is awaited, so it lives only in this local.
    const form = event.currentTarget;
    const entered = isRouter ? new FormData(form).get(KEY_FIELD) : null;
    if (isRouter) {
      form.reset();
      const field = form.elements.namedItem(KEY_FIELD);
      if (field instanceof HTMLInputElement) field.value = '';
    }
    const result = toAccountInput(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const secret = isRouter
      ? AccountSecretInput.safeParse({ secret: typeof entered === 'string' ? entered.trim() : '' })
      : null;
    if (secret !== null && !secret.success) {
      setErrors({ [FORM_ERROR]: secret.error.issues[0]?.message ?? 'Enter the key' });
      return;
    }
    setErrors({});
    try {
      const created = await create.mutateAsync(result.input);
      const id = created.account.id;
      if (secret?.success === true) {
        let problem: string | null = null;
        try {
          await sendAccountSecret(client, id, secret.data);
        } catch (error) {
          problem = `The account was made, but its key wasn't saved: ${stepFailure(error)}`;
        }
        if (problem === null && runsDecisions) {
          try {
            await patchJudge.mutateAsync({ accountId: id });
          } catch (error) {
            problem = `The account was made and its key was saved, but decisions weren't switched to it: ${stepFailure(error)}`;
          }
        }
        await queryClient.invalidateQueries({ queryKey: accountKeys.all });
        if (problem !== null) {
          setMade({ id, problem });
          return;
        }
      }
      onClose();
      onCreated(id);
    } catch {
      // The mutation's error is shown below.
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Stack gap="md">
        <Select
          size="md"
          label="Kind"
          description={
            values.kind === AccountKind.OpenRouter
              ? "Pays for decisions. Can't run agents yet."
              : 'What pays for the sessions.'
          }
          data={KIND_OPTIONS}
          value={values.kind}
          allowDeselect={false}
          onChange={(next) => {
            if (!isSupportedKind(next)) return;
            setErrors({});
            setValues({ ...emptyAccountForm(next), label: values.label, payer: values.payer });
          }}
        />
        <AccountFields
          values={values}
          onChange={setValues}
          errors={errors}
          mode="create"
          accountId={null}
        />
        {isRouter ? (
          <>
            <TextInput
              size="md"
              type="password"
              name={KEY_FIELD}
              label="OpenRouter key"
              placeholder="sk-or-..."
              description="Stored in your login Keychain, never in 10db's database. It can't be shown again."
              autoComplete="new-password"
              spellCheck={false}
              autoCapitalize="off"
            />
            <Checkbox
              label="Run decisions on this account"
              checked={runsDecisions}
              onChange={(event) => {
                setRunDecisions(event.currentTarget.checked);
              }}
            />
          </>
        ) : null}
        {made !== null ? (
          <Alert color="red" role="alert">
            {made.problem}
          </Alert>
        ) : null}
        {errors[FORM_ERROR] ? (
          <Alert color="red" role="alert">
            {errors[FORM_ERROR]}
          </Alert>
        ) : null}
        {create.isError ? (
          <Alert color="red" role="alert">
            {create.error.message}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button size="md" variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" type="submit" loading={create.isPending}>
            {made === null ? 'Create' : 'Open Account'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** Adds an account of any supported kind; `onCreated` receives the new account's id once the modal closes. */
export function AddAccountModal({
  opened,
  onClose,
  onCreated,
  initialKind = SUPPORTED_ACCOUNT_KINDS[0],
}: {
  readonly opened: boolean;
  /** The kind the form starts on. */
  readonly initialKind?: SupportedAccountKind;
  readonly onClose: () => void;
  readonly onCreated: (id: AccountId) => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Add Account"
      size="md"
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <AddAccountForm onClose={onClose} onCreated={onCreated} initialKind={initialKind} />
    </Modal>
  );
}
