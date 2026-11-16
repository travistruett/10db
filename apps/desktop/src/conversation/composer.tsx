import { FolderWhileHeld, type AgentCapabilitiesDto } from '@10db/contracts';
import {
  ActionIcon,
  Box,
  Button,
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
import { EMPTY_DRAFT, hasContent, type Draft } from './drafts';
import { isComposing, isSendKey, OWNS_ESCAPE_ATTRIBUTE } from './escape';
import { mentionText } from './mention-text';
import { pickerAccept, withPictures } from './pictures';

// Sessions UI spec §7.9, §7.11: one frame holding the input and its bar, with the hint under it. Enter
// sends and Shift+Enter is a new line, never while an IME composes and never while an `@` or `/` list
// is open, where Enter picks; pictures paste, drop or attach and wait as thumbnails.

/**
 * Your folder is held by a writer that keeps this turn from writing (sessions spec §7.3): Send asks first
 * how the message should run.
 */
export interface ComposerHeld {
  /** The holders, as a sentence part: "the task ‘Bump vite’". */
  readonly holders: string;
  /** Sends the draft as the builder chose; rejects with the daemon's words, and the draft stays. */
  readonly onChoose: (
    draft: Draft,
    choice: FolderWhileHeld,
    how: 'send' | 'redo',
  ) => Promise<void> | void;
  /** File as Tasks: the standing request goes, and the draft stays; a tab with no conversation has none. */
  readonly onFileAsTasks?: () => Promise<void> | void;
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
  /** Nothing can be typed either: the account has no chat to offer. */
  readonly locked?: boolean;
  /** Sends the draft; rejects with the daemon's words, and the draft stays. */
  readonly onSend: (draft: Draft) => Promise<void> | void;
  /** A plain Stop: the turn ends and nothing is sent; a rejection's words show beside Send. */
  readonly onStop: () => Promise<void> | void;
  /** Stops the turn and sends the draft as the next one. */
  readonly onRedo: (draft: Draft) => Promise<void> | void;
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
  /** Set while a writer keeps the turn from Your folder; Send then offers the choices. */
  readonly held?: ComposerHeld;
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
  held,
}: ComposerProps) {
  const [busy, setBusy] = useState<'send' | 'stop' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState<readonly string[]>([]);
  const [choosing, setChoosing] = useState<'send' | 'redo' | null>(null);
  const [dragging, setDragging] = useState(false);
  const waitButton = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const ownInput = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const field = inputRef ?? ownInput;
  const canAttach = capabilities.images.length > 0;
  const filled = hasContent(draft);

  // The choices belong to a held folder: when it frees, Send sends as it always does.
  const asking = held !== undefined && choosing !== null;
  if (held === undefined && choosing !== null) setChoosing(null);
  useEffect(() => {
    if (asking) waitButton.current?.focus();
  }, [asking]);

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
    if (held !== undefined) {
      setChoosing('send');
      return;
    }
    void run('send', () => onSend(outgoing(draft)), true);
  };
  const stop = (): void => {
    if (phase.stop !== 'stop_and_redo') {
      void run('stop', onStop, false);
    } else if (held !== undefined) {
      setChoosing('redo');
    } else {
      void run('stop', () => onRedo(outgoing(draft)), true);
    }
  };
  const choose = (choice: FolderWhileHeld): void => {
    if (held === undefined || choosing === null || busy !== null) return;
    if (locked || disabledReason !== null) return;
    const how = choosing;
    setChoosing(null);
    void run(
      how === 'redo' ? 'stop' : 'send',
      () => held.onChoose(outgoing(draft), choice, how),
      true,
    );
  };
  const cancelChoice = (): void => {
    setChoosing(null);
    field.current?.focus();
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
              Drop Pictures to Attach
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
            if (asking && event.key === 'Escape') {
              event.preventDefault();
              cancelChoice();
              return;
            }
            if (!isSendKey(event)) return;
            if (asking) {
              // The choices are on screen: ⌘↩ waits, and a plain Enter picks nothing.
              event.preventDefault();
              if (event.metaKey || event.ctrlKey) choose(FolderWhileHeld.Wait);
              return;
            }
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
            accept={pickerAccept(capabilities.images)}
            aria-label="Choose pictures"
            onChange={(event) => {
              addPictures([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = '';
            }}
          />
        ) : null}
        {held !== undefined && asking ? (
          <Box
            role="group"
            aria-label="Your folder is in use"
            pt="xs"
            {...{ [OWNS_ESCAPE_ATTRIBUTE]: '' }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelChoice();
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                choose(FolderWhileHeld.Wait);
              }
            }}
          >
            <Text size="sm">Your folder is in use by {held.holders}.</Text>
            <Group gap="xs" pt={4}>
              <Button
                ref={waitButton}
                size="xs"
                onClick={() => {
                  choose(FolderWhileHeld.Wait);
                }}
              >
                Wait for It
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  choose(FolderWhileHeld.ReadOnly);
                }}
              >
                Send Reading Only
              </Button>
              {held.onFileAsTasks === undefined ? null : (
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => {
                    setChoosing(null);
                    if (held.onFileAsTasks !== undefined)
                      void run('send', held.onFileAsTasks, false);
                  }}
                >
                  File as Tasks
                </Button>
              )}
            </Group>
            <Text size="xs" c="dimmed" pt={4}>
              Wait for It runs this once Your folder is free, ahead of any task that hasn&apos;t
              started. Send Reading Only runs it now and changes nothing. ⌘↩ waits · Esc cancels
            </Text>
          </Box>
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
                loading={busy === 'stop'}
                disabled={locked}
                aria-label={phase.stop === 'stop_and_redo' ? 'Stop and Redo' : 'Stop'}
                onClick={stop}
              >
                <IconPlayerStopFilled size={16} />
              </ActionIcon>
            )}
            {actions}
            {phase.send === 'hidden' || asking ? null : (
              <ActionIcon
                variant={phase.send === 'filled' ? 'filled' : 'default'}
                size="lg"
                loading={busy === 'send'}
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
    </Stack>
  );
}
