import type { ShapeMessageDto } from '@10db/contracts';
import { Box, ScrollArea, Stack, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';

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
export function Transcript({ messages }: { readonly messages: readonly ShapeMessageDto[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const blocks = blocksOf(messages);

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
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' }}
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
