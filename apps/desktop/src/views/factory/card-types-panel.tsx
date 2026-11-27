import { CARD_TYPE_DAYS, type CardTypeDto, type ProjectId } from '@10db/contracts';
import { Alert, Badge, Stack, Table, Text, Title } from '@mantine/core';
import { useCardTypes } from '../../daemon/card-types-queries';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { RaisedPanel } from '../../shell/raised-panel';

const COLUMNS = [
  'Card type',
  ...[CARD_TYPE_DAYS.Week, CARD_TYPE_DAYS.Month].flatMap((days) =>
    ['Raised', 'Acted on', 'Dismissed', 'Withdrawn'].map((name) => `${name}, ${String(days)} days`),
  ),
  '',
] as const;

function TypeRow({ card }: { readonly card: CardTypeDto }) {
  const { last7Days: week, last30Days: month } = card;
  return (
    <Table.Tr {...(card.noisy ? { bg: 'var(--mantine-color-orange-light)' } : {})}>
      <Table.Td>{card.type}</Table.Td>
      <Table.Td>{week.raised}</Table.Td>
      <Table.Td>{week.acted}</Table.Td>
      <Table.Td>{week.dismissed}</Table.Td>
      <Table.Td>{week.withdrawn}</Table.Td>
      <Table.Td>{month.raised}</Table.Td>
      <Table.Td>{month.acted}</Table.Td>
      <Table.Td>{month.dismissed}</Table.Td>
      <Table.Td>{month.withdrawn}</Table.Td>
      <Table.Td>
        {card.noisy ? (
          <Badge color="orange" variant="light">
            Noisy
          </Badge>
        ) : null}
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * What became of each type of Inbox card over the last 7 and 30 days: raised, answered with a real
 * choice, dismissed by the builder and withdrawn by 10db. A type mostly dismissed or withdrawn is marked
 * Noisy and listed first; the daemon counts, so no card is read here.
 */
export function CardTypesPanel({ projectId }: { readonly projectId: ProjectId | null }) {
  const types = useCardTypes(projectId);
  return (
    <Stack gap="xs">
      <Title order={3}>Inbox Card Types</Title>
      <Text size="sm" c="dimmed">
        Cards raised, answered with a real choice, dismissed and withdrawn by 10db, per type of
        card. A type mostly dismissed or withdrawn is marked noisy.
      </Text>
      {types.isError ? (
        <Alert color="red" title="Couldn't load the Inbox card types">
          {types.error.message}
        </Alert>
      ) : null}
      {types.isLoading ? (
        <PageLoading
          shape={PageLoadingShape.Table}
          label="Loading Inbox card types"
          headings={COLUMNS}
          rows={4}
          minWidth={720}
        />
      ) : null}
      {types.isSuccess ? (
        types.data.types.length === 0 ? (
          <Text size="sm" c="dimmed">
            No Inbox card was raised in the last 30 days.
          </Text>
        ) : (
          <RaisedPanel>
            <Table.ScrollContainer minWidth={720}>
              <Table aria-label="Inbox Card Types">
                <Table.Thead>
                  <Table.Tr>
                    {COLUMNS.map((name, index) => (
                      <Table.Th key={`${name}-${String(index)}`}>{name}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {types.data.types.map((card) => (
                    <TypeRow key={card.type} card={card} />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </RaisedPanel>
        )
      ) : null}
    </Stack>
  );
}
