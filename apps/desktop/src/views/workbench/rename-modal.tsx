import { PassRename, type PassDto } from '@10db/contracts';
import { Button, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { FormModal } from '../../shell/form-modal';

export interface RenameModalProps {
  readonly pass: PassDto;
  readonly onClose: () => void;
  /** Renames the pass: `PATCH /passes/:passId`. */
  readonly rename: (body: PassRename) => Promise<unknown>;
}

/** Rename, from the pass header's menu: the pass's name, saved trimmed. */
export function RenameModal({ pass, onClose, rename }: RenameModalProps) {
  const [name, setName] = useState(pass.name);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const saving = useMutation({
    mutationFn: (body: PassRename) => rename(body),
    onSuccess: onClose,
  });
  const submit = () => {
    const body = PassRename.safeParse({ name: name.trim() });
    if (!body.success) {
      setFieldError(name.trim() === '' ? 'Enter a name' : 'A name is one line of text');
      return;
    }
    setFieldError(null);
    saving.mutate(body.data);
  };
  return (
    <FormModal
      opened
      onClose={onClose}
      title="Rename"
      size="md"
      error={saving.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving.isPending} onClick={submit}>
            Rename
          </Button>
        </>
      }
    >
      <TextInput
        label="Name"
        data-autofocus
        value={name}
        error={fieldError}
        onChange={(event) => {
          setName(event.currentTarget.value);
          setFieldError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
      />
    </FormModal>
  );
}
