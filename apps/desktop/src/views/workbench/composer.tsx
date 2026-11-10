import { ActionIcon, Box, Button, CloseButton, Group, Stack, Text, Textarea } from '@mantine/core';
import { IconPhotoPlus } from '@tabler/icons-react';
import {
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { isSendKey } from '../shape/use-shape-keys';
import { ComposerPhase, composerButtons, composerPhase } from './composer-buttons';
import { EMPTY_DRAFT, hasContent, type Draft } from './drafts';
import type { PageStatus } from './page-status';
import { PICTURE_PICKER_ACCEPT, withPictures } from './pictures';

/** What a page's composer asks the daemon to do; each rejects with the daemon's words. */
export interface PageActions {
  readonly send: (draft: Draft) => Promise<void>;
  /** A plain Stop: the turn ends and nothing is sent. */
  readonly stop: () => Promise<void>;
  /** Stops the turn and starts it again from the draft. */
  readonly redo: (draft: Draft) => Promise<void>;
  readonly signOff: () => Promise<void>;
}

export interface ComposerProps {
  /** The page's name, for the placeholder. */
  readonly area: string;
  readonly status: PageStatus;
  /** Nothing has been said to the page yet. */
  readonly firstMessage: boolean;
  /** The page's draft, kept by the workspace per page. */
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
  readonly actions: PageActions;
  /** Open Page, always on the left. */
  readonly openPage: ReactNode;
  /** The input, which the workspace focuses when a page is selected. */
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>;
}

type Busy = 'send' | 'stop' | 'signOff';

function placeholder(area: string, phase: ComposerPhase, firstMessage: boolean): string {
  if (firstMessage) return `What should change on ${area}? Paste a screenshot…`;
  return phase === ComposerPhase.Working ? 'Add to this turn…' : 'Reply, or paste a screenshot…';
}

/**
 * A page's composer (Workbench spec §4.3, design review D14): the input, its pictures, Open Page on the
 * left and the buttons `composerButtons` gives for the page's state. ⌘↩ sends.
 */
export function Composer({
  area,
  status,
  firstMessage,
  draft,
  onDraft,
  actions,
  openPage,
  inputRef,
}: ComposerProps) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState<readonly string[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const phase = composerPhase(status);
  const buttons = composerButtons(phase, hasContent(draft));

  const addPictures = (files: readonly File[]): void => {
    if (files.length === 0) return;
    const added = withPictures(draft.pictures, files);
    setRefused(added.refused);
    onDraft({ ...draft, pictures: added.pictures });
  };

  const run = async (which: Busy, action: () => Promise<void>, clears: boolean): Promise<void> => {
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
    if (buttons.send?.enabled !== true || busy === 'send') return;
    void run('send', () => actions.send(draft), true);
  };
  const stop = (): void => {
    if (buttons.stop === 'redo') void run('stop', () => actions.redo(draft), true);
    else void run('stop', actions.stop, false);
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
        style={{
          outline: dragging ? '1px dashed var(--mantine-color-dimmed)' : undefined,
          outlineOffset: 2,
          borderRadius: 'var(--mantine-radius-sm)',
        }}
      >
        <Textarea
          ref={inputRef}
          aria-label={`Message to ${area}`}
          autosize
          minRows={1}
          maxRows={8}
          placeholder={placeholder(area, phase, firstMessage)}
          value={draft.text}
          onChange={(event) => {
            onDraft({ ...draft, text: event.currentTarget.value });
          }}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (!isSendKey(event)) return;
            event.preventDefault();
            send();
          }}
        />
      </Box>
      {draft.pictures.length === 0 ? null : (
        <Group component="ul" aria-label="Pictures to send" gap="xs" m={0} p={0}>
          {draft.pictures.map((picture, index) => (
            <Group component="li" key={`${String(index)}-${picture.name}`} gap={4} wrap="nowrap">
              <Text size="xs" ff="monospace">
                {picture.name}
              </Text>
              <CloseButton
                size="xs"
                aria-label={`Remove ${picture.name}`}
                onClick={() => {
                  onDraft({ ...draft, pictures: draft.pictures.filter((_, i) => i !== index) });
                }}
              />
            </Group>
          ))}
        </Group>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept={PICTURE_PICKER_ACCEPT}
        aria-label="Choose pictures"
        onChange={(event) => {
          addPictures([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = '';
        }}
      />
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap="xs" wrap="nowrap">
          {openPage}
          <ActionIcon
            variant="subtle"
            size="lg"
            aria-label="Add Picture"
            onClick={() => {
              picker.current?.click();
            }}
          >
            <IconPhotoPlus size={18} stroke={1.5} />
          </ActionIcon>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {failure === null ? null : (
            <Text size="xs" c="red" lineClamp={2}>
              {failure}
            </Text>
          )}
          {buttons.stop === null ? null : (
            <Button variant="default" loading={busy === 'stop'} onClick={stop}>
              {buttons.stop === 'redo' ? 'Stop and Redo' : 'Stop'}
            </Button>
          )}
          {buttons.signOff === null ? null : (
            <Button
              variant={buttons.signOff}
              loading={busy === 'signOff'}
              onClick={() => {
                void run('signOff', actions.signOff, false);
              }}
            >
              Sign Off
            </Button>
          )}
          {buttons.send === null ? null : (
            <Button
              variant={buttons.send.variant}
              disabled={!buttons.send.enabled}
              loading={busy === 'send'}
              onClick={send}
            >
              Send
            </Button>
          )}
        </Group>
      </Group>
    </Stack>
  );
}
