import {
  JudgeDecision,
  isAskedDecision,
  type AskedDecision,
  type DecisionModelDto,
} from '@10db/contracts';
import { Alert, Group, Loader, Stack, Text } from '@mantine/core';
import { IconBolt, IconBoltOff, IconKey } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useDecisionModels, useDecisionStats, useJudgeStatus } from '../../daemon/judge-queries';
import { EmptyState } from '../../shell/empty-state';
import { DecisionModelDrawer } from './decision-model-drawer';
import { answersByModel, decisionModelSeries } from './decision-model-series';
import { DecisionModelsChart } from './decision-models-chart';
import { DecisionModelsTable } from './decision-models-table';
import { RaisedPanel } from './raised-panel';
import { SectionHeading } from './section-heading';
import { SettingsSectionKey } from './sections';

/** Decision Models with nothing to draw: decisions are off in this daemon, or no account pays for them yet. */
function Unavailable({ off }: { readonly off: boolean }) {
  const navigate = useNavigate();
  if (off)
    return (
      <EmptyState icon={IconBoltOff} title="Decisions are off">
        10db was started with TENDB_JUDGE=off, so it never calls a decision model or reads their
        list.
      </EmptyState>
    );
  return (
    <EmptyState
      icon={IconBolt}
      title="No account pays for decisions yet"
      action={{
        label: 'Choose an Account',
        icon: IconKey,
        onClick: () => {
          void navigate({
            to: '/settings/$section',
            params: { section: SettingsSectionKey.Decisions },
            search: { focus: 'paid-by' },
          });
        },
      }}
    >
      Pick the account that pays for 10db&apos;s quick calls, and its models show here by time and
      cost.
    </EmptyState>
  );
}

/** Models › Decision Models: the models that make 10db's decisions, by time and cost, then every one of them. */
export function DecisionModelsView() {
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
    if (judge.off) return <Unavailable off />;
    if (!keyed) return <Unavailable off={false} />;
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
        <Stack gap="sm">
          <SectionHeading title="Time and Cost" line="Rings mark the model each decision uses." />
          <RaisedPanel>
            <DecisionModelsChart
              points={series.points}
              freeX={series.freeX}
              models={modelList}
              height={300}
            />
          </RaisedPanel>
          <Text size="xs" c="dimmed">
            Past the dashed line 10db gives up on a model and applies today&apos;s rule.
            {series.omitted > 0
              ? ` ${String(series.omitted)} ${series.omitted === 1 ? 'model' : 'models'} with no cost or time ${series.omitted === 1 ? 'is' : 'are'} not drawn.`
              : ''}
          </Text>
        </Stack>
        <Stack gap="sm">
          <SectionHeading
            title="Decision Models"
            line="Every model the account can run a decision on."
          />
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
