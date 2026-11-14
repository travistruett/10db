import { ConversationState, type ConversationDto, type ToolCallView } from '@10db/contracts';
import { Box, Group, Text } from '@mantine/core';
import { IconPlayerPause } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { formatDuration } from './tool-words';

// Sessions UI spec §7.5: one line pinned under the transcript, outside the windowed list, saying what
// the turn is doing. It is not a live region: it ticks, and a tick is never announced. It names no
// provider; the idle and error states draw nothing, since the transcript says those.

/** What is streaming now: the reply's text, the agent's thinking, or a tool call. */
export type Streaming = 'text' | 'reasoning' | 'tool' | null;

export interface WorkingLineProps {
  readonly conversation: ConversationDto;
  readonly streaming: Streaming;
  /** What the running tool does, as "reading a.ts". */
  readonly tool?: string;
}

/** A turn is under way in these states, so the line's clock keeps counting through them. */
const IN_TURN: ReadonlySet<ConversationState> = new Set([
  ConversationState.Starting,
  ConversationState.Running,
  ConversationState.WaitingCard,
  ConversationState.Stopping,
]);

const TICK_MS = 1_000;

/** The milliseconds since the line saw the turn begin; 0 outside a turn. */
function useTurnElapsed(inTurn: boolean): number {
  const [clock, setClock] = useState<{ readonly start: number; readonly now: number } | null>(null);
  useEffect(() => {
    if (!inTurn) return;
    const start = Date.now();
    const tick = (): void => {
      setClock({ start, now: Date.now() });
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      setClock(null);
    };
  }, [inTurn]);
  return clock === null ? 0 : clock.now - clock.start;
}

/** The line's words in each state, and whether it draws the dot or the pause icon. */
function lineOf(
  conversation: ConversationDto,
  streaming: Streaming,
  tool: string | undefined,
  elapsedMs: number,
): { readonly words: string; readonly mark: 'dot' | 'pause' | null } | null {
  switch (conversation.state) {
    case ConversationState.Starting:
      return { words: 'Waking up the session…', mark: 'dot' };
    case ConversationState.Running: {
      if (streaming === 'reasoning') return { words: 'Thinking…', mark: 'dot' };
      if (streaming === 'text') return { words: 'Writing…', mark: 'dot' };
      const working = `Working · ${formatDuration(elapsedMs) ?? '0 s'}`;
      return {
        words: streaming === 'tool' && tool !== undefined ? `${working} · ${tool}` : working,
        mark: 'dot',
      };
    }
    case ConversationState.WaitingCard:
      return { words: 'Waiting for your answer above', mark: null };
    case ConversationState.Stopping:
      return { words: 'Stopping…', mark: 'dot' };
    case ConversationState.PausedAccount:
      return {
        words:
          conversation.pausedUntil === null
            ? 'Paused: the account’s monthly limit'
            : `Paused: usage limit, resumes ${dayjs(conversation.pausedUntil).format('HH:mm')}`,
        mark: 'pause',
      };
    case ConversationState.IdleCold:
    case ConversationState.IdleWarm:
    case ConversationState.TakenOver:
    case ConversationState.EndedError:
    case ConversationState.Sealed:
      return null;
  }
}

/** What a running tool call is doing, as the line says it: "reading src/a.ts". */
export function toolDoing(call: ToolCallView): string {
  switch (call.kind) {
    case 'command':
      return `running ${call.command}`;
    case 'edit':
      return `editing ${call.path}`;
    case 'read':
      return `reading ${call.path}`;
    case 'search':
      return `searching for ${call.pattern}`;
    case 'web':
    case 'mcp':
    case 'subagent':
    case 'other':
      return call.title === '' ? 'using a tool' : `using ${call.title}`;
  }
}

export function WorkingLine({ conversation, streaming, tool }: WorkingLineProps) {
  const elapsedMs = useTurnElapsed(IN_TURN.has(conversation.state));
  const line = lineOf(conversation, streaming, tool, elapsedMs);
  if (line === null) return null;
  return (
    <Group gap="xs" px="md" pb="xs" wrap="nowrap" style={{ flex: 'none' }}>
      {line.mark === 'dot' ? (
        <Box
          aria-hidden="true"
          w={8}
          h={8}
          bg="blue"
          style={{ borderRadius: '50%', flex: 'none' }}
        />
      ) : null}
      {line.mark === 'pause' ? (
        <IconPlayerPause
          size={12}
          stroke={1.5}
          color="var(--mantine-color-orange-filled)"
          aria-hidden="true"
        />
      ) : null}
      <Text size="sm" c="dimmed" lineClamp={1}>
        {line.words}
      </Text>
    </Group>
  );
}
