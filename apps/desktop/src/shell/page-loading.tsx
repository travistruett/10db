import { Box, Group, Paper, Skeleton, Stack, Table, type MantineSpacing } from '@mantine/core';
import { useEffect, useState } from 'react';
import { CONTENT_WIDTH_PX, ContentWidth } from './content-width';
import classes from './page-loading.module.css';
import { RaisedPanel } from './raised-panel';

/** The class for placeholders drawn on a raised panel or a card, where Mantine's own pulse fades out. */
export const SKELETON_ON_PANEL = classes['onPanel'];

/** A load faster than this shows nothing, so a quick page never flashes placeholders. */
export const PAGE_LOADING_DELAY_MS = 300;

export const PageLoadingShape = {
  List: 'list',
  Cards: 'cards',
  Lines: 'lines',
  /** A raised table: its real column headings over placeholder cells. */
  Table: 'table',
  /** Labelled form fields: a short label over a full-width input. */
  Fields: 'fields',
  /** A log: a short time, then a line of text. */
  Log: 'log',
} as const;
export type PageLoadingShape = (typeof PageLoadingShape)[keyof typeof PageLoadingShape];

const DEFAULT_ROWS: Readonly<Record<PageLoadingShape, number>> = {
  list: 4,
  cards: 3,
  lines: 3,
  table: 4,
  fields: 2,
  log: 6,
};

/** Placeholder rows stop here on a wide window, so they read as rows and not as progress bars. */
const MAX_ROW_WIDTH = CONTENT_WIDTH_PX[ContentWidth.Reading];

/** The widths of a transcript's placeholder lines. */
const LINE_WIDTHS = ['90%', '70%', '80%'] as const;

/** The widths of a table's placeholder cells, one per column, repeating when a table has more columns. */
const CELL_WIDTHS = ['70%', '50%', '40%', '60%', '45%'] as const;

function ListRow() {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <Skeleton height={18} width={18} radius="sm" />
      <Stack gap={6} style={{ flex: 1 }}>
        <Skeleton height={12} width="40%" />
        <Skeleton height={10} width="65%" />
      </Stack>
    </Group>
  );
}

function CardOutline() {
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Skeleton height={14} width="35%" />
        <Skeleton height={10} width="80%" />
        <Skeleton height={10} width="55%" />
      </Stack>
    </Paper>
  );
}

function FieldOutline() {
  return (
    <Stack gap={6}>
      <Skeleton height={10} width="25%" />
      <Skeleton height={36} radius="sm" />
    </Stack>
  );
}

function LogRow({ index }: { readonly index: number }) {
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <Skeleton height={10} width={52} style={{ flex: 'none' }} />
      <Skeleton height={12} width={LINE_WIDTHS[index % LINE_WIDTHS.length] ?? '80%'} />
    </Group>
  );
}

/** One column of a table: its title and, where the loaded table fixes it, its width. */
export interface PageLoadingColumn {
  readonly title: string;
  readonly width?: number | string;
}

/** A placeholder bar in a line of text of the given size, as tall as that line, so what holds it is as tall as the loaded text. */
export function LoadingTextLine({
  size,
  width,
  bar,
}: {
  readonly size: 'sm' | 'xs';
  readonly width: string;
  readonly bar: number;
}) {
  return (
    <Box fz={size} lh={size} h="1lh" style={{ display: 'flex', alignItems: 'center' }}>
      <Skeleton height={bar} width={width} />
    </Box>
  );
}

/**
 * A raised table of placeholder rows under the loaded table's own column titles and widths. Pass the loaded
 * table's spacing and scroll width so its rows and columns land where the real ones do.
 */
export function LoadingTable({
  columns,
  rows,
  cellLines = 1,
  headingRow = true,
  verticalSpacing,
  horizontalSpacing,
  minWidth,
}: {
  readonly columns: readonly PageLoadingColumn[];
  readonly rows: number;
  /** Lines in the first cell: a name over its detail. */
  readonly cellLines?: number;
  /** False for a table that draws no heading row. */
  readonly headingRow?: boolean;
  readonly verticalSpacing?: MantineSpacing;
  readonly horizontalSpacing?: MantineSpacing;
  readonly minWidth?: number;
}) {
  return (
    <Box className={SKELETON_ON_PANEL}>
      <RaisedPanel>
        <Table.ScrollContainer minWidth={minWidth ?? 0}>
          <Table
            {...(verticalSpacing === undefined ? {} : { verticalSpacing })}
            {...(horizontalSpacing === undefined ? {} : { horizontalSpacing })}
          >
            {headingRow ? (
              <Table.Thead>
                <Table.Tr>
                  {columns.map((column, index) => (
                    <Table.Th
                      key={index}
                      {...(column.width === undefined ? {} : { w: column.width })}
                    >
                      {column.title}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
            ) : null}
            <Table.Tbody>
              {Array.from({ length: rows }, (_, row) => (
                <Table.Tr key={row}>
                  {columns.map((_column, column) => (
                    <Table.Td key={column}>
                      {/* The first column carries the row's name, so it is the one with more lines. */}
                      {Array.from({ length: column === 0 ? cellLines : 1 }, (_line, line) => (
                        <LoadingTextLine
                          key={line}
                          size={line === 0 ? 'sm' : 'xs'}
                          bar={line === 0 ? 12 : 10}
                          width={
                            column === 0
                              ? line === 0
                                ? '65%'
                                : '90%'
                              : (CELL_WIDTHS[(column + row) % CELL_WIDTHS.length] ?? '50%')
                          }
                        />
                      ))}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </RaisedPanel>
    </Box>
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
 * What a page shows in place of its content while it loads, under a header that is already drawn:
 * animated placeholders in the shape of what is coming, after a short delay, never a lone spinner.
 */
export function PageLoading({
  shape,
  rows,
  label,
  columns = [],
  cellLines = 1,
  verticalSpacing,
  horizontalSpacing,
  minWidth,
}: {
  readonly shape: PageLoadingShape;
  /** How many placeholder rows; each shape has its own count. */
  readonly rows?: number;
  /** What assistive tech hears, such as "Loading the pages". */
  readonly label: string;
  /** A table's columns, the same array the loaded table draws its headings and widths from. */
  readonly columns?: readonly PageLoadingColumn[];
  /** Lines in a table's first cell: a name over its detail. */
  readonly cellLines?: number;
  /** The loaded table's own spacing, so its rows are as tall as the real ones. */
  readonly verticalSpacing?: MantineSpacing;
  readonly horizontalSpacing?: MantineSpacing;
  /** The loaded table's scroll width, which a wide table keeps. */
  readonly minWidth?: number;
}) {
  const late = useLoadingDelayElapsed();
  if (!late) return null;
  const count = rows ?? DEFAULT_ROWS[shape];
  const placeholders = Array.from({ length: count }, (_, i) => i);
  switch (shape) {
    case PageLoadingShape.Table:
      return (
        <Box role="status" aria-label={label}>
          <LoadingTable
            columns={columns}
            rows={count}
            cellLines={cellLines}
            {...(verticalSpacing === undefined ? {} : { verticalSpacing })}
            {...(horizontalSpacing === undefined ? {} : { horizontalSpacing })}
            {...(minWidth === undefined ? {} : { minWidth })}
          />
        </Box>
      );
    case PageLoadingShape.Fields:
      return (
        <Stack gap="md" role="status" aria-label={label}>
          {placeholders.map((i) => (
            <FieldOutline key={i} />
          ))}
        </Stack>
      );
    case PageLoadingShape.Log:
      return (
        <Stack gap={8} role="status" aria-label={label}>
          {placeholders.map((i) => (
            <LogRow key={i} index={i} />
          ))}
        </Stack>
      );
    case PageLoadingShape.List:
    case PageLoadingShape.Cards:
    case PageLoadingShape.Lines:
      return (
        <Stack gap="md" maw={MAX_ROW_WIDTH} role="status" aria-label={label}>
          {placeholders.map((i) =>
            shape === PageLoadingShape.List ? (
              <ListRow key={i} />
            ) : shape === PageLoadingShape.Cards ? (
              <CardOutline key={i} />
            ) : (
              <Skeleton key={i} height={12} width={LINE_WIDTHS[i % LINE_WIDTHS.length] ?? '80%'} />
            ),
          )}
        </Stack>
      );
  }
}

/**
 * A control's placeholder while the choices it offers load: the height and the width of the select or
 * input that replaces it, after the same delay.
 */
export function ControlLoading({
  label,
  width = '100%',
}: {
  readonly label: string;
  readonly width?: number | string;
}) {
  const late = useLoadingDelayElapsed();
  if (!late) return null;
  return <Skeleton height={36} width={width} radius="sm" role="status" aria-label={label} />;
}
