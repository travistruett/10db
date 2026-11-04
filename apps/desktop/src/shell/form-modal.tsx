import { Box, Group, Modal, Text, type MantineSize } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useHiddenEdges } from './use-hidden-edges';

/**
 * A soft shadow cast by the header or footer onto the content scrolled under it. A fade into the
 * panel's own color barely shows on a modal, whose edges mostly sit over empty panel.
 */
const scrollShadow = (shown: boolean, direction: 1 | -1) =>
  shown
    ? `0 ${String(6 * direction)}px 12px -6px color-mix(in srgb, var(--mantine-color-black) 45%, transparent)`
    : 'none';

export interface FormModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly size?: MantineSize;
  /** The actions, right-aligned in a footer that never scrolls away. */
  readonly actions: ReactNode;
  /**
   * Why the last submit failed, always in full: beside the actions that caused it, or on its own
   * line above them when it doesn't fit there.
   */
  readonly error?: string | null;
  readonly children: ReactNode;
}

/**
 * A modal whose body scrolls under a fixed header and footer, so its actions are always on screen.
 * The header or footer casts a shadow while content is hidden past it.
 */
export function FormModal({
  opened,
  onClose,
  title,
  size = 'lg',
  actions,
  error = null,
  children,
}: FormModalProps) {
  const { ref, edges, onScroll } = useHiddenEdges();

  return (
    <Modal.Root
      opened={opened}
      onClose={onClose}
      size={size}
      centered
      // `style` on Modal.Content lands on the positioning wrapper; the panel is styled through `content`.
      styles={{ content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } }}
    >
      <Modal.Overlay />
      <Modal.Content>
        <Modal.Header
          style={{
            flex: 'none',
            boxShadow: scrollShadow(edges.top, 1),
            transition: 'box-shadow 200ms ease',
          }}
        >
          <Modal.Title>{title}</Modal.Title>
          <Modal.CloseButton aria-label="Close" />
        </Modal.Header>
        <Box style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Modal.Body ref={ref} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto' }}>
            {children}
          </Modal.Body>
        </Box>
        <Group
          justify="space-between"
          px="md"
          py="sm"
          style={{
            flex: 'none',
            // Positioned so its shadow paints over the scrolled content.
            position: 'relative',
            borderTop: '1px solid var(--mantine-color-default-border)',
            boxShadow: scrollShadow(edges.bottom, -1),
            transition: 'box-shadow 200ms ease',
          }}
        >
          <Group
            gap="xs"
            wrap="nowrap"
            align="flex-start"
            role="alert"
            style={{ minWidth: 0, maxWidth: '100%' }}
          >
            {error ? (
              <>
                <IconAlertTriangle
                  size={20}
                  stroke={1.5}
                  color="var(--mantine-color-red-filled)"
                  style={{ flex: 'none' }}
                />
                <Text size="sm" c="red" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {error}
                </Text>
              </>
            ) : null}
          </Group>
          {/* Kept right when a long error takes the line above them. */}
          <Group gap="sm" wrap="nowrap" style={{ flex: 'none', marginLeft: 'auto' }}>
            {actions}
          </Group>
        </Group>
      </Modal.Content>
    </Modal.Root>
  );
}
