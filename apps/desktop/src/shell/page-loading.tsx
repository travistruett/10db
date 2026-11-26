import { Group, Paper, Skeleton, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { CONTENT_WIDTH_PX, ContentWidth } from './content-width';

/** A load faster than this shows nothing, so a quick page never flashes placeholders. */
export const PAGE_LOADING_DELAY_MS = 300;

export const PageLoadingShape = { List: 'list', Cards: 'cards', Lines: 'lines' } as const;
export type PageLoadingShape = (typeof PageLoadingShape)[keyof typeof PageLoadingShape];

const DEFAULT_ROWS: Readonly<Record<PageLoadingShape, number>> = {
  list: 4,
  cards: 3,
  lines: 3,
};

/** Placeholder rows stop here on a wide window, so they read as rows and not as progress bars. */
const MAX_ROW_WIDTH = CONTENT_WIDTH_PX[ContentWidth.Reading];

/** The widths of a transcript's placeholder lines. */
const LINE_WIDTHS = ['90%', '70%', '80%'] as const;

function ListRow() {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <Skeleton height={18} width={18} radius="sm" animate={false} />
      <Stack gap={6} style={{ flex: 1 }}>
        <Skeleton height={12} width="40%" animate={false} />
        <Skeleton height={10} width="65%" animate={false} />
      </Stack>
    </Group>
  );
}

function CardOutline() {
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Skeleton height={14} width="35%" animate={false} />
        <Skeleton height={10} width="80%" animate={false} />
        <Skeleton height={10} width="55%" animate={false} />
      </Stack>
    </Paper>
  );
}

/** True once a page has waited `PAGE_LOADING_DELAY_MS`; a placeholder that draws its own shape waits on it. */
export function useLoadingDelayElapsed(): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setLate(true);
    }, PAGE_LOADING_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return late;
}

/**
 * What a page shows in place of its content while it loads, under a header that is already drawn: quiet
 * static placeholder rows in the shape of what is coming, after a short delay, never a lone spinner.
 */
export function PageLoading({
  shape,
  rows,
  label,
}: {
  readonly shape: PageLoadingShape;
  /** How many placeholder rows; each shape has its own count. */
  readonly rows?: number;
  /** What assistive tech hears, such as "Loading the pages". */
  readonly label: string;
}) {
  const late = useLoadingDelayElapsed();
  if (!late) return null;
  const placeholders = Array.from({ length: rows ?? DEFAULT_ROWS[shape] }, (_, i) => i);
  return (
    <Stack gap="md" maw={MAX_ROW_WIDTH} role="status" aria-label={label}>
      {placeholders.map((i) => {
        switch (shape) {
          case PageLoadingShape.List:
            return <ListRow key={i} />;
          case PageLoadingShape.Cards:
            return <CardOutline key={i} />;
          case PageLoadingShape.Lines:
            return (
              <Skeleton
                key={i}
                height={12}
                width={LINE_WIDTHS[i % LINE_WIDTHS.length] ?? '80%'}
                animate={false}
              />
            );
        }
      })}
    </Stack>
  );
}
