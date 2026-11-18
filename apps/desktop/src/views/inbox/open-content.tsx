import { InboxKind } from '@10db/contracts';
import { Alert, Box, Stack } from '@mantine/core';
import { CardContext } from './card-context';
import { InboxEmpty } from './inbox-empty';
import { InboxCard, type InboxCardProps } from './inbox-card';
import { OpenRowKind, type OpenRow } from './inbox-row-item';
import { PassReadyRow } from './pass-ready-row';
import { SystemCardView } from './system-card-list';

/** What the card on screen is told: the draft, and what to do with each change to it. */
export type OpenCardProps = Omit<InboxCardProps, 'item' | 'count' | 'selected' | 'framed'>;

/**
 * The content beside the panel in Open: the selected row's card, with a notice above it when the card was
 * answered elsewhere, or "Nothing needs you" when no row is left.
 */
export function OpenContent({
  row,
  notice,
  empty,
  narrowed,
  onClearFilters,
  card,
}: {
  /** The selected row; null when there is none. */
  readonly row: OpenRow | null;
  readonly notice: string | null;
  /** Whether the list has loaded and holds nothing. */
  readonly empty: boolean;
  /** Whether a search or a filter narrows the list, so an empty one says "No matches". */
  readonly narrowed: boolean;
  readonly onClearFilters: () => void;
  readonly card: OpenCardProps;
}) {
  return (
    <Stack gap="md">
      {notice === null ? null : (
        <Alert color="yellow" variant="light" role="status">
          {notice}
        </Alert>
      )}
      {empty ? (
        <InboxEmpty empty="Nothing needs you" narrowed={narrowed} onClear={onClearFilters} />
      ) : null}
      {row === null ? null : <Selected row={row} card={card} />}
    </Stack>
  );
}

function Selected({ row, card }: { readonly row: OpenRow; readonly card: OpenCardProps }) {
  if (row.kind === OpenRowKind.System) return <SystemCardView card={row.card} framed={false} />;
  if (row.row.passId !== null) return <PassReadyRow items={row.row.items} />;
  const [first] = row.row.items;
  return (
    <Box>
      <InboxCard
        {...card}
        item={first}
        count={row.row.items.length}
        selected
        framed={false}
        context={first.kind === InboxKind.Question ? <CardContext item={first} /> : null}
      />
    </Box>
  );
}
