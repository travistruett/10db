import { Button, Stack, Text, Textarea } from '@mantine/core';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { FormModal } from '../../shell/form-modal';

/**
 * Remove and Reject: any choice the act asks first, what it does, then the builder's words. A removal
 * needs a reason, which Past keeps beside the record; rejecting a proposal takes an optional note.
 * The caller mounts it when the builder opens it, so the text starts empty.
 */
export function ReasonDialog({
  title,
  choice,
  intro,
  submitLabel,
  required,
  pending,
  blocked = false,
  error,
  onSubmit,
  onClose,
}: {
  readonly title: string;
  /** A choice that decides what the act does, shown above what it does. */
  readonly choice?: ReactNode;
  /** What the act does to the record. */
  readonly intro: ReactNode;
  readonly submitLabel: string;
  readonly required: boolean;
  readonly pending: boolean;
  /** The act can't be sent yet (something it must show the builder first is still loading). */
  readonly blocked?: boolean;
  readonly error: string | null;
  readonly onSubmit: (reason: string) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (blocked) return;
    if (required && !reason.trim()) {
      setMissing(true);
      return;
    }
    setMissing(false);
    onSubmit(reason.trim());
  };
  return (
    <FormModal
      opened
      onClose={onClose}
      title={title}
      size="md"
      error={missing ? 'Say why.' : error}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} color="red" loading={pending} disabled={blocked}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <Stack gap="sm">
          {choice}
          <Text size="sm">{intro}</Text>
          <Textarea
            label={required ? 'Reason' : 'Note (optional)'}
            data-autofocus
            autosize
            minRows={2}
            value={reason}
            onChange={(e) => {
              setReason(e.currentTarget.value);
            }}
          />
        </Stack>
      </form>
    </FormModal>
  );
}
