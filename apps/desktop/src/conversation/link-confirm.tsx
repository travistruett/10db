import { Button, Group, Modal, Text } from '@mantine/core';
import { useSyncExternalStore } from 'react';

// The browser's confirm before a link from agent text opens. In the desktop app the shell asks
// natively instead (`open_web_link`); this one serves Vite and the e2e, where no shell exists.

interface Pending {
  readonly host: string;
  readonly url: string;
  readonly answer: (open: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function set(next: Pending | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Asks "Open {host} in your browser?" and answers whether the builder chose Open. A second ask
 * while one is open answers the first with Cancel.
 */
export function confirmWebLink(host: string, url: string): Promise<boolean> {
  pending?.answer(false);
  return new Promise((resolve) => {
    set({ host, url, answer: resolve });
  });
}

function answer(open: boolean): void {
  const current = pending;
  set(null);
  current?.answer(open);
}

/** Draws the browser confirm; mounted once beside the app's providers. */
export function LinkConfirmHost() {
  const current = useSyncExternalStore(subscribe, () => pending);
  return (
    <Modal
      opened={current !== null}
      onClose={() => {
        answer(false);
      }}
      title={current === null ? '' : `Open ${current.host} in your browser?`}
      centered
    >
      <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
        {current?.url}
      </Text>
      <Group justify="flex-end" mt="md">
        <Button
          variant="default"
          onClick={() => {
            answer(false);
          }}
        >
          Cancel
        </Button>
        <Button
          onClick={() => {
            answer(true);
          }}
        >
          Open
        </Button>
      </Group>
    </Modal>
  );
}
