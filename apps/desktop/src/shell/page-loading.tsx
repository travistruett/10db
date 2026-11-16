import { Group, Paper, Skeleton, Stack } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { useEffect, useState } from 'react';

/** A load faster than this shows nothing, so a quick page never flashes placeholders. */
export const PAGE_LOADING_DELAY_MS = 300;

export const PageLoadingShape = { List: 'list', Cards: 'cards', Lines: 'lines' } as const;
export type PageLoadingShape = (typeof PageLoadingShape)[keyof typeof PageLoadingShape];

const DEFAULT_ROWS: Readonly<Record<PageLoadingShape, number>> = {
  list: 4,
  cards: 3,
  lines: 3,
};

/** The widths of a transcript's placeholder lines. */
const LINE_WIDTHS = ['90%', '70%', '80%'] as const;

function ListRow({ animate }: { readonly animate: boolean }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <Skeleton height={18} width={18} radius="sm" animate={animate} />
      <Stack gap={6} style={{ flex: 1 }}>
        <Skeleton height={12} width="40%" animate={animate} />
        <Skeleton height={10} width="65%" animate={animate} />
      </Stack>
    </Group>
  );
}

function CardOutline({ animate }: { readonly animate: boolean }) {
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Skeleton height={14} width="35%" animate={animate} />
        <Skeleton height={10} width="80%" animate={animate} />
        <Skeleton height={10} width="55%" animate={animate} />
      </Stack>
    </Paper>
  );
}

/**
 * What a page shows in place of its content while it loads, under a header that is already drawn: quiet
 * placeholder rows in the shape of what is coming, after a short delay, never a lone spinner. They do
 * not shimmer when the builder prefers reduced motion.
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
  const [late, setLate] = useState(false);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const timer = setTimeout(() => {
      setLate(true);
    }, PAGE_LOADING_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  if (!late) return null;
  const animate = !reducedMotion;
  const placeholders = Array.from({ length: rows ?? DEFAULT_ROWS[shape] }, (_, i) => i);
  return (
    <Stack gap="md" role="status" aria-label={label}>
      {placeholders.map((i) => {
        switch (shape) {
          case PageLoadingShape.List:
            return <ListRow key={i} animate={animate} />;
          case PageLoadingShape.Cards:
            return <CardOutline key={i} animate={animate} />;
          case PageLoadingShape.Lines:
            return (
              <Skeleton
                key={i}
                height={12}
                width={LINE_WIDTHS[i % LINE_WIDTHS.length] ?? '80%'}
                animate={animate}
              />
            );
        }
      })}
    </Stack>
  );
}
