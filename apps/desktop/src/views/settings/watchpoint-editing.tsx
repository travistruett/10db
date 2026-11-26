import { useState } from 'react';
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
