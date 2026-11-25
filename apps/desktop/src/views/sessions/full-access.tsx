import { Badge, Button, Group, List, Menu, Modal, Text, Tooltip } from '@mantine/core';
import { IconShieldOff } from '@tabler/icons-react';

/** The title row's mark while a chat has Full access; its menu turns it off. */
export function FullAccessBadge({
  onTurnOff,
  disabled = false,
}: {
  readonly onTurnOff: () => void;
  /** A turn is running: the change waits for it to end. */
  readonly disabled?: boolean;
}) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Tooltip
        multiline
        w={280}
        label="This chat runs without 10db’s sandbox, as it would in your terminal. It still asks before anything that can’t be undone."
      >
        <Menu.Target>
          <Badge
            component="button"
            variant="light"
            color="orange"
            size="lg"
            radius="sm"
            leftSection={<IconShieldOff size={14} stroke={1.5} />}
            style={{ cursor: 'pointer', textTransform: 'none' }}
          >
            Full access
          </Badge>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        <Menu.Item disabled={disabled} onClick={onTurnOff}>
          {disabled ? 'Waits for the Turn to End' : 'Turn Off Full Access'}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export interface FullAccessConfirmProps {
  readonly opened: boolean;
  /** The agent's name, `capabilities.label`. */
  readonly agent: string;
  /** Where the chat's settings, plugins and servers come from, as the daemon words it; empty until read. */
  readonly notes: readonly string[];
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/** What Full access lifts and what still holds, asked once each time it is turned on. */
export function FullAccessConfirm({
  opened,
  agent,
  notes,
  onCancel,
  onConfirm,
}: FullAccessConfirmProps) {
  return (
    <Modal
      opened={opened}
      onClose={onCancel}
      title="Turn On Full Access?"
      centered
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <Text size="sm">For this chat, {agent} runs as it does in your terminal:</Text>
      <List size="sm" mt="xs" spacing={4}>
        <List.Item>
          No 10db sandbox: it can write anywhere you can, run any command and reach any host.
        </List.Item>
        {notes.map((note) => (
          <List.Item key={note}>{note}</List.Item>
        ))}
        <List.Item>This project’s own settings, hooks and MCP servers load and run too.</List.Item>
        <List.Item>
          It still asks before a force push, a production deploy or deleting files it didn’t make.
        </List.Item>
      </List>
      <Text size="sm" c="dimmed" mt="sm">
        Board tasks are never affected. It starts with your next message and stays on for this chat
        until you turn it off.
      </Text>
      <Group justify="flex-end" gap="xs" mt="md">
        <Button variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
        <Button color="orange" data-autofocus onClick={onConfirm}>
          Turn On Full Access
        </Button>
      </Group>
    </Modal>
  );
}
