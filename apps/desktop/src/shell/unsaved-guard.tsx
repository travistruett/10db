import { Button, Group, Modal } from '@mantine/core';
import { useBlocker } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** What a view with edits in progress tells the frame, and how anything that would discard them asks first. */
export interface UnsavedGuard {
  /** Says whether the view holds edits that leaving would lose. */
  readonly setDirty: (dirty: boolean) => void;
  /** Runs `proceed` at once when nothing is unsaved; otherwise asks the builder first. */
  readonly attempt: (proceed: () => void) => void;
}

const NO_GUARD: UnsavedGuard = {
  setDirty: () => undefined,
  attempt: (proceed) => {
    proceed();
  },
};

const UnsavedGuardContext = createContext<UnsavedGuard>(NO_GUARD);

/** The frame's guard; outside a frame there is nothing to ask, so every attempt goes ahead. */
export function useUnsavedGuard(): UnsavedGuard {
  return useContext(UnsavedGuardContext);
}

/** Reports a view's unsaved edits to the frame for as long as it is mounted. */
export function useReportUnsaved(dirty: boolean): void {
  const { setDirty } = useUnsavedGuard();
  useEffect(() => {
    setDirty(dirty);
    return () => {
      setDirty(false);
    };
  }, [dirty, setDirty]);
}

/**
 * Holds the one question "discard your changes?" for everything that would unmount a dirty view: a
 * route change (a rail item, a link, back) is blocked until it is answered, and `attempt` asks for
 * changes that stay on the same route (another card, another project).
 */
export function UnsavedGuardProvider({ children }: { readonly children: ReactNode }) {
  const dirty = useRef(false);
  // What waits on the answer: a route change held by the router, or a callback from `attempt`.
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [guard] = useState<UnsavedGuard>(() => ({
    setDirty: (next) => {
      dirty.current = next;
    },
    attempt: (proceed) => {
      if (dirty.current) setPending(() => proceed);
      else proceed();
    },
  }));

  const blocker = useBlocker({
    shouldBlockFn: () => dirty.current,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const asking = pending !== null || blocker.status === 'blocked';

  const keep = (): void => {
    setPending(null);
    if (blocker.status === 'blocked') blocker.reset();
  };
  const discard = (): void => {
    dirty.current = false;
    if (blocker.status === 'blocked') blocker.proceed();
    pending?.();
    setPending(null);
  };

  return (
    <UnsavedGuardContext value={guard}>
      {children}
      <Modal opened={asking} onClose={keep} title="Discard your changes?" centered size="sm">
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={discard}>
            Discard
          </Button>
          <Button data-autofocus onClick={keep}>
            Keep Editing
          </Button>
        </Group>
      </Modal>
    </UnsavedGuardContext>
  );
}
