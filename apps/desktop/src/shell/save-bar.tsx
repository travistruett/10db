import { Box, Button, Group, Text, Transition } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';

/** What the bar says: edits waiting, a save under way, or a save that just landed. */
export const SaveBarState = {
  Unsaved: 'unsaved',
  Saving: 'saving',
  Saved: 'saved',
} as const;
export type SaveBarState = (typeof SaveBarState)[keyof typeof SaveBarState];

/**
 * The bar under a settings page, shown only while it has something to say: "Unsaved changes" with
 * Discard and Save while edits wait, then Saved for a moment. Hidden, it takes no room.
 */
export function SaveBar({
  state,
  error,
  onDiscard,
  onSave,
}: {
  /** Null hides the bar. */
  readonly state: SaveBarState | null;
  /** Why the last Save did not go through, at the bar's left in place of "Unsaved changes". */
  readonly error: string | null;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}) {
  const waiting = state === SaveBarState.Unsaved || state === SaveBarState.Saving;
  return (
    <Transition mounted={state !== null} transition="slide-up" duration={150}>
      {(styles) => (
        <Group
          justify="space-between"
          wrap="nowrap"
          pos="sticky"
          // The surface pads its content, and a sticky edge is measured inside that padding: reach over it.
          bottom="calc(var(--shell-content-padding-block) * -1)"
          py="sm"
          // Reaches over the surface's side padding, so the divider runs edge to edge.
          mx="calc(var(--shell-content-padding-inline) * -1)"
          px="var(--shell-content-padding-inline)"
          // Reaches over the surface's bottom padding, so the page ends at the bar: no extra scroll below it.
          mb="calc(var(--shell-content-padding-block) * -1)"
          bg="var(--mantine-color-body)"
          style={{
            ...styles,
            borderTop: '1px solid var(--mantine-color-default-border)',
            // Above controls that layer their own parts (SegmentedControl's labels sit at 2), below popovers.
            zIndex: 'var(--mantine-z-index-app)',
          }}
        >
          {error !== null ? (
            <Text size="sm" c="red" role="alert" lineClamp={2}>
              {`Couldn't save: ${error}`}
            </Text>
          ) : waiting ? (
            <Group gap="xs" wrap="nowrap" role="status">
              <Box
                w={8}
                h={8}
                style={{ borderRadius: '50%', background: 'var(--mantine-color-yellow-filled)' }}
                aria-hidden
              />
              <Text size="sm" fw={500}>
                Unsaved changes
              </Text>
            </Group>
          ) : (
            <span />
          )}
          {waiting ? (
            <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
              <Button
                variant="default"
                onClick={onDiscard}
                disabled={state === SaveBarState.Saving}
              >
                Discard
              </Button>
              <Button onClick={onSave} loading={state === SaveBarState.Saving}>
                Save
              </Button>
            </Group>
          ) : (
            <Group gap={4} wrap="nowrap" role="status">
              <IconCircleCheck size={18} stroke={1.5} color="var(--mantine-color-green-filled)" />
              <Text size="sm" fw={500} c="green">
                Saved
              </Text>
            </Group>
          )}
        </Group>
      )}
    </Transition>
  );
}
