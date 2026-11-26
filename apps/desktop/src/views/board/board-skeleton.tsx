import type { ProjectId } from '@10db/contracts';
import { Group, Paper, Skeleton, Stack } from '@mantine/core';
import { useLoadingDelayElapsed } from '../../shell/page-loading';
import { COLUMN_MAX_WIDTH, COLUMN_MIN_WIDTH, RAIL_WIDTH } from './board-column';
import { columnKeyId, type LayoutColumn } from './board-layout';
import { BoardScroll, COLUMNS_MIN_HEIGHT } from './board-scroll';
import { isRail, useCollapsedColumns } from './column-rail';

/** Card placeholders in an open column: its task count when known, kept between these. */
const MIN_CARDS = 2;
const MAX_CARDS = 3;

function CardPlaceholder() {
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Skeleton height={14} width="60%" animate={false} />
        <Skeleton height={10} width="85%" animate={false} />
        <Skeleton height={10} width="45%" animate={false} />
      </Stack>
    </Paper>
  );
}

function RailPlaceholder({ empty }: { readonly empty: boolean }) {
  return (
    <Paper
      radius="md"
      style={{
        flex: 'none',
        width: RAIL_WIDTH,
        border: empty
          ? '1px dashed var(--mantine-color-default-border)'
          : '1px solid var(--tendb-color-column-border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--mantine-spacing-xs)',
        paddingBlock: 'var(--mantine-spacing-xs)',
        background: empty ? 'transparent' : 'var(--tendb-color-column)',
      }}
    >
      <Skeleton height={12} width={12} animate={false} />
      <Skeleton height={64} width={14} animate={false} />
    </Paper>
  );
}

function OpenPlaceholder({ cards }: { readonly cards: number }) {
  return (
    <Paper
      radius="md"
      style={{
        flex: '1 1 0',
        minWidth: COLUMN_MIN_WIDTH,
        maxWidth: COLUMN_MAX_WIDTH,
        border: '1px solid var(--tendb-color-column-border)',
        background: 'var(--tendb-color-column)',
        overflow: 'hidden',
      }}
    >
      <Stack gap={0}>
        <Group
          justify="space-between"
          wrap="nowrap"
          h={40}
          px="sm"
          bg="var(--tendb-color-column-header)"
        >
          <Skeleton height={14} width="40%" animate={false} />
          <Skeleton height={12} width={12} animate={false} />
        </Group>
        <Stack gap="xs" p="lg">
          {Array.from({ length: cards }, (_, i) => (
            <CardPlaceholder key={i} />
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

function SkeletonColumns({
  layout,
  collapsed,
}: {
  readonly layout: readonly LayoutColumn[];
  readonly collapsed: readonly string[];
}) {
  return (
    <Stack
      flex="1 1 0px"
      mih={COLUMNS_MIN_HEIGHT}
      role="status"
      aria-label="Loading the board"
      data-testid="board-skeleton"
    >
      <BoardScroll>
        {layout.map((column) =>
          isRail(column, collapsed) ? (
            <RailPlaceholder key={columnKeyId(column.key)} empty={column.tasks.length === 0} />
          ) : (
            <OpenPlaceholder
              key={columnKeyId(column.key)}
              cards={Math.min(Math.max(column.tasks.length, MIN_CARDS), MAX_CARDS)}
            />
          ),
        )}
      </BoardScroll>
    </Stack>
  );
}

function ProjectSkeletonColumns({
  projectId,
  layout,
}: {
  readonly projectId: ProjectId;
  readonly layout: readonly LayoutColumn[];
}) {
  const { collapsed } = useCollapsedColumns(projectId);
  return <SkeletonColumns layout={layout} collapsed={collapsed} />;
}

/**
 * What the Board shows while its tasks and columns load: the loaded Board's row of columns drawn as
 * outlines, so the page keeps its shape when the data arrives. `layout` is the board's own, so what
 * is already known (the columns, the tasks, and the builder's collapsed choice for the project)
 * sets each column's width, and an unknown column is a narrow rail, as an empty one is. Ready is always open.
 * Like the other placeholders it waits out a short delay, so a quick load shows none.
 */
export function BoardSkeleton({
  projectId,
  layout,
}: {
  /** Absent while the projects load; the collapsed choice is read per project. */
  readonly projectId: ProjectId | null;
  readonly layout: readonly LayoutColumn[];
}) {
  const late = useLoadingDelayElapsed();
  if (!late) return null;
  return projectId === null ? (
    <SkeletonColumns layout={layout} collapsed={[]} />
  ) : (
    <ProjectSkeletonColumns projectId={projectId} layout={layout} />
  );
}
