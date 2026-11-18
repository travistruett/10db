import { WorkPlace, type ChatWork, type ChatWorkStateDto } from '@10db/contracts';
import { Box, Button, Group, Text } from '@mantine/core';
import { OWNS_ESCAPE_ATTRIBUTE } from '../../conversation/escape';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

// Sessions spec §3: the bar above the composer that asks where a session's work happens, the first time it
// goes to change files.

export interface WorkBarProps {
  /** The agent's name, `capabilities.label`. */
  readonly agentLabel: string;
  /** The branch the builder's checkout is on, for "Here, on …"; null while it is not known. */
  readonly branch: string | null;
  /** The session's work state, once read; the bar is drawn without it. */
  readonly state: ChatWorkStateDto | undefined;
  /** Esc hid the bar; it stays hidden until a refused change asks again. */
  readonly onHide: () => void;
  readonly onChoose: (place: 'here' | 'branch') => void;
  readonly pending: boolean;
  /** What the daemon said of a choice that came too late: where the session works now. */
  readonly settled: ChatWork | null;
  /** The choice's failure, said beside the buttons. */
  readonly error: string | null;
}

/** The holder's sentence as a clause: the daemon writes it with a backticked branch and a closing period. */
const holderWords = (holder: string): string => holder.replaceAll('`', '').replace(/\.$/, '');

const files = (n: number): string => `${String(n)} uncommitted ${n === 1 ? 'file' : 'files'}`;

/** What a choice that lost to another says: the place that won. */
export function settledWords(work: ChatWork): string {
  switch (work.place) {
    case WorkPlace.Here:
      return 'This session already works here, in your checkout.';
    case WorkPlace.Moving:
    case WorkPlace.Branch:
      return work.branch === null
        ? 'This session already moved to a new branch.'
        : `This session already moved to ${work.branch}.`;
    case WorkPlace.Choosing:
      return 'This session is still waiting for your choice.';
  }
}

/**
 * The question and its two answers. 1 and 2 choose, Esc hides the bar, and it takes focus when it appears
 * unless the builder is typing in the composer.
 */
export function WorkBar({
  agentLabel,
  branch,
  state,
  onHide,
  onChoose,
  pending,
  settled,
  error,
}: WorkBarProps): ReactNode {
  const bar = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    // Typing is words in a field; an empty composer, which a tab opens focused, does not keep the bar away.
    const typing =
      (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
      active.value !== '';
    if (!typing) bar.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // A choice on its way is not asked twice.
    if (event.key === '1' || event.key === '2') {
      if (!pending) onChoose(event.key === '1' ? 'here' : 'branch');
    } else if (event.key === 'Escape') onHide();
    else return;
    event.preventDefault();
  };

  const uncommitted = state?.uncommittedInCheckout ?? 0;
  const holder = state?.holder ?? null;
  const refusal = error ?? state?.refusal ?? null;
  return (
    // The bar answers 1, 2 and Esc while it has focus; its buttons are the pointer's way.
    <Box
      ref={bar}
      role="group"
      aria-label="Where this work happens"
      tabIndex={-1}
      // Esc hides the bar; the turn's Stop must not hear it too.
      {...{ [OWNS_ESCAPE_ATTRIBUTE]: '' }}
      onKeyDown={onKeyDown}
      mx="md"
      mb="xs"
      px={12}
      py={10}
      style={{
        background: 'var(--mantine-color-default)',
        borderRadius: 12,
        boxShadow: 'inset 3px 0 0 var(--mantine-color-blue-filled)',
        outline: 'none',
      }}
    >
      <Text size="sm">
        <b>{agentLabel} is about to start changing files.</b> Where should this work happen?
      </Text>
      {uncommitted === 0 ? null : (
        <Text size="xs" c="dimmed">
          A new branch starts from your last commit. Your {files(uncommitted)} stay in your
          checkout.
        </Text>
      )}
      {holder === null ? null : (
        <Text size="xs" c="dimmed">
          {holderWords(holder)}; this session will wait for it.
        </Text>
      )}
      {refusal === null ? null : (
        <Text size="xs" c="red" role="alert">
          {refusal}
        </Text>
      )}
      {settled === null ? null : (
        <Text size="xs" c="dimmed" role="status">
          {settledWords(settled)}
        </Text>
      )}
      <Group gap="xs" mt={8}>
        <Button
          size="xs"
          variant="default"
          disabled={pending}
          onClick={() => {
            onChoose('here');
          }}
        >
          {branch === null ? 'Here' : `Here, on ${branch}`}
        </Button>
        <Button
          size="xs"
          disabled={pending}
          onClick={() => {
            onChoose('branch');
          }}
        >
          On a New Branch
        </Button>
      </Group>
    </Box>
  );
}
