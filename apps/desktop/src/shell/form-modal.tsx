import { Box, Group, Modal, Text, type MantineSize } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useHiddenEdges } from './use-hidden-edges';

/**
 * A soft shadow cast by the header or footer onto the content scrolled under it. A fade into the
 * panel's own color barely shows on a modal, whose edges mostly sit over empty panel.
 */
const scrollShadow = (shown: boolean, direction: 1 | -1) =>
  shown ? `0 ${String(6 * direction)}px 12px -6px rgb(0 0 0 / 45%)` : 'none';

export interface FormModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly size?: MantineSize;
  /** The actions, right-aligned in a footer that never scrolls away. */
  readonly actions: ReactNode;
  /** Why the last submit failed; it sits beside the actions that caused it. */
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
          wrap="nowrap"
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
          <Group gap="xs" wrap="nowrap" role="alert" style={{ minWidth: 0 }}>
            {error ? (
              <>
                <IconAlertTriangle
                  size={20}
                  stroke={1.5}
                  color="var(--mantine-color-red-filled)"
                  style={{ flex: 'none' }}
                />
                <Text size="sm" c="red" lineClamp={2} title={error}>
                  {error}
                </Text>
              </>
            ) : null}
          </Group>
          <Group gap="sm" wrap="nowrap" style={{ flex: 'none' }}>
            {actions}
          </Group>
        </Group>
      </Modal.Content>
    </Modal.Root>
  );
}
