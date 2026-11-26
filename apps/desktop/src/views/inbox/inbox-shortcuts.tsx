import { Group, Kbd, Modal, Stack, Text } from '@mantine/core';

/** Every Inbox shortcut, as the list shows it. */
const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly action: string }[] = [
  { keys: ['↑', '↓', 'j', 'k'], action: 'Move between cards' },
  { keys: ['1–5'], action: 'Choose an option' },
  { keys: ['n'], action: 'Write a note' },
  { keys: ['e'], action: 'Dismiss a flag' },
  { keys: ['↵'], action: 'Send the answer, dismiss a flag, or open the UI Workbench' },
  { keys: ['⌘', '↵'], action: 'Send from the note' },
  { keys: ['?'], action: 'Show these shortcuts' },
];

export interface InboxShortcutsProps {
  readonly opened: boolean;
  readonly onClose: () => void;
}

/** The list of shortcuts the ? key opens. */
export function InboxShortcuts({ opened, onClose }: InboxShortcutsProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Keyboard Shortcuts"
      centered
      closeButtonProps={{ 'aria-label': 'Close' }}
      // Back on the page, where the Inbox keys count.
      returnFocus={false}
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
        <Text size="xs" c="dimmed">
          A check card is answered with its own buttons; these keys leave it alone.
        </Text>
      </Stack>
    </Modal>
  );
}
