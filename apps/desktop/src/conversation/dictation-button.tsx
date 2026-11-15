import { ActionIcon } from '@mantine/core';
import { IconMicrophone } from '@tabler/icons-react';
import type { RefObject } from 'react';
import { isTauri, startDictation } from '../desktop/tauri';

export interface DictationButtonProps {
  /** The input the spoken text lands in; it is focused before dictation starts. */
  readonly inputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  readonly disabled?: boolean;
  /** Why dictation could not start. */
  readonly onError: (message: string) => void;
}

/** Starts macOS Dictation in the input, as fn-fn does; only the desktop shell can, so a browser shows none. */
export function DictationButton({ inputRef, disabled = false, onError }: DictationButtonProps) {
  if (!isTauri()) return null;
  return (
    <ActionIcon
      variant="subtle"
      size="lg"
      aria-label="Dictate"
      disabled={disabled}
      // The button must not take focus: dictation goes to the field that has it.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        inputRef.current?.focus();
        startDictation().catch((cause: unknown) => {
          onError(cause instanceof Error ? cause.message : String(cause));
        });
      }}
    >
      <IconMicrophone size={18} stroke={1.5} />
    </ActionIcon>
  );
}
