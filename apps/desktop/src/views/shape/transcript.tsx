import { ScreenMessageBody, type ShapeMessageDto } from '@10db/contracts';
import { Box, ScrollArea, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef } from 'react';
import { Screenshot } from './screenshot';

/** Marks a transcript block with its message id. */
const MESSAGE_ATTRIBUTE = 'data-message-id';
/** Blocks mounted past each edge of the viewport, so a scroll rarely shows an empty gap. */
const OVERSCAN_BLOCKS = 6;
/** A block's height before it is measured; a two-line reply with its spacing. */
const estimateBlockSize = (): number => 72;

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
  | {
      readonly kind: 'screen';
      readonly id: string;
      readonly shapeId: ShapeMessageDto['shapeId'];
      readonly screen: ScreenMessageBody;
    }
  | { readonly kind: 'note'; readonly id: string; readonly body: string };

/** A `screen` row's body, or null when it is not one this version understands. */
function screenOf(body: string): ScreenMessageBody | null {
  try {
    const parsed = ScreenMessageBody.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
      case 'screen': {
        const screen = screenOf(m.body);
        return screen === null ? [] : [{ kind: 'screen', id: m.id, shapeId: m.shapeId, screen }];
      }
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
 * the default, tool use as one dimmed line. Text is never rendered as markup. Only the blocks near
 * the viewport are mounted; `WindowedBlocks` does that, apart from this component so that scrolling
 * re-renders the window and never re-derives the blocks of the whole conversation.
 */
export function Transcript({ messages, why }: TranscriptProps) {
  const blocks = blocksOf(messages);
  // A row's Why? scrolls to the first of its messages that shows.
  const first = why?.ids.find((id) => blocks.some((b) => b.id === id));
  return (
    <WindowedBlocks
      blocks={blocks}
      marked={new Set(why?.ids ?? [])}
      whyNonce={why?.nonce}
      whyIndex={blocks.findIndex((b) => b.id === first)}
    />
  );
}

interface WindowedBlocksProps {
  readonly blocks: readonly Block[];
  readonly marked: ReadonlySet<string>;
  readonly whyNonce: number | undefined;
  /** The block Why? points at, or -1. */
  readonly whyIndex: number;
}

function WindowedBlocks({ blocks, marked, whyNonce, whyIndex }: WindowedBlocksProps) {
  const viewport = useRef<HTMLDivElement>(null);
  // The compiler skips a component that calls useVirtualizer, so this one is written by hand: a new
  // function each render would have the virtualizer recompute every block's position on each scroll.
  const getItemKey = useCallback((index: number) => blocks[index]?.id ?? index, [blocks]);
  // eslint-disable-next-line react-hooks/incompatible-library -- the skip is why this is its own component.
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => viewport.current,
    estimateSize: estimateBlockSize,
    getItemKey,
    overscan: OVERSCAN_BLOCKS,
  });

  // Why? on a row scrolls to the first message it came from, whatever the builder was reading.
  useEffect(() => {
    if (whyNonce === undefined || whyIndex === -1) return;
    virtualizer.scrollToIndex(whyIndex, { align: 'center' });
  }, [virtualizer, whyNonce, whyIndex]);

  // New text scrolls into view, unless the builder has scrolled up to read.
  const last = blocks.length;
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || last <= 1) virtualizer.scrollToEnd();
  }, [virtualizer, last]);

  const rows = virtualizer.getVirtualItems();
  return (
    <ScrollArea
      style={{ flex: 1, minHeight: 0 }}
      viewportRef={viewport}
      viewportProps={{ tabIndex: 0, role: 'group', 'aria-label': 'Messages' }}
    >
      <div style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
        <Box
          px="md"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${String(rows[0]?.start ?? 0)}px)`,
          }}
        >
          {rows.map((row) => {
            const block = blocks[row.index];
            if (block === undefined) return null;
            const before = blocks[row.index - 1];
            return (
              // The spacing is part of the row, so the virtualizer measures it too.
              <Box
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                pt={row.index === 0 ? 'md' : 0}
                pb="md"
              >
                <TranscriptBlock
                  block={block}
                  showWho={
                    !(before?.kind === 'text' && block.kind === 'text' && before.who === block.who)
                  }
                  highlighted={marked.has(block.id)}
                />
              </Box>
            );
          })}
        </Box>
      </div>
    </ScrollArea>
  );
}

interface TranscriptBlockProps {
  readonly block: Block;
  /** Names the speaker above a text block, unless the block before it is the same speaker's. */
  readonly showWho: boolean;
  readonly highlighted: boolean;
}

/** One block. */
function TranscriptBlock({ block, showWho, highlighted }: TranscriptBlockProps) {
  return (
    <Box
      {...{ [MESSAGE_ATTRIBUTE]: block.id }}
      {...(highlighted ? { 'data-highlighted': true } : {})}
      style={
        highlighted
          ? {
              background: 'var(--mantine-color-default-hover)',
              borderRadius: 'var(--mantine-radius-sm)',
              margin: '0 calc(var(--mantine-spacing-xs) * -1)',
              padding: '0 var(--mantine-spacing-xs)',
            }
          : undefined
      }
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
      ) : block.kind === 'screen' ? (
        <Screenshot shapeId={block.shapeId} screen={block.screen} />
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
}
