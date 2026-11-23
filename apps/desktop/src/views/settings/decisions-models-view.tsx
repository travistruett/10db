import {
  JudgeDecision,
  isAskedDecision,
  type AskedDecision,
  type DecisionModelDto,
} from '@10db/contracts';
import { Alert, Anchor, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useDecisionModels, useDecisionStats, useJudgeStatus } from '../../daemon/judge-queries';
import { DecisionModelDrawer } from './decision-model-drawer';
import { answersByModel, decisionModelSeries } from './decision-model-series';
import { DecisionModelsChart } from './decision-models-chart';
import { DecisionModelsTable } from './decision-models-table';
import { RaisedPanel } from './raised-panel';
import { SettingsSectionKey } from './sections';

const OFF_WORDS =
  "Decisions are off: 10db was started with TENDB_JUDGE=off, so it never calls a model and its models aren't read.";
const NO_ACCOUNT_WORDS =
  'Pick an account under Paid By to compare the models that make 10db’s decisions by time and cost.';

/** What replaces the chart and the list when they cannot be drawn, and why; the link goes to where the account is picked. */
function Unavailable({
  text,
  link,
  onPickAccount,
}: {
  readonly text: string;
  readonly link: boolean;
  readonly onPickAccount: (() => void) | undefined;
}) {
  return (
    <Text size="sm" c="dimmed">
      {text}
      {link ? (
        <>
          {' · '}
          {onPickAccount === undefined ? (
            <Anchor
              size="sm"
              renderRoot={(props) => (
                <Link
                  {...props}
                  to="/settings/$section"
                  params={{ section: SettingsSectionKey.Decisions }}
                  search={{ focus: 'paid-by' }}
                />
              )}
            >
              Paid By
            </Anchor>
          ) : (
            <Anchor component="button" type="button" size="sm" onClick={onPickAccount}>
              Paid By
            </Anchor>
          )}
        </>
      ) : null}
    </Text>
  );
}

/**
 * The decision models by time and cost. `onPickAccount` is where the Paid By link goes when the page
 * that shows this view is also the page that picks the account.
 */
export function DecisionsModelsView({ onPickAccount }: { readonly onPickAccount?: () => void }) {
  const status = useJudgeStatus();
  const stats = useDecisionStats();
  const [openModel, setOpenModel] = useState<DecisionModelDto | null>(null);
  const [modelOpened, setModelOpened] = useState(false);
  const keyed =
    status.data !== undefined && !status.data.off && status.data.account?.secretSet === true;
  const models = useDecisionModels(keyed);
  if (status.isPending) return <Text c="dimmed">Loading…</Text>;
  if (status.isError) return <Alert color="red">{status.error.message}</Alert>;
  const judge = status.data;
  const modelList = models.data?.models;
  const decisionsOf = (model: string): AskedDecision[] =>
    Object.values(JudgeDecision)
      .filter(isAskedDecision)
      .filter((d) => judge.config.decisions[d].model === model);

  const comparison = () => {
    if (judge.off)
      return <Unavailable text={OFF_WORDS} link={false} onPickAccount={onPickAccount} />;
    if (!keyed) return <Unavailable text={NO_ACCOUNT_WORDS} link onPickAccount={onPickAccount} />;
    if (models.isError)
      return (
        <Text size="sm" c="red" role="alert">
          {models.error.message}
        </Text>
      );
    if (modelList === undefined)
      return (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Reading the account’s decision models…
          </Text>
        </Group>
      );
    const series = decisionModelSeries(modelList, judge.config);
    const usedBy = new Map(modelList.map((m) => [m.id, decisionsOf(m.id)] as const));
    return (
      <>
        <Stack gap="xs">
          <Title order={4}>Time and Cost</Title>
          <RaisedPanel>
            <DecisionModelsChart
              points={series.points}
              freeX={series.freeX}
              models={modelList}
              height={300}
            />
          </RaisedPanel>
          <Text size="xs" c="dimmed">
            Rings: the model each decision uses. Past the dashed line 10db gives up on a model and
            applies today&apos;s rule.
            {series.omitted > 0
              ? ` ${String(series.omitted)} ${series.omitted === 1 ? 'model' : 'models'} with no cost or time ${series.omitted === 1 ? 'is' : 'are'} not drawn.`
              : ''}
          </Text>
        </Stack>
        <Stack gap="xs">
          <Title order={4}>All Decision Models</Title>
          <DecisionModelsTable
            models={modelList}
            usedBy={usedBy}
            answers={stats.data === undefined ? new Map() : answersByModel(stats.data)}
            onOpen={(model) => {
              setOpenModel(model);
              setModelOpened(true);
            }}
          />
        </Stack>
      </>
    );
  };

  return (
    <Stack gap="xl">
      {comparison()}
      <DecisionModelDrawer
        model={openModel}
        usedBy={openModel === null ? [] : decisionsOf(openModel.id)}
        opened={modelOpened}
        onClose={() => {
          setModelOpened(false);
        }}
      />
    </Stack>
  );
}
