import { Button, Group, Text, Transition } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';

/** The bar under a page of typed settings: Reset, Save, and what the last save said. */
export function SaveBar({
  error,
  note,
  saving,
  onReset,
  onSave,
}: {
  /** The refusal to show at the bar's left; null when the last save went through. */
  readonly error: string | null;
  /** 'Saved' shows a check, any other text is dimmed, null shows nothing. */
  readonly note: string | null;
  readonly saving: boolean;
  readonly onReset: () => void;
  readonly onSave: () => void;
}) {
  // The bar stays at the bottom of the window, so Save never scrolls away.
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      pos="sticky"
      // The surface pads its content, and a sticky edge is measured inside that padding: reach over it.
      bottom="calc(var(--shell-content-padding-block) * -1)"
      py="md"
      // Reaches over the surface's side padding, so the divider runs edge to edge.
      mx="calc(var(--shell-content-padding-inline) * -1)"
      px="var(--shell-content-padding-inline)"
      // Reaches over the surface's bottom padding, so the page ends at the bar: no extra scroll below it.
      mb="calc(var(--shell-content-padding-block) * -1)"
      bg="var(--mantine-color-body)"
      style={{
        borderTop: '1px solid var(--mantine-color-default-border)',
        // Above controls that layer their own parts (SegmentedControl's labels sit at 2), below popovers.
        zIndex: 'var(--mantine-z-index-app)',
      }}
    >
      <Text size="sm" c="red" role="alert" lineClamp={2}>
        {error === null ? '' : `Couldn't save: ${error}`}
      </Text>
      <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
        {/* Beside the button that caused it, where the eye already is after clicking Save. */}
        <Transition mounted={note !== null && error === null} transition="fade" duration={200}>
          {(styles) => (
            <Group gap={4} wrap="nowrap" role="status" style={styles} mr="xs">
              {note === 'Saved' ? (
                <IconCircleCheck size={18} stroke={1.5} color="var(--mantine-color-green-filled)" />
              ) : null}
              <Text size="sm" fw={500} c={note === 'Saved' ? 'green' : 'dimmed'}>
                {note}
              </Text>
            </Group>
          )}
        </Transition>
        <Button variant="default" onClick={onReset}>
          Reset
        </Button>
        <Button onClick={onSave} loading={saving}>
          Save
        </Button>
      </Group>
    </Group>
  );
}
