import { BRAINSTORM_REFUSED_ON_CHATGPT } from '@10db/contracts';
import { ActionIcon, Alert, Box, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { IconPaperclip } from '@tabler/icons-react';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { FILE_PICKER_ACCEPT } from './dropped-files';
import { keepBoth, withoutSent, type LateOutcome } from './late-outcome';
import { isSendKey } from './use-shape-keys';

export interface ComposerProps {
  /** No builder message yet: the input takes focus and the hint says what nothing does until you act. */
  readonly firstRun: boolean;
  readonly answering: boolean;
  /** A Propose turn is queued or running; pressing again would be ignored. */
  readonly proposing: boolean;
  readonly proposeLabel: 'Propose' | 'Propose Again';
  readonly canPropose: boolean;
  /**
   * Nothing has been heard or proposed yet, so Propose has little to work with. The line beside
   * Propose says so; Propose itself stays as `canPropose` has it.
   */
  readonly nothingDecided: boolean;
  /** Sends the text; rejects with the daemon's words. */
  readonly onSend: (text: string) => Promise<void>;
  readonly onPropose: () => void;
  readonly onStop: () => void;
  /** Why the conversation could not load, shown above the input in red. */
  readonly error: string | null;
  /** The names of the files already in the conversation. */
  readonly files: readonly string[];
  /** Adds dropped, pasted or picked files; answers a reason for each one it refused. */
  readonly onFiles: (files: File[]) => Promise<string[]>;
  /** A send or drop from the screen this one replaced, finished late: its reasons and the failed text. */
  readonly late: LateOutcome | null;
  /** This input has taken `late`. */
  readonly onLateTaken: () => void;
  /** Told what the input holds each time it changes, so a screen replacing it can carry the text. */
  readonly onDraft: (text: string) => void;
}

const FIRST_RUN_PLACEHOLDER = 'Talk it through, drop a document, or paste a list…';

/** The input, Send, the group's one filled primary Propose, and Stop while a turn runs. */
export function Composer(props: ComposerProps) {
  const { firstRun, answering, proposing, proposeLabel, canPropose, nothingDecided } = props;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState<readonly string[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (firstRun) input.current?.focus();
  }, [firstRun]);

  const { late, onLateTaken } = props;
  // Taken while rendering, so the first paint already has it; the store is told after.
  const [takenLate, setTakenLate] = useState<LateOutcome | null>(null);
  if (late !== null && late !== takenLate) {
    setTakenLate(late);
    setRefused((held) => [...held, ...late.refused.filter((reason) => !held.includes(reason))]);
    if (late.failure !== null) setFailure(late.failure);
    const text = late.draft;
    // Whatever was typed since stays, with the text that failed ahead of it.
    if (text !== null) setDraft((typed) => keepBoth(typed, text));
  }
  useEffect(() => {
    if (late !== null) onLateTaken();
  }, [late, onLateTaken]);
  const { onDraft } = props;
  useEffect(() => {
    onDraft(draft);
  }, [draft, onDraft]);

  const addFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    try {
      setRefused(await props.onFiles(files));
    } catch (error) {
      setRefused([error instanceof Error ? error.message : String(error)]);
    }
  };
  const hasFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files');
  const onDrop = (event: DragEvent): void => {
    setDragging(false);
    if (!hasFiles(event)) return;
    event.preventDefault();
    void addFiles([...event.dataTransfer.files]);
  };
  // A screenshot pastes as a file with no text; a copy that carries text too is pasted as text.
  const onPaste = (event: ClipboardEvent): void => {
    const files = [...event.clipboardData.files];
    if (files.length === 0 || event.clipboardData.getData('text') !== '') return;
    event.preventDefault();
    void addFiles(files);
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || sending) return;
    setSending(true);
    setFailure(null);
    try {
      await props.onSend(text);
      // Only the text sent goes: a failed text restored while it was on its way stays.
      setDraft((typed) => withoutSent(typed, text));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const shown = failure ?? props.error;

  return (
    <Stack
      gap="xs"
      px="md"
      pb="md"
      pt="xs"
      style={{ flex: 'none' }}
      onDragOver={(event: DragEvent) => {
        if (!hasFiles(event)) return;
        // Without this the browser opens the file instead of handing it over.
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      {shown === null ? null : (
        <Alert
          color="red"
          title={
            shown === BRAINSTORM_REFUSED_ON_CHATGPT
              ? 'Not available on this account'
              : "Couldn't reach Claude"
          }
        >
          {shown}
        </Alert>
      )}
      {refused.length === 0 ? null : (
        <Alert
          color="red"
          title="Couldn't add the file"
          withCloseButton
          closeButtonLabel="Dismiss"
          onClose={() => {
            setRefused([]);
          }}
        >
          {refused.map((reason) => (
            <Text key={reason} size="sm">
              {reason}
            </Text>
          ))}
        </Alert>
      )}
      <Box
        style={{
          outline: dragging ? '1px dashed var(--mantine-color-dimmed)' : undefined,
          outlineOffset: 2,
          borderRadius: 'var(--mantine-radius-sm)',
        }}
      >
        <Textarea
          ref={input}
          aria-label="Message"
          aria-describedby="shape-composer-hint"
          autosize
          minRows={2}
          maxRows={8}
          placeholder={firstRun ? FIRST_RUN_PLACEHOLDER : 'Talk it through…'}
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (isSendKey(event)) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </Box>
      {props.files.length === 0 ? null : (
        <Text size="xs" c="dimmed" aria-label="Files in the conversation">
          {props.files.join(' · ')}
        </Text>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept={FILE_PICKER_ACCEPT}
        aria-label="Choose files"
        onChange={(event) => {
          void addFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = '';
        }}
      />
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Text id="shape-composer-hint" size="xs" c="dimmed">
            {firstRun
              ? 'Nothing is proposed until you press Propose. Nothing starts until you Convert.'
              : '⌘↩ sends · ⌘⇧↩ proposes · Esc stops'}
          </Text>
          {nothingDecided ? (
            <Text id="shape-composer-propose-hint" size="xs" c="dimmed">
              Propose turns decided work into tasks. Nothing is decided yet.
            </Text>
          ) : null}
        </Stack>
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          <ActionIcon
            variant="subtle"
            size="lg"
            aria-label="Attach files"
            onClick={() => {
              picker.current?.click();
            }}
          >
            <IconPaperclip size={18} stroke={1.5} />
          </ActionIcon>
          {answering ? (
            <Button variant="default" onClick={props.onStop}>
              Stop
            </Button>
          ) : null}
          <Button
            variant="default"
            loading={sending}
            disabled={draft.trim() === ''}
            onClick={() => {
              void send();
            }}
          >
            Send
          </Button>
          <Button
            loading={proposing}
            disabled={!canPropose}
            aria-describedby={nothingDecided ? 'shape-composer-propose-hint' : undefined}
            onClick={props.onPropose}
          >
            {proposeLabel}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
