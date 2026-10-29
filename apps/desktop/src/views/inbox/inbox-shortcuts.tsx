import { ActionIcon, Group, Kbd, Modal, Stack, Text } from '@mantine/core';

/** Every Inbox shortcut, as the list shows it. */
const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly action: string }[] = [
  { keys: ['↑', '↓', 'j', 'k'], action: 'Move between cards' },
  { keys: ['1–4'], action: 'Choose an option' },
  { keys: ['n'], action: 'Write a note' },
  { keys: ['↵'], action: 'Send the answer, or dismiss a flag' },
  { keys: ['⌘', '↵'], action: 'Send from the note' },
  { keys: ['?'], action: 'Show these shortcuts' },
];

export interface InboxShortcutsProps {
  readonly opened: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}

/** The ? button and the list of shortcuts it opens. */
export function InboxShortcuts({ opened, onOpen, onClose }: InboxShortcutsProps) {
  return (
    <>
      <ActionIcon variant="default" aria-label="Keyboard shortcuts" onClick={onOpen}>
        ?
      </ActionIcon>
      <Modal
        opened={opened}
        onClose={onClose}
        title="Keyboard Shortcuts"
        centered
        closeButtonProps={{ 'aria-label': 'Close' }}
      >
        <Stack gap="xs">
          {SHORTCUTS.map(({ keys, action }) => (
            <Group key={action} justify="space-between" wrap="nowrap">
              <Text size="sm">{action}</Text>
              <Group gap={4} wrap="nowrap">
                {keys.map((k) => (
                  <Kbd key={k} size="xs">
                    {k}
                  </Kbd>
                ))}
              </Group>
            </Group>
          ))}
        </Stack>
      </Modal>
    </>
  );
}
