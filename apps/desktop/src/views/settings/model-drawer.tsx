import {
  isMetered,
  ModelStatus,
  type AccountDto,
  type AccountModelDto,
  type ModelRowDto,
  type RolePickDto,
} from '@10db/contracts';
import { Badge, Drawer, Stack, Table, Text, Title } from '@mantine/core';
import { Fragment, type ReactNode } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { useModelOffers } from '../../daemon/model-queries';
import { absoluteTime, fromNow } from '../../shell/relative';
import { ArtificialAnalysisCredit } from './artificial-analysis-credit';
import { formatCost, formatFirstPass, formatPrice, formatScore, NO_DATA } from './model-format';
import { STATUS_LABEL, TIER_LABEL } from './model-labels';
import { RightsizingChart } from './rightsizing-chart';
import { DotsMode, intelligenceAxis, rightsizingSeries } from './rightsizing-series';
import { ROLES } from './role-labels';

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

/**
 * Whether the account refused the model, and on what it rests. A mark from model_not_found lasts until the
 * account's list changes. One from an error's wording alone ends on its own, because the words cannot tell a
 * refusal from a config error: it says when, and what the next session on the model settles.
 */
function Mark({ offer, now }: { readonly offer: AccountModelDto; readonly now: number }) {
  if (offer.wordingMarkEndsAt === null)
    return offer.unusable ? (
      <Badge size="sm" variant="light" color="gray">
        Refused by this account
      </Badge>
    ) : null;
  const ends = fromNow(offer.wordingMarkEndsAt, now);
  return (
    <Stack gap={2}>
      <Badge size="sm" variant="light" color="gray">
        Marked from an error’s wording
      </Badge>
      <Text size="xs" c="dimmed" title={absoluteTime(offer.wordingMarkEndsAt)}>
        {offer.unusable
          ? `10db keeps away from it until the mark ends ${ends}. A session then tries it again: refused the same way, it stays unusable until the account’s list changes; run well, the mark goes.`
          : `The mark ended ${ends}, so 10db routes to it again. The next session on it settles it: refused the same way, it stays unusable until the account’s list changes; run well, the mark goes.`}
      </Text>
    </Stack>
  );
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
                <Mark offer={offer} now={now} />
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

/** One line per effort, low to max, the order of the chart above it from left to right. */
function Efforts({ row }: { readonly row: ModelRowDto }) {
  return (
    <Table aria-label="Effort table" verticalSpacing="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Effort</Table.Th>
          <Table.Th ta="right">Intelligence</Table.Th>
          <Table.Th ta="right">Cost per task</Table.Th>
          <Table.Th ta="right">Steps run</Table.Th>
          <Table.Th ta="right">First pass</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {[...row.efforts]
          .sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort))
          .map((e) => (
            <Table.Tr key={e.profileId}>
              <Table.Td>{e.effort}</Table.Td>
              <Table.Td ta="right">{formatScore(e.intelligence)}</Table.Td>
              <Table.Td ta="right">{formatCost(e.costPerTaskUsd)}</Table.Td>
              <Table.Td ta="right">{e.stepsRun}</Table.Td>
              <Table.Td ta="right">{formatFirstPass(e.firstPassSteps, e.stepsRun)}</Table.Td>
            </Table.Tr>
          ))}
      </Table.Tbody>
    </Table>
  );
}

function DrawerBody({
  row,
  now,
  picks,
}: {
  readonly row: ModelRowDto;
  readonly now: number;
  readonly picks: readonly RolePickDto[];
}) {
  const accounts = useAccounts();
  const offers = useModelOffers();
  const accountList = accounts.data ?? [];
  const mine = (offers.data ?? []).filter((o) => o.model === row.model);
  const listed = new Set(mine.map((o) => o.accountId));
  const unlisted = accountList.filter((a) => row.availableOn.includes(a.id) && !listed.has(a.id));
  const reason = statusReason(row, offers.data === undefined ? [] : unlisted);
  // One line: the ID, rung, status, maker and age, leaving out what is empty or repeats the name.
  const facts: { key: string; node: ReactNode }[] = [
    ...(row.model === row.name
      ? []
      : [
          {
            key: 'id',
            node: (
              <Text span ff="monospace" inherit>
                {row.model}
              </Text>
            ),
          },
        ]),
    ...(row.tier ? [{ key: 'tier', node: `${TIER_LABEL[row.tier]} tier` }] : []),
    {
      key: 'status',
      node: (
        <Text span inherit>
          {STATUS_LABEL[row.status]}
        </Text>
      ),
    },
    ...(row.maker === null || row.maker === row.name ? [] : [{ key: 'maker', node: row.maker }]),
    ...(row.firstSeenAt === null
      ? []
      : [{ key: 'seen', node: `first seen ${fromNow(row.firstSeenAt, now)}` }]),
  ];
  const users = picks
    .filter((p) => p.model === row.model)
    .map((p) => ROLES.find((r) => r.role === p.role)?.label ?? p.role);
  // The same chart as the page, of this model's efforts alone and with the roles that pick it ringed.
  const plot = rightsizingSeries({
    rows: [row],
    picks: picks.filter((p) => p.model === row.model),
    role: null,
    dots: DotsMode.Every,
  });
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="sm" c="dimmed">
          {facts.map((fact, i) => (
            <Fragment key={fact.key}>
              {i > 0 ? ' · ' : ''}
              {fact.node}
            </Fragment>
          ))}
        </Text>
        {reason ? (
          <Text size="sm" c="dimmed">
            {reason}
          </Text>
        ) : null}
        <Text size="sm" c="dimmed">
          List price per 1M tokens: {formatPrice(row.inputPrice)} in ·{' '}
          {formatPrice(row.outputPrice)} out · speed {formatScore(row.outputTokensPerSecond)}{' '}
          tokens/s
        </Text>
      </Stack>
      <Stack gap="xs">
        <Title order={4}>What each effort buys</Title>
        <RightsizingChart
          result={{
            ...plot,
            lines: [],
            yAxis: intelligenceAxis(plot.points.map((p) => p.intelligence)),
          }}
          costLabel="Cost per task (USD, log scale)"
          height={200}
        />
        {users.length === 0 ? null : (
          <Text size="xs" c="dimmed">
            Ringed: the pick of {users.join(', ')} on this account.
          </Text>
        )}
        <Efforts row={row} />
        <Text size="xs" c="dimmed">
          <ArtificialAnalysisCredit />
        </Text>
      </Stack>
      <Stack gap="xs">
        <Title order={4}>Offered by</Title>
        <Accounts row={row} offers={mine} accounts={accountList} now={now} />
      </Stack>
    </Stack>
  );
}

/** One model's facts and their age, what each effort buys, and the accounts that offer it. */
export function ModelDrawer({
  row,
  opened,
  onClose,
  now,
  picks,
}: {
  readonly row: ModelRowDto | null;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly now: number;
  /** The router's picks on the page's account, whose rings the model's chart draws. */
  readonly picks: readonly RolePickDto[];
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
      {row ? <DrawerBody key={row.model} row={row} now={now} picks={picks} /> : null}
    </Drawer>
  );
}
