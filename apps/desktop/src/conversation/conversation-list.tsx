import type { ToolCallView } from '@10db/contracts';
import { Box, Button, ScrollArea, VisuallyHidden } from '@mantine/core';
import { IconArrowDown } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  conversationArticles,
  conversationRows,
  rowId,
  type ConversationArticle,
  type ConversationRow,
} from './conversation-rows';
import type { ConversationEntry } from './entry';
import { ConversationEntryView } from './entry-view';
import { EditGroupRow, ToolCallCard, ToolGroupRow } from './tool-call-card';

/** Marks a row with the id of the entry it draws, or its group's first. */
const MESSAGE_ATTRIBUTE = 'data-message-id';
/** Articles mounted past each edge of the viewport, so a scroll rarely shows an empty gap. */
const OVERSCAN_ARTICLES = 6;
/** An article's height before it is measured; a two-line reply with its spacing. */
const estimateArticleSize = (): number => 72;
/** How far above the tail the builder reads before new rows stop pulling the list down. */
const FOLLOW_DISTANCE = 120;

type LoadFull = (callId: string) => Promise<string>;

export interface ConversationListProps {
  readonly entries: readonly ConversationEntry[];
  /** Marks the rows of these ids; each new `nonce` scrolls to the first of them again (Plan's Why?). */
  readonly highlight: { readonly ids: readonly string[]; readonly nonce: number } | null;
  /** Loads a call's full output or patch; without it, rows offer neither. */
  readonly loadFull?: LoadFull;
  /** Sends the builder's go-ahead for a call the judge held back softly. */
  readonly onAllow?: (call: ToolCallView) => void;
  /** The agent's hidden speaker heading: its capabilities' label, never a provider's name. */
  readonly agentLabel: string;
}

/** The entry ids a row draws. */
function idsOf(row: ConversationRow): readonly string[] {
  switch (row.kind) {
    case 'entry':
      return [row.entry.id];
    case 'tool':
      return [row.entry.id, ...row.nested.map((n) => n.id)];
    case 'tool_group':
    case 'edit_group':
      return row.entries.map((e) => e.id);
  }
}

const isToolRow = (row: ConversationRow): boolean => row.kind !== 'entry';

/**
 * Space above a row (sessions UI spec §7.1): 2 px between consecutive tool rows, 8 px around a run
 * of them, 12 px between replies.
 */
function gapAbove(before: ConversationRow | undefined, row: ConversationRow): number {
  if (before === undefined) return 0;
  if (isToolRow(before) && isToolRow(row)) return 2;
  if (isToolRow(before) || isToolRow(row)) return 8;
  return 12;
}

/**
 * The conversation as a windowed column of articles: one per builder message, and one per agent
 * turn holding its replies, tool rows and notices. Only the articles near the viewport are mounted;
 * `WindowedArticles` does that, apart from this component, so that scrolling re-renders the window
 * and never re-derives the rows of the whole conversation.
 */
export function ConversationList({
  entries,
  highlight,
  loadFull,
  onAllow,
  agentLabel,
}: ConversationListProps) {
  const articles = conversationArticles(conversationRows(entries));
  const marked = new Set(highlight?.ids ?? []);
  const targetIndex =
    highlight === null
      ? -1
      : articles.findIndex((a) => a.rows.some((r) => idsOf(r).some((id) => marked.has(id))));
  return (
    <WindowedArticles
      articles={articles}
      entryCount={entries.length}
      marked={marked}
      highlightNonce={highlight?.nonce}
      targetIndex={targetIndex}
      loadFull={loadFull}
      onAllow={onAllow}
      agentLabel={agentLabel}
    />
  );
}

interface WindowedArticlesProps {
  readonly articles: readonly ConversationArticle[];
  /** Grows with every new entry, which may join the last article rather than start one. */
  readonly entryCount: number;
  readonly marked: ReadonlySet<string>;
  readonly highlightNonce: number | undefined;
  /** The article holding the first highlighted row, or -1. */
  readonly targetIndex: number;
  readonly loadFull: LoadFull | undefined;
  readonly onAllow: ((call: ToolCallView) => void) | undefined;
  readonly agentLabel: string;
}

function WindowedArticles({
  articles,
  entryCount,
  marked,
  highlightNonce,
  targetIndex,
  loadFull,
  onAllow,
  agentLabel,
}: WindowedArticlesProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [aboveTail, setAboveTail] = useState(false);
  // The compiler skips a component that calls useVirtualizer, so this one is written by hand: a new
  // function each render would have the virtualizer recompute every article's position on each scroll.
  const getItemKey = useCallback((index: number) => articles[index]?.id ?? index, [articles]);
  // eslint-disable-next-line react-hooks/incompatible-library -- the skip is why this is its own component.
  const virtualizer = useVirtualizer({
    count: articles.length,
    getScrollElement: () => viewport.current,
    estimateSize: estimateArticleSize,
    getItemKey,
    overscan: OVERSCAN_ARTICLES,
  });

  // Why? scrolls to the article holding the first marked row, then brings that row into view when
  // the article is taller than the viewport.
  useEffect(() => {
    if (highlightNonce === undefined || targetIndex === -1) return;
    virtualizer.scrollToIndex(targetIndex, { align: 'center' });
    const frame = requestAnimationFrame(() => {
      const el = viewport.current;
      const row = el?.querySelector('[data-highlighted]');
      if (el === null || row === null || row === undefined) return;
      const box = row.getBoundingClientRect();
      const pane = el.getBoundingClientRect();
      if (box.top < pane.top) el.scrollTop -= pane.top - box.top;
      else if (box.bottom > pane.bottom)
        el.scrollTop += Math.min(box.bottom - pane.bottom, box.top - pane.top);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [virtualizer, highlightNonce, targetIndex]);

  // A new entry scrolls into view, unless the builder has scrolled up to read.
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_DISTANCE;
    if (nearBottom || entryCount <= 1) virtualizer.scrollToEnd();
  }, [virtualizer, entryCount]);

  const onScroll = useCallback(() => {
    const el = viewport.current;
    if (el === null) return;
    setAboveTail(el.scrollHeight - el.scrollTop - el.clientHeight >= FOLLOW_DISTANCE);
  }, []);

  const items = virtualizer.getVirtualItems();
  return (
    <Box
      style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ScrollArea
        style={{ flex: 1, minHeight: 0 }}
        viewportRef={viewport}
        viewportProps={{ tabIndex: 0, role: 'group', 'aria-label': 'Messages', onScroll }}
      >
        <div style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
          <Box
            px="md"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${String(items[0]?.start ?? 0)}px)`,
            }}
          >
            {items.map((item) => {
              const article = articles[item.index];
              if (article === undefined) return null;
              return (
                // The spacing is part of the article, so the virtualizer measures it too.
                <Box
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  pt={article.speaker === 'builder' ? 20 : item.index === 0 ? 'md' : 0}
                  pb="md"
                >
                  <Article
                    article={article}
                    marked={marked}
                    loadFull={loadFull}
                    onAllow={onAllow}
                    agentLabel={agentLabel}
                  />
                </Box>
              );
            })}
          </Box>
        </div>
      </ScrollArea>
      {aboveTail && (
        <Button
          size="compact-sm"
          variant="default"
          leftSection={<IconArrowDown size={14} stroke={1.5} />}
          pos="absolute"
          bottom={12}
          left="50%"
          style={{ transform: 'translateX(-50%)' }}
          onClick={() => {
            virtualizer.scrollToEnd();
          }}
        >
          Jump to Latest
        </Button>
      )}
    </Box>
  );
}

interface ArticleProps {
  readonly article: ConversationArticle;
  readonly marked: ReadonlySet<string>;
  readonly loadFull: LoadFull | undefined;
  readonly onAllow: ((call: ToolCallView) => void) | undefined;
  readonly agentLabel: string;
}

/** One message: a hidden heading saying who speaks, then its rows. */
function Article({ article, marked, loadFull, onAllow, agentLabel }: ArticleProps) {
  const heading = useId();
  return (
    <article aria-labelledby={heading}>
      <VisuallyHidden>
        <h2 id={heading}>{article.speaker === 'builder' ? 'You' : agentLabel}</h2>
      </VisuallyHidden>
      {article.rows.map((row, i) => {
        const highlighted = idsOf(row).some((id) => marked.has(id));
        return (
          <Box
            key={rowId(row)}
            mt={gapAbove(article.rows[i - 1], row)}
            {...{ [MESSAGE_ATTRIBUTE]: rowId(row) }}
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
            <RowView row={row} loadFull={loadFull} onAllow={onAllow} />
          </Box>
        );
      })}
    </article>
  );
}

function RowView({
  row,
  loadFull,
  onAllow,
}: {
  readonly row: ConversationRow;
  readonly loadFull: LoadFull | undefined;
  readonly onAllow: ((call: ToolCallView) => void) | undefined;
}) {
  const load = loadFull === undefined ? {} : { loadFull };
  switch (row.kind) {
    case 'entry':
      return <ConversationEntryView entry={row.entry} />;
    case 'tool':
      return (
        <ToolCallCard
          entry={row.entry}
          nested={row.nested}
          {...load}
          {...(onAllow === undefined ? {} : { onAllow })}
        />
      );
    case 'tool_group':
      return <ToolGroupRow entries={row.entries} />;
    case 'edit_group':
      return <EditGroupRow entries={row.entries} {...load} />;
  }
}
