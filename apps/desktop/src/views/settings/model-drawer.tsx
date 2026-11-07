import {
  isMetered,
  ModelStatus,
  type AccountDto,
  type AccountModelDto,
  type ModelProfileDto,
  type ModelRowDto,
} from '@10db/contracts';
import { Badge, Drawer, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useAccounts } from '../../daemon/account-queries';
import { useModelOffers, useModelProfiles } from '../../daemon/model-queries';
import { fromNow } from '../../shell/relative';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { formatFirstPass, formatPrice, formatScore, NO_DATA } from './model-format';
import { STATUS_LABEL, TIER_LABEL } from './model-labels';

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Why a model's status is what it is, where the status alone does not say. */
function statusReason(row: ModelRowDto, unlisted: readonly AccountDto[]): string | null {
  switch (row.status) {
    case ModelStatus.Current:
      return null;
    case ModelStatus.Superseded:
      return 'A newer model of its family exists. 10db routes to it only when you choose it.';
    case ModelStatus.Retired:
      return 'Its maker has retired it.';
    case ModelStatus.NotRunnable:
      return 'The agent these accounts run cannot run this maker’s models, so 10db never routes to it.';
    case ModelStatus.Unknown: {
      if (unlisted.length > 0)
        return `${unlisted.map((a) => a.label).join(', ')} ${unlisted.length === 1 ? 'has' : 'have'} not listed its models yet, so this one is not confirmed.`;
      if (row.maker === null)
        return 'The catalogue does not list this model, so its tier and price are unknown. You can still choose it by hand.';
      return 'The catalogue gives it no price, so 10db cannot place it in a tier. You can still choose it by hand.';
    }
  }
}

function priceOf(offer: AccountModelDto, account: AccountDto | undefined): string {
  if (offer.inputPrice !== null && offer.outputPrice !== null)
    return `${formatPrice(offer.inputPrice)} in · ${formatPrice(offer.outputPrice)} out`;
  // A subscription pays per month, not per token; any other account with no price simply has none listed.
  return account !== undefined && !isMetered(account.kind) ? 'Included in plan' : NO_DATA;
}

function Accounts({
  row,
  offers,
  accounts,
  now,
}: {
  readonly row: ModelRowDto;
  readonly offers: readonly AccountModelDto[];
  readonly accounts: readonly AccountDto[];
  readonly now: number;
}) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const listed = new Set(offers.map((o) => o.accountId));
  const unconfirmed = row.availableOn.filter((id) => !listed.has(id));
  return (
    <Table aria-label="Accounts offering this model" verticalSpacing="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Account</Table.Th>
          <Table.Th>Launch ID</Table.Th>
          <Table.Th>Price per 1M tokens</Table.Th>
          <Table.Th>Read</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {offers.map((offer) => {
          const account = byId.get(offer.accountId);
          return (
            <Table.Tr key={offer.accountId}>
              <Table.Td>{account?.label ?? 'Removed account'}</Table.Td>
              <Table.Td>
                <Text size="sm" ff="monospace">
                  {offer.launchId}
                </Text>
                {offer.unusable ? (
                  <Badge size="sm" variant="light" color="gray">
                    Refused by this account
                  </Badge>
                ) : null}
              </Table.Td>
              <Table.Td>{priceOf(offer, account)}</Table.Td>
              <Table.Td>{fromNow(offer.lastSeenAt, now)}</Table.Td>
            </Table.Tr>
          );
        })}
        {unconfirmed.map((id) => (
          <Table.Tr key={id}>
            <Table.Td>{byId.get(id)?.label ?? 'Removed account'}</Table.Td>
            <Table.Td colSpan={3}>
              <Text size="sm" c="dimmed">
                Not confirmed: its list has not been read yet
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function Efforts({
  profiles,
  now,
}: {
  readonly profiles: readonly ModelProfileDto[];
  readonly now: number;
}) {
  const ordered = [...profiles].sort(
    (a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort),
  );
  return (
    <Table aria-label="Scores per effort" verticalSpacing="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Effort</Table.Th>
          <Table.Th ta="right">Intelligence</Table.Th>
          <Table.Th ta="right">Coding</Table.Th>
          <Table.Th ta="right">Speed</Table.Th>
          <Table.Th ta="right">First pass</Table.Th>
          <Table.Th ta="right">Escalations</Table.Th>
          <Table.Th>Measured</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {ordered.map((p) => (
          <Table.Tr key={p.id}>
            <Table.Td>{p.effort}</Table.Td>
            <Table.Td ta="right">{formatScore(p.scores.intelligence)}</Table.Td>
            <Table.Td ta="right">{formatScore(p.scores.coding)}</Table.Td>
            <Table.Td ta="right">{formatScore(p.outputTokensPerSecond)}</Table.Td>
            <Table.Td ta="right">{formatFirstPass(p.firstPassSteps, p.stepsRun)}</Table.Td>
            <Table.Td ta="right">{p.stepsRun === 0 ? NO_DATA : String(p.escalations)}</Table.Td>
            <Table.Td>{p.measuredAt === null ? NO_DATA : fromNow(p.measuredAt, now)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function DrawerBody({ row, now }: { readonly row: ModelRowDto; readonly now: number }) {
  const accounts = useAccounts();
  const offers = useModelOffers();
  const profiles = useModelProfiles();
  const accountList = accounts.data ?? [];
  const mine = (offers.data ?? []).filter((o) => o.model === row.model);
  const listed = new Set(mine.map((o) => o.accountId));
  const unlisted = accountList.filter((a) => row.availableOn.includes(a.id) && !listed.has(a.id));
  const reason = statusReason(row, offers.data === undefined ? [] : unlisted);
  const efforts = (profiles.data ?? []).filter((p) => p.model === row.model);
  const released = efforts.find((p) => p.releaseDate !== null)?.releaseDate ?? null;
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="sm" ff="monospace">
          {row.model}
        </Text>
        <Group gap="xs">
          {row.tier ? <Badge variant="light">{TIER_LABEL[row.tier]}</Badge> : null}
          <Badge variant="light" color="gray">
            {STATUS_LABEL[row.status]}
          </Badge>
        </Group>
        {reason ? (
          <Text size="sm" c="dimmed">
            {reason}
          </Text>
        ) : null}
        <Text size="sm" c="dimmed">
          {row.maker ?? 'Maker unknown'}
          {row.family ? ` · ${row.family}` : ''}
          {released ? ` · released ${released}` : ''}
          {row.firstSeenAt === null ? '' : ` · first seen ${fromNow(row.firstSeenAt, now)}`}
        </Text>
        <Text size="sm" c="dimmed">
          List price per 1M tokens: {formatPrice(row.inputPrice)} in ·{' '}
          {formatPrice(row.outputPrice)} out
        </Text>
      </Stack>
      <Stack gap="xs">
        <Title order={4}>Accounts</Title>
        <Accounts row={row} offers={mine} accounts={accountList} now={now} />
      </Stack>
      <Stack gap="xs">
        <Title order={4}>Scores per effort</Title>
        <Efforts profiles={efforts} now={now} />
        <ArtificialAnalysisCredit />
      </Stack>
    </Stack>
  );
}

/** One model's facts and their age, its scores per effort, its observed steps and the accounts that offer it. */
export function ModelDrawer({
  row,
  opened,
  onClose,
  now,
}: {
  readonly row: ModelRowDto | null;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly now: number;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title={row?.name ?? 'Model'}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {row ? <DrawerBody key={row.model} row={row} now={now} /> : null}
    </Drawer>
  );
}
