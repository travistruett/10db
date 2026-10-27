import {
  SUPPORTED_ACCOUNT_KINDS,
  type AccountId,
  type SupportedAccountKind,
} from '@10db/contracts';
import { Alert, Button, Group, Modal, Select, Stack } from '@mantine/core';
import { useState, type SubmitEvent } from 'react';
import { useCreateAccount } from '../../../daemon/account-queries';
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

function AddAccountForm({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (id: AccountId) => void;
}) {
  const [values, setValues] = useState<AccountFormValues>(() =>
    emptyAccountForm(SUPPORTED_ACCOUNT_KINDS[0]),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const create = useCreateAccount();

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = toAccountInput(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    try {
      const created = await create.mutateAsync(result.input);
      onClose();
      onCreated(created.account.id);
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
          description="What pays for the sessions."
          data={KIND_OPTIONS}
          value={values.kind}
          allowDeselect={false}
          onChange={(next) => {
            if (!isSupportedKind(next)) return;
            setErrors({});
            setValues({ ...emptyAccountForm(next), label: values.label, payer: values.payer });
          }}
        />
        <AccountFields values={values} onChange={setValues} errors={errors} mode="create" />
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
            Create
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
}: {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onCreated: (id: AccountId) => void;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Add account"
      size="md"
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <AddAccountForm onClose={onClose} onCreated={onCreated} />
    </Modal>
  );
}
