import { Button, Stack, Text, Textarea } from '@mantine/core';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { FormModal } from '../../shell/form-modal';

/**
 * Retire, Withdraw and Reject: what the act does, then the builder's words. A retire and a withdrawal
 * need a reason, which History keeps beside the record; rejecting a proposal takes an optional note.
 * The caller mounts it when the builder opens it, so the text starts empty.
 */
export function ReasonDialog({
  title,
  intro,
  submitLabel,
  required,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  readonly title: string;
  /** What the act does to the record. */
  readonly intro: ReactNode;
  readonly submitLabel: string;
  readonly required: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (reason: string) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
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
          <Button type="submit" form={formId} color="red" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <Stack gap="sm">
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
