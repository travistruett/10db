import type { AgentCapabilitiesDto } from '@10db/contracts';
import { ActionIcon, Box, CloseButton, Group, Stack, Text, VisuallyHidden } from '@mantine/core';
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
import { isComposing, isSendKey } from './escape';
import { mentionText } from './mention-text';
import { pickerAccept, withPictures } from './pictures';

// Sessions UI spec §7.9, §7.11: one frame holding the input and its bar, with the hint under it. Enter
// sends and Shift+Enter is a new line, never while an IME composes and never while an `@` or `/` list
// is open, where Enter picks; pictures paste, drop or attach and wait as thumbnails.

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
        alt=""
        width={56}
        height={56}
        style={{ objectFit: 'cover', borderRadius: 'var(--mantine-radius-sm)', display: 'block' }}
      />
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
}: ComposerProps) {
  const [busy, setBusy] = useState<'send' | 'stop' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState<readonly string[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const ownInput = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const field = inputRef ?? ownInput;
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
    void run('send', () => onSend(outgoing(draft)), true);
  };
  const stop = (): void => {
    if (phase.stop === 'stop_and_redo') void run('stop', () => onRedo(outgoing(draft)), true);
    else void run('stop', onStop, false);
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
            {phase.send === 'hidden' ? null : (
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
