import type { AgentCapabilitiesDto } from '@10db/contracts';
import { ActionIcon, Box, Button, CloseButton, Group, Stack, Text, Textarea } from '@mantine/core';
import { IconPaperclip } from '@tabler/icons-react';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type Ref } from 'react';
import type { ComposerPhase } from './composer-phase';
import { EMPTY_DRAFT, hasContent, type Draft } from './drafts';
import { isSendKey } from './escape';
import { pickerAccept, withPictures } from './pictures';

// Sessions UI spec §7.9, §7.11: one frame holding the input and its bar, with the hint under it. ⌘↩
// sends and Enter is a new line, never while an IME composes; pictures paste, drop or attach and wait
// as thumbnails.

export interface ComposerProps {
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
  readonly capabilities: AgentCapabilitiesDto;
  readonly phase: ComposerPhase;
  /** Why Send is off (reconnecting, a removed project); the input still takes text. */
  readonly disabledReason: string | null;
  /** Nothing can be typed either: the account has no chat to offer. */
  readonly locked?: boolean;
  /** Sends the draft; rejects with the daemon's words, and the draft stays. */
  readonly onSend: (draft: Draft) => Promise<void> | void;
  /** A plain Stop: the turn ends and nothing is sent. */
  readonly onStop: () => void;
  /** Stops the turn and sends the draft as the next one. */
  readonly onRedo: (draft: Draft) => Promise<void> | void;
  readonly inputRef?: Ref<HTMLTextAreaElement>;
  /** The input's accessible name. */
  readonly label?: string;
}

/** A 56 px thumbnail of a picture waiting to be sent. */
function Thumbnail({ file, onRemove }: { readonly file: File; readonly onRemove: () => void }) {
  const image = useRef<HTMLImageElement>(null);
  // The address is made and released with the element, so it never outlives the picture's chip.
  useEffect(() => {
    const el = image.current;
    if (el === null || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(file);
    el.src = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);
  return (
    <Box component="li" pos="relative" style={{ listStyle: 'none' }}>
      <img
        ref={image}
        alt={file.name}
        width={56}
        height={56}
        style={{ objectFit: 'cover', borderRadius: 'var(--mantine-radius-sm)', display: 'block' }}
      />
      <CloseButton
        size="xs"
        pos="absolute"
        top={-4}
        right={-4}
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
      />
    </Box>
  );
}

export function Composer({
  draft,
  onDraft,
  capabilities,
  phase,
  disabledReason,
  locked = false,
  onSend,
  onStop,
  onRedo,
  inputRef,
  label = 'Message',
}: ComposerProps) {
  const [busy, setBusy] = useState<'send' | 'stop' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState<readonly string[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const canAttach = capabilities.images.length > 0;
  const filled = hasContent(draft);

  const addPictures = (files: readonly File[]): void => {
    if (files.length === 0 || locked) return;
    const added = withPictures(draft.pictures, files, capabilities.images);
    setRefused(added.refused);
    onDraft({ ...draft, pictures: added.pictures });
  };

  const run = async (
    which: 'send' | 'stop',
    action: () => Promise<void> | void,
    clears: boolean,
  ): Promise<void> => {
    setBusy(which);
    setFailure(null);
    try {
      await action();
      if (clears) onDraft(EMPTY_DRAFT);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const send = (): void => {
    if (locked || disabledReason !== null || !filled || busy !== null) return;
    void run('send', () => onSend(draft), true);
  };
  const stop = (): void => {
    if (phase.stop === 'stop_and_redo') void run('stop', () => onRedo(draft), true);
    else {
      onStop();
    }
  };

  const hasFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files');
  // A screenshot pastes as a file with no text; a copy that carries text too is pasted as text.
  const onPaste = (event: ClipboardEvent): void => {
    const files = [...event.clipboardData.files];
    if (files.length === 0 || event.clipboardData.getData('text') !== '') return;
    event.preventDefault();
    addPictures(files);
  };

  return (
    <Stack
      gap={4}
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
      onDrop={(event: DragEvent) => {
        setDragging(false);
        if (!hasFiles(event)) return;
        event.preventDefault();
        addPictures([...event.dataTransfer.files]);
      }}
    >
      {refused.length === 0 ? null : (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Stack gap={0} style={{ flex: 1 }}>
            {refused.map((reason) => (
              <Text key={reason} size="xs" c="red">
                {reason}
              </Text>
            ))}
          </Stack>
          <CloseButton
            size="sm"
            aria-label="Dismiss"
            onClick={() => {
              setRefused([]);
            }}
          />
        </Group>
      )}
      <Box
        data-composer-frame
        bg="var(--tendb-color-panel)"
        p="xs"
        style={{
          borderRadius: 'var(--mantine-radius-md)',
          outline: dragging ? '1px dashed var(--mantine-color-dimmed)' : undefined,
          outlineOffset: 2,
        }}
      >
        <Textarea
          ref={inputRef}
          aria-label={label}
          aria-describedby={phase.hint === null ? undefined : 'composer-hint'}
          variant="unstyled"
          autosize
          minRows={2}
          maxRows={10}
          placeholder={phase.placeholder}
          value={draft.text}
          disabled={locked}
          onChange={(event) => {
            onDraft({ ...draft, text: event.currentTarget.value });
          }}
          onPaste={onPaste}
          onKeyDown={(event) => {
            // An IME's Enter picks a candidate; it is never a send. Safari ends a composition with a
            // keydown whose `isComposing` is already false, and whose keyCode is 229.
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- keyCode 229 is the only signal.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (!isSendKey(event)) return;
            event.preventDefault();
            send();
          }}
        />
        {draft.pictures.length === 0 ? null : (
          <Group component="ul" aria-label="Pictures to send" gap="xs" m={0} p={0} pt="xs">
            {draft.pictures.map((picture, index) => (
              <Thumbnail
                key={`${String(index)}-${picture.name}`}
                file={picture}
                onRemove={() => {
                  onDraft({ ...draft, pictures: draft.pictures.filter((_, i) => i !== index) });
                }}
              />
            ))}
          </Group>
        )}
        {canAttach ? (
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept={pickerAccept(capabilities.images)}
            aria-label="Choose pictures"
            onChange={(event) => {
              addPictures([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = '';
            }}
          />
        ) : null}
        <Group justify="space-between" wrap="nowrap" gap="xs" pt={4}>
          <Group gap="xs" wrap="nowrap">
            {canAttach ? (
              <ActionIcon
                variant="subtle"
                size="lg"
                aria-label="Attach"
                disabled={locked}
                onClick={() => {
                  picker.current?.click();
                }}
              >
                <IconPaperclip size={18} stroke={1.5} />
              </ActionIcon>
            ) : null}
          </Group>
          <Group gap="xs" wrap="nowrap">
            {disabledReason !== null ? (
              <Text size="xs" c="dimmed" lineClamp={2}>
                {disabledReason}
              </Text>
            ) : failure === null ? null : (
              <Text size="xs" c="red" lineClamp={2}>
                {failure}
              </Text>
            )}
            {phase.stop === null ? null : (
              <Button variant="default" loading={busy === 'stop'} disabled={locked} onClick={stop}>
                {phase.stop === 'stop_and_redo' ? 'Stop and Redo' : 'Stop'}
              </Button>
            )}
            {phase.send === 'hidden' ? null : (
              <Button
                variant={phase.send === 'filled' ? 'filled' : 'default'}
                loading={busy === 'send'}
                disabled={locked || disabledReason !== null || !filled}
                onClick={send}
              >
                Send
              </Button>
            )}
          </Group>
        </Group>
      </Box>
      {phase.hint === null ? null : (
        <Text id="composer-hint" size="xs" c="dimmed">
          {phase.hint}
        </Text>
      )}
    </Stack>
  );
}
