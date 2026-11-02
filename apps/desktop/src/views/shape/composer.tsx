import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { isSendKey } from './use-shape-keys';

export interface ComposerProps {
  /** No builder message yet: the input takes focus and the hint says what nothing does until you act. */
  readonly firstRun: boolean;
  readonly answering: boolean;
  /** A Propose turn is queued or running; pressing again would be ignored. */
  readonly proposing: boolean;
  readonly proposeLabel: 'Propose' | 'Propose Again';
  readonly canPropose: boolean;
  /** Sends the text; rejects with the daemon's words. */
  readonly onSend: (text: string) => Promise<void>;
  readonly onPropose: () => void;
  readonly onStop: () => void;
  /** Why the conversation could not load, shown above the input in red. */
  readonly error: string | null;
}

const FIRST_RUN_PLACEHOLDER = 'Talk it through, drop a document, or paste a list…';

/** The input, Send, the group's one filled primary Propose, and Stop while a turn runs. */
export function Composer(props: ComposerProps) {
  const { firstRun, answering, proposing, proposeLabel, canPropose } = props;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (firstRun) input.current?.focus();
  }, [firstRun]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || sending) return;
    setSending(true);
    setFailure(null);
    try {
      await props.onSend(text);
      setDraft('');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const shown = failure ?? props.error;

  return (
    <Stack gap="xs" px="md" pb="md" pt="xs" style={{ flex: 'none' }}>
      {shown === null ? null : (
        <Alert color="red" title="Couldn't reach Claude">
          {shown}
        </Alert>
      )}
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
        onKeyDown={(event) => {
          if (isSendKey(event)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text id="shape-composer-hint" size="xs" c="dimmed">
          {firstRun
            ? 'Nothing is proposed until you press Propose. Nothing starts until you Convert.'
            : '⌘↩ sends · ⌘⇧↩ proposes · Esc stops'}
        </Text>
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
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
          <Button loading={proposing} disabled={!canPropose} onClick={props.onPropose}>
            {proposeLabel}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
