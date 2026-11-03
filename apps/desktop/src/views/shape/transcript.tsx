import type { ShapeMessageDto } from '@10db/contracts';
import { Box, ScrollArea, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';

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
  const blocks = blocksOf(messages);
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
        {blocks.map((block, index) => (
          <Box
            key={block.id}
            {...{ [MESSAGE_ATTRIBUTE]: block.id }}
            {...(marked.has(block.id) ? { 'data-highlighted': true } : {})}
            style={{
              contentVisibility: 'auto',
              containIntrinsicSize: 'auto 40px',
              ...(marked.has(block.id)
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
                {blocks[index - 1]?.kind === 'text' &&
                (blocks[index - 1] as { who?: string }).who === block.who ? null : (
                  <Text size="xs" c="dimmed" mb={2}>
                    {block.who}
                  </Text>
                )}
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
        ))}
      </Stack>
    </ScrollArea>
  );
}
