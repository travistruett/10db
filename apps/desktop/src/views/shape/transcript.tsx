import type { ShapeMessageDto } from '@10db/contracts';
import { Box, ScrollArea, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { memo, useEffect, useMemo, useRef } from 'react';

/** Marks a transcript block with its message id, so Why? can find the messages a row came from. */
const MESSAGE_ATTRIBUTE = 'data-message-id';

export interface TranscriptProps {
  readonly messages: readonly ShapeMessageDto[];
  /** The messages a row's Why? points at; a new `nonce` scrolls to them again. */
  readonly why: { readonly ids: readonly string[]; readonly nonce: number } | null;
}

/** One line of the transcript, as it is drawn. */
type Block =
  | {
      readonly kind: 'text';
      readonly id: string;
      readonly who: 'You' | 'Claude';
      readonly body: string;
    }
  | { readonly kind: 'tool'; readonly id: string; readonly body: string }
  | { readonly kind: 'note'; readonly id: string; readonly body: string };

/** Which messages show, and how: the digest and edit notes are for the session, not the builder. */
export function blocksOf(messages: readonly ShapeMessageDto[]): Block[] {
  return messages.flatMap((m): Block[] => {
    switch (m.kind) {
      case 'text':
        if (m.author === 'note') return [{ kind: 'note', id: m.id, body: m.body }];
        return [
          {
            kind: 'text',
            id: m.id,
            who: m.author === 'builder' ? 'You' : 'Claude',
            body: m.body,
          },
        ];
      case 'tool':
        return [{ kind: 'tool', id: m.id, body: m.body }];
      case 'propose':
        return [{ kind: 'note', id: m.id, body: 'You pressed Propose.' }];
      case 'rehearse':
        return [{ kind: 'note', id: m.id, body: m.body }];
      case 'event':
      case 'notice':
        return [{ kind: 'note', id: m.id, body: m.body }];
      case 'edit':
      case 'digest':
        return [];
    }
  });
}

/**
 * The conversation as plain text blocks, not bubbles: the builder's in bright text, Claude's in
 * the default, tool use as one dimmed line. Text is never rendered as markup. Long conversations
 * keep their off-screen blocks cheap with `content-visibility`.
 */
export function Transcript({ messages, why }: TranscriptProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => blocksOf(messages), [messages]);
  const marked = new Set(why?.ids ?? []);

  // Why? on a row scrolls to the first message it came from, whatever the builder was reading.
  const nonce = why?.nonce;
  const first = why?.ids.find((id) => blocks.some((b) => b.id === id));
  useEffect(() => {
    if (nonce === undefined || first === undefined) return;
    viewport.current
      ?.querySelector<HTMLElement>(`[${MESSAGE_ATTRIBUTE}="${first}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [nonce, first]);

  // New text scrolls into view, unless the builder has scrolled up to read.
  const last = blocks.length;
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || last <= 1) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <ScrollArea
      style={{ flex: 1, minHeight: 0 }}
      viewportRef={viewport}
      viewportProps={{ tabIndex: 0, role: 'group', 'aria-label': 'Messages' }}
    >
      <Stack gap="md" px="md" py="md">
        {blocks.map((block, index) => {
          const before = blocks[index - 1];
          return (
            <TranscriptBlock
              key={block.id}
              block={block}
              showWho={
                !(before?.kind === 'text' && block.kind === 'text' && before.who === block.who)
              }
              highlighted={marked.has(block.id)}
            />
          );
        })}
      </Stack>
    </ScrollArea>
  );
}

interface TranscriptBlockProps {
  readonly block: Block;
  /** Names the speaker above a text block, unless the block before it is the same speaker's. */
  readonly showWho: boolean;
  readonly highlighted: boolean;
}

/**
 * One block. Memoized, so a new message or a Why? highlight re-renders only the blocks it touches,
 * not all of a 2,000-message conversation; `content-visibility: auto` lets the browser skip the
 * layout and paint of the blocks that are off screen, and `contain-intrinsic-size` keeps the
 * scrollbar steady while it does.
 */
const TranscriptBlock = memo(function TranscriptBlock({
  block,
  showWho,
  highlighted,
}: TranscriptBlockProps) {
  return (
    <Box
      {...{ [MESSAGE_ATTRIBUTE]: block.id }}
      {...(highlighted ? { 'data-highlighted': true } : {})}
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 40px',
        ...(highlighted
          ? {
              background: 'var(--mantine-color-default-hover)',
              borderRadius: 'var(--mantine-radius-sm)',
              margin: '0 calc(var(--mantine-spacing-xs) * -1)',
              padding: '0 var(--mantine-spacing-xs)',
            }
          : {}),
      }}
    >
      {block.kind === 'text' ? (
        <>
          {showWho ? (
            <Text size="xs" c="dimmed" mb={2}>
              {block.who}
            </Text>
          ) : null}
          <Text
            size="sm"
            {...(block.who === 'You' ? { c: 'bright' } : {})}
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {block.body}
          </Text>
        </>
      ) : block.kind === 'tool' ? (
        <Text
          size="xs"
          c="dimmed"
          ff="monospace"
          pl="xs"
          style={{
            borderLeft: '2px solid var(--mantine-color-default-border)',
            overflowWrap: 'anywhere',
          }}
        >
          {block.body}
        </Text>
      ) : (
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          <IconInfoCircle
            size={14}
            stroke={1.5}
            aria-hidden="true"
            style={{ verticalAlign: '-2px' }}
          />{' '}
          {block.body}
        </Text>
      )}
    </Box>
  );
});
