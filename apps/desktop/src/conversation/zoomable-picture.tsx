import { Modal, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { CSSProperties } from 'react';

export interface ZoomablePictureProps {
  /** The picture, a data URL read with the UI token. */
  readonly src: string;
  /** Names the picture, its Enlarge control and the dialog that shows it. */
  readonly alt: string;
  /** How the picture is drawn in the thread: a thumbnail or a fixed width. */
  readonly style: CSSProperties;
}

/**
 * A picture in a conversation, drawn small in the thread; a click opens it in a dialog at the size the
 * window allows, and Esc or a click outside closes it.
 */
export function ZoomablePicture({ src, alt, style }: ZoomablePictureProps) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <>
      <UnstyledButton
        aria-label={`Enlarge ${alt}`}
        onClick={open}
        style={{ display: 'block', maxWidth: '100%', cursor: 'zoom-in' }}
      >
        <img src={src} alt={alt} title={alt} style={style} />
      </UnstyledButton>
      <Modal opened={opened} onClose={close} title={alt} size="auto" centered>
        <img
          src={src}
          alt={alt}
          style={{
            display: 'block',
            maxWidth: 'calc(100vw - 96px)',
            maxHeight: 'calc(100vh - 160px)',
            width: 'auto',
            height: 'auto',
            borderRadius: 'var(--mantine-radius-sm)',
          }}
        />
      </Modal>
    </>
  );
}
