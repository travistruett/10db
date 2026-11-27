import { Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { ConfirmModal } from '../../shell/confirm-modal';

/**
 * Which watchpoint a page's drawer has open, or a new one, and the daemon's refusal of the last save. Asking for
 * another row while the open one has unsaved edits asks to discard them first.
 */
export function useWatchpointEditing<T extends { readonly key: string }>(name: (row: T) => string) {
  const [editing, setEditing] = useState<T | null>(null);
  const [adding, setAdding] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<{ readonly to: T | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const opened = adding || editing !== null;
  const show = (to: T | null) => {
    setDirty(false);
    setProblem(null);
    setAdding(to === null);
    setEditing(to);
  };
  const request = (to: T | null) => {
    // The open row again changes nothing, and keeps its edits.
    if (opened && editing?.key === to?.key) return;
    if (dirty && opened) setSwitchTo({ to });
    else show(to);
  };
  const close = () => {
    setAdding(false);
    setEditing(null);
  };
  const discardModal = (
    <ConfirmModal
      opened={switchTo !== null}
      title="Discard Changes"
      confirmLabel="Discard"
      cancelLabel="Keep Editing"
      destructive
      onCancel={() => {
        setSwitchTo(null);
      }}
      onConfirm={() => {
        if (switchTo !== null) show(switchTo.to);
        setSwitchTo(null);
      }}
    >
      {`Discard your changes to ${editing === null ? 'the new watchpoint' : name(editing)}?`}
    </ConfirmModal>
  );
  return { editing, opened, request, close, setDirty, problem, setProblem, discardModal };
}

/** The daemon's refusal as words for the page. */
export function refusal(error: unknown): string {
  return error instanceof Error ? error.message : 'The daemon refused the change.';
}

/** How long a starter just added stays marked in its list. */
const ADDED_MARK_MS = 4000;

/**
 * The starter just added to a list: its row is highlighted and scrolled into view, and a line names it, for a
 * moment. The page marks it once the save has landed, so the row exists.
 */
export function useJustAdded() {
  const [added, setAdded] = useState<{ readonly key: string; readonly label: string } | null>(null);
  useEffect(() => {
    if (added === null) return undefined;
    document
      .querySelector(`[data-watchpoint-key="${added.key}"]`)
      ?.scrollIntoView({ block: 'center' });
    const timer = setTimeout(() => {
      setAdded(null);
    }, ADDED_MARK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [added]);
  return {
    key: added?.key ?? null,
    mark: (starter: { readonly key: string; readonly label: string }) => {
      setAdded(starter);
    },
    note:
      added === null ? null : (
        <Text size="sm" role="status">
          {`Added ${added.label}.`}
        </Text>
      ),
  };
}
