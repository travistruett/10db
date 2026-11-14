import type { AccountId, ModelEvalDto, ProviderSpeedDto } from '@10db/contracts';
import { Stack, Table, Text, Title } from '@mantine/core';
import { useModelMeasures } from '../../daemon/model-queries';
import { absoluteTime, fromNow, useNow } from '../../shell/relative';
import { formatCost, NO_DATA } from './model-format';

/** A read older than this is marked old, the age the speed merge itself stops trusting. */
const STALE_MS = 24 * 60 * 60 * 1000;

const figure = (value: number | null): string =>
  value === null ? NO_DATA : String(Number(value.toPrecision(3)));

/** Under a second in milliseconds; from a second up in seconds with one decimal. */
const latencyText = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;

function Read({ at, now }: { readonly at: string; readonly now: number }) {
  const stale = now - Date.parse(at) > STALE_MS;
  return (
    <Text
      size="sm"
      {...(stale ? { c: 'dimmed' } : {})}
      style={{ whiteSpace: 'nowrap' }}
      title={absoluteTime(at)}
    >
      {fromNow(at, now)}
      {stale ? ' (old)' : ''}
    </Text>
  );
}

function Evals({ evals, now }: { readonly evals: readonly ModelEvalDto[]; readonly now: number }) {
  return (
    <Table aria-label="Eval costs" verticalSpacing="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Benchmark</Table.Th>
          <Table.Th ta="right">Accuracy</Table.Th>
          <Table.Th ta="right">Average cost per task</Table.Th>
          <Table.Th>Read</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {evals.map((e) => (
          <Table.Tr key={e.benchmark}>
            <Table.Td>{e.benchmark}</Table.Td>
            <Table.Td ta="right">
              {e.accuracy === null ? NO_DATA : `${String(Math.round(e.accuracy * 100))}%`}
            </Table.Td>
            <Table.Td ta="right">{formatCost(e.costPerTaskUsd)}</Table.Td>
            <Table.Td>
              <Read at={e.measuredAt} now={now} />
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function Speeds({
  speeds,
  accountProvider,
  now,
}: {
  readonly speeds: readonly ProviderSpeedDto[];
  readonly accountProvider: string | null;
  readonly now: number;
}) {
  return (
    <Table aria-label="Speed by provider" verticalSpacing="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Provider</Table.Th>
          <Table.Th ta="right">Tokens a second</Table.Th>
          <Table.Th ta="right">Latency</Table.Th>
          <Table.Th>Read</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {speeds.map((s) => (
          <Table.Tr key={s.provider}>
            <Table.Td>
              <Stack gap={0}>
                <Text size="sm">{s.provider}</Text>
                {s.provider === accountProvider ? (
                  <Text size="xs" c="dimmed">
                    This account&apos;s
                  </Text>
                ) : null}
              </Stack>
            </Table.Td>
            <Table.Td ta="right">{figure(s.tokensPerSecond)}</Table.Td>
            <Table.Td ta="right">
              {s.latencyMs === null ? NO_DATA : latencyText(s.latencyMs)}
            </Table.Td>
            <Table.Td>
              <Read at={s.measuredAt} now={now} />
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/**
 * A model's stored OpenRouter rows: its own evals with what a task cost on them, and the speed of each provider
 * that serves it. An empty section says why, never a zero. `account` marks the provider its speed is measured on.
 */
export function ModelMeasuresPanel({
  model,
  account,
}: {
  readonly model: string;
  readonly account: AccountId | null;
}) {
  const query = useModelMeasures(model, account);
  const now = useNow();
  if (query.data === undefined)
    return query.isError ? (
      <Text size="sm" c="dimmed">
        OpenRouter&apos;s rows for this model could not be read.
      </Text>
    ) : null;
  const { evals, speeds, evalsMissing, speedsMissing, accountProvider } = query.data;
  return (
    <>
      <Stack gap="xs">
        <Title order={4}>Eval costs (OpenRouter)</Title>
        {evals.length === 0 ? (
          <Text size="sm" c="dimmed">
            {evalsMissing ?? 'Not read from OpenRouter yet.'}
          </Text>
        ) : (
          <>
            <Evals evals={evals} now={now} />
            <Text size="xs" c="dimmed">
              OpenRouter&apos;s own evals; not the cost per task routing uses.
            </Text>
          </>
        )}
      </Stack>
      <Stack gap="xs">
        <Title order={4}>Speed by provider</Title>
        {speeds.length === 0 ? (
          <Text size="sm" c="dimmed">
            {speedsMissing ?? 'Not read from OpenRouter yet.'}
          </Text>
        ) : (
          <Speeds speeds={speeds} accountProvider={accountProvider} now={now} />
        )}
      </Stack>
    </>
  );
}
