import type { AgentCapabilitiesDto } from '@10db/contracts';
import {
  ActionIcon,
  Box,
  Center,
  CloseButton,
  Group,
  Stack,
  Text,
  VisuallyHidden,
} from '@mantine/core';
import { IconCornerDownLeft, IconPaperclip, IconPlayerStopFilled } from '@tabler/icons-react';
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ComposerInput, type ComposerMentions } from './composer-mentions';
import { DictationButton } from './dictation-button';
import type { ComposerPhase } from './composer-phase';
import { afterSend, hasContent, type Draft } from './drafts';
import { isComposing, isSendKey } from './escape';
import { mentionText } from './mention-text';
import { pickerAccept, withPictures } from './pictures';

// Sessions UI spec §7.9, §7.11: one frame holding the input and its bar, with the hint under it. Enter
// sends and Shift+Enter is a new line, never while an IME composes and never while an `@` or `/` list
// is open, where Enter picks; pictures paste, drop or attach and wait as thumbnails.

/**
 * Files that go to the conversation as they are added (Plan's documents), instead of waiting in the
 * draft as pictures. The screen uploads them and keeps the reasons it refused any.
 */
export interface ComposerUploads {
  /** What the file picker offers; a drop or paste skips it, so the screen checks each file again. */
  readonly accept: string;
  readonly onFiles: (files: File[]) => void;
  /** Why files were refused, shown above the input until dismissed. */
  readonly refused: readonly string[];
  readonly onDismiss: () => void;
}

export interface ComposerProps {
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
  /** What the agent takes: Attach shows only with a picture format, `/` only with slash commands. */
  readonly capabilities: Pick<AgentCapabilitiesDto, 'images'> &
    Partial<Pick<AgentCapabilitiesDto, 'slashCommands'>>;
  /** What `@` and `/` list; without it the input is plain text with Enter to send, IME and pictures. */
  readonly mentions?: ComposerMentions;
  readonly phase: ComposerPhase;
  /** Why Send is off (reconnecting, a removed project); the input still takes text. */
  readonly disabledReason: string | null;
  /** Why the last send failed, from the screen that sent it: shown beside Send. */
  readonly error?: string | null;
  /**
   * The screen shows a failed send or Stop itself (Plan's alert): the composer hands the daemon's words
   * over instead of showing them beside Send, and keeps the draft.
   */
  readonly onFailure?: (message: string) => void;
  /** Nothing can be typed either: the account has no chat to offer. */
  readonly locked?: boolean;
  /** Sends the draft; rejects with the daemon's words, and the draft stays. */
  readonly onSend: (draft: Draft) => Promise<void> | void;
  /** A plain Stop: the turn ends and nothing is sent; a rejection's words show beside Send. */
  readonly onStop: () => Promise<void> | void;
  /** Stops the turn and sends the draft as the next one; needed only where the phase offers Stop and Redo. */
  readonly onRedo?: (draft: Draft) => Promise<void> | void;
  /** Files go to the screen as they are added; without it, pictures wait in the draft. */
  readonly uploads?: ComposerUploads;
  /** The screen's own lines under the hint (Plan's files and what Propose needs). */
  readonly notes?: ReactNode;
  readonly inputRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  /** The input's accessible name. */
  readonly label?: string;
  /** Attach's accessible name. */
  readonly attachLabel?: string;
  /** The screen's own controls on the left of the bar, before Attach (a page's Open Page). */
  readonly leading?: ReactNode;
  /** The screen's own buttons before Send (a page's Sign Off). */
  readonly actions?: ReactNode;
  /** The model chip and the context ring, beside Attach. */
  readonly modelControl?: ReactNode;
}

/** Whether the input's suggestion list is open: the list it controls is in the page only then. */
function suggestionsOpen(input: HTMLElement): boolean {
  const list = input.getAttribute('aria-controls');
  return list !== null && document.getElementById(list) !== null;
}

/** The draft as it goes: its text as the builder sees it, and the files its `@` mentions name. */
function outgoing(draft: Draft): Draft {
  const { text, mentions } = mentionText(draft.text);
  return { ...draft, text, mentions };
}

/** A 56 px thumbnail of a picture waiting to be sent. */
function Thumbnail({ file, onRemove }: { readonly file: File; readonly onRemove: () => void }) {
  // A data address, since the window's policy lets an image load from `data:` and not from `blob:`.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (current && typeof reader.result === 'string') setSrc(reader.result);
    };
    try {
      reader.readAsDataURL(file);
    } catch {
      // A file this window's reader refuses keeps the empty tile; it is still sent as it is.
    }
    return () => {
      current = false;
    };
  }, [file]);
  const look = { borderRadius: 'var(--mantine-radius-sm)', display: 'block' } as const;
  return (
    <Box component="li" pos="relative" style={{ listStyle: 'none' }}>
      {src === null ? (
        <Box w={56} h={56} bg="var(--mantine-color-default-hover)" style={look} />
      ) : (
        <img src={src} alt="" width={56} height={56} style={{ objectFit: 'cover', ...look }} />
      )}
      {/* The name is the item's words; the thumbnail only shows it. */}
      <VisuallyHidden>{file.name}</VisuallyHidden>
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
  error = null,
  locked = false,
  onSend,
  onStop,
  onRedo,
  inputRef,
  mentions,
  label = 'Message',
  attachLabel = 'Attach',
  leading,
  actions,
  modelControl,
  uploads,
  notes,
  onFailure,
}: ComposerProps) {
  // A send and a Stop are on their way on their own: each clears only its own mark. The refs answer a
  // second press before the screen has drawn the first.
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState<'stop' | 'redo' | null>(null);
  const sendingNow = useRef(false);
  const stoppingNow = useRef<'stop' | 'redo' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ownRefused, setOwnRefused] = useState<readonly string[]>([]);
  const refused = uploads?.refused ?? ownRefused;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const ownInput = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const field = inputRef ?? ownInput;
  const canAttach = uploads !== undefined || capabilities.images.length > 0;
  const filled = hasContent(draft);
  // The draft as it stands now, for a send that finishes after the builder typed more.
  const current = useRef(draft);
  useEffect(() => {
    current.current = draft;
  });

  const addFiles = (files: readonly File[]): void => {
    if (files.length === 0 || locked) return;
    if (uploads !== undefined) {
      uploads.onFiles([...files]);
      return;
    }
    const added = withPictures(draft.pictures, files, capabilities.images);
    setOwnRefused(added.refused);
    onDraft({ ...draft, pictures: added.pictures });
  };

  const run = async (
    action: () => Promise<void> | void,
    sent: Draft | null,
    done: () => void,
  ): Promise<void> => {
    setFailure(null);
    try {
      await action();
      // Only what went is cleared: words typed or pictures added on the way stay.
      if (sent !== null) onDraft(afterSend(current.current, sent));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (onFailure === undefined) setFailure(message);
      else onFailure(message);
    } finally {
      done();
    }
  };
  const send = (): void => {
    if (locked || disabledReason !== null || !filled) return;
    // A plain Stop on its way doesn't hold a message back: it goes, or queues, as the agent takes it.
    // Stop and Redo is already carrying this draft.
    if (sendingNow.current || stoppingNow.current === 'redo') return;
    sendingNow.current = true;
    setSending(true);
    void run(
      () => onSend(outgoing(draft)),
      draft,
      () => {
        sendingNow.current = false;
        setSending(false);
      },
    );
  };
  const stop = (): void => {
    if (stoppingNow.current !== null) return;
    const redo = phase.stop === 'stop_and_redo' && onRedo !== undefined && !sendingNow.current;
    stoppingNow.current = redo ? 'redo' : 'stop';
    setStopping(stoppingNow.current);
    const finish = (): void => {
      stoppingNow.current = null;
      setStopping(null);
    };
    if (redo) void run(() => onRedo(outgoing(draft)), draft, finish);
    else void run(onStop, null, finish);
  };

  const hasFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files');
  // A screenshot pastes as a file with no text; a copy that carries text too is pasted as text.
  const onPaste = (event: ClipboardEvent): void => {
    const files = [...event.clipboardData.files];
    if (files.length === 0 || event.clipboardData.getData('text') !== '') return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <Stack
      gap={4}
      px="md"
      pb="md"
      pt="xs"
      style={{ flex: 'none' }}
      onDragEnter={(event: DragEvent) => {
        if (!hasFiles(event)) return;
        // Every child the drag crosses enters and leaves, so the frame counts them.
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event: DragEvent) => {
        // Without this the browser opens the file instead of handing it over.
        if (hasFiles(event)) event.preventDefault();
      }}
      onDragLeave={(event: DragEvent) => {
        if (!hasFiles(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event: DragEvent) => {
        dragDepth.current = 0;
        setDragging(false);
        if (!hasFiles(event)) return;
        event.preventDefault();
        addFiles([...event.dataTransfer.files]);
      }}
    >
      {refused.length === 0 ? null : (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          {/* Said as it appears: a drop has no other answer. */}
          <Stack role="alert" gap={0} style={{ flex: 1 }}>
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
              if (uploads === undefined) setOwnRefused([]);
              else uploads.onDismiss();
            }}
          />
        </Group>
      )}
      <Box
        data-composer-frame
        bg="var(--tendb-color-panel)"
        p="xs"
        pos="relative"
        style={{ borderRadius: 'var(--mantine-radius-md)' }}
      >
        {dragging && canAttach && !locked ? (
          // The frame turns into the drop target while files are over it, as the chat apps do.
          <Center
            pos="absolute"
            inset={0}
            style={{
              zIndex: 1,
              pointerEvents: 'none',
              borderRadius: 'var(--mantine-radius-md)',
              border: '2px dashed var(--mantine-color-dimmed)',
              background: 'var(--tendb-color-panel)',
            }}
          >
            <Text size="sm" c="dimmed">
              {uploads === undefined ? 'Drop Pictures to Attach' : 'Drop Files to Add'}
            </Text>
          </Center>
        ) : null}
        <ComposerInput
          value={draft.text}
          onValue={(text) => {
            onDraft({ ...draft, text, mentions: mentionText(text).mentions });
          }}
          mentions={mentions}
          slashCommands={capabilities.slashCommands === true}
          label={label}
          describedBy={phase.hint === null ? undefined : 'composer-hint'}
          placeholder={phase.placeholder}
          disabled={locked}
          inputRef={field}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (isComposing(event)) return;
            if (!isSendKey(event)) return;
            // With a suggestion list open Enter belongs to the list, which picks the highlighted one.
            if (suggestionsOpen(event.currentTarget)) return;
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
            accept={uploads?.accept ?? pickerAccept(capabilities.images)}
            aria-label={uploads === undefined ? 'Choose pictures' : 'Choose files'}
            onChange={(event) => {
              addFiles([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = '';
            }}
          />
        ) : null}
        <Group justify="space-between" wrap="nowrap" gap="xs" pt={4}>
          <Group gap="xs" wrap="nowrap">
            {leading}
            {canAttach ? (
              <ActionIcon
                variant="subtle"
                size="lg"
                aria-label={attachLabel}
                disabled={locked}
                onClick={() => {
                  picker.current?.click();
                }}
              >
                <IconPaperclip size={18} stroke={1.5} />
              </ActionIcon>
            ) : null}
            <DictationButton inputRef={field} disabled={locked} onError={setFailure} />
            {modelControl}
          </Group>
          <Group gap="xs" wrap="nowrap">
            {disabledReason !== null ? (
              <Text size="xs" c="dimmed" lineClamp={2}>
                {disabledReason}
              </Text>
            ) : (failure ?? error) === null ? null : (
              <Text size="xs" c="red" lineClamp={2}>
                {failure ?? error}
              </Text>
            )}
            {phase.stop === null ? null : (
              <ActionIcon
                variant="default"
                size="lg"
                loading={stopping !== null}
                disabled={locked}
                aria-label={phase.stop === 'stop_and_redo' ? 'Stop and Redo' : 'Stop'}
                onClick={stop}
              >
                <IconPlayerStopFilled size={16} />
              </ActionIcon>
            )}
            {actions}
            {phase.send === 'hidden' ? null : (
              <ActionIcon
                variant={phase.send === 'filled' ? 'filled' : 'default'}
                size="lg"
                loading={sending}
                disabled={locked || disabledReason !== null || !filled}
                aria-label="Send"
                onClick={send}
              >
                <IconCornerDownLeft size={18} stroke={1.5} />
              </ActionIcon>
            )}
          </Group>
        </Group>
      </Box>
      {phase.hint === null ? null : (
        <Text id="composer-hint" size="xs" c="dimmed">
          {phase.hint}
        </Text>
      )}
      {notes}
    </Stack>
  );
}
