import { Alert, Button, Checkbox, Group, Modal, ScrollArea, Stack, TextInput } from '@mantine/core';
import { useState } from 'react';

export interface CommitModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** The session's title: the message starts as it. */
  readonly defaultMessage: string;
  /** Every changed file, and the ones to start checked. */
  readonly files: readonly string[];
  readonly checked: readonly string[];
  /** The files are still being read. */
  readonly loading: boolean;
  readonly pending: boolean;
  /** The commit is sent but waits for the session's own turn to end. */
  readonly waitsForTurn: boolean;
  readonly error: string | null;
  readonly onCommit: (message: string, paths: readonly string[]) => void;
}

/** The message and the files for Commit… (sessions spec §4.6): the files the session touched are checked. */
export function CommitModal({
  opened,
  onClose,
  defaultMessage,
  files,
  checked,
  loading,
  pending,
  waitsForTurn,
  error,
  onCommit,
}: CommitModalProps) {
  const [message, setMessage] = useState(defaultMessage);
  // The builder's own ticks; until there are any, the files the session touched are the ones checked.
  const [ticked, setTicked] = useState<ReadonlySet<string> | null>(null);
  const picked = ticked ?? new Set(checked);
  const paths = files.filter((path) => picked.has(path));
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Commit"
      centered
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (message.trim() !== '' && paths.length > 0) onCommit(message.trim(), paths);
        }}
      >
        <Stack gap="sm">
          <TextInput
            label="Message"
            data-autofocus
            value={message}
            onChange={(event) => {
              setMessage(event.currentTarget.value);
            }}
          />
          <Checkbox.Group
            label="Files"
            value={paths}
            onChange={(next) => {
              setTicked(new Set(next));
            }}
          >
            <ScrollArea.Autosize mah={240}>
              <Stack gap={6} pt={4}>
                {files.map((path) => (
                  <Checkbox key={path} value={path} label={path} size="xs" />
                ))}
                {files.length === 0 && !loading ? 'No changed files.' : null}
              </Stack>
            </ScrollArea.Autosize>
          </Checkbox.Group>
          {error === null ? null : (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={pending}
              disabled={message.trim() === '' || paths.length === 0}
            >
              {waitsForTurn ? 'Waits for the turn to end' : 'Commit'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
