import type { AccountDto } from '@10db/contracts';
import { Alert, Button, Group, Stack } from '@mantine/core';
import { useState, type SubmitEvent } from 'react';
import { usePatchAccount } from '../../../daemon/account-queries';
import { AccountFields } from './account-fields';
import {
  FORM_ERROR,
  formValuesOf,
  toAccountPatch,
  type AccountFormValues,
} from './account-form-values';

/** An account's editable fields. Save sends only what changed and stays off while nothing has. */
export function EditAccountForm({ account }: { readonly account: AccountDto }) {
  const [values, setValues] = useState<AccountFormValues>(() => formValuesOf(account));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const patchAccount = usePatchAccount(account.id);
  const result = toAccountPatch(account, values);
  const unchanged = result.ok && result.patch === null;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (result.patch === null) return;
    setErrors({});
    try {
      await patchAccount.mutateAsync(result.patch);
    } catch {
      // The mutation's error is shown below.
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <Stack gap="md">
        <AccountFields
          values={values}
          onChange={(next) => {
            setErrors({});
            patchAccount.reset();
            setValues(next);
          }}
          errors={errors}
          mode="edit"
        />
        {errors[FORM_ERROR] ? (
          <Alert color="red" role="alert">
            {errors[FORM_ERROR]}
          </Alert>
        ) : null}
        {patchAccount.isError ? (
          <Alert color="red" role="alert">
            {patchAccount.error.message}
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button size="md" type="submit" disabled={unchanged} loading={patchAccount.isPending}>
            Save changes
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
