import type { JudgeDecision } from '@10db/contracts';
import { Alert, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useDecisionModels, useDecisionStats, useJudgeStatus } from '../../daemon/judge-queries';
import { useShapeMeasures } from '../../daemon/shape-measures-queries';
import { DecisionDrawer } from './decision-drawer';
import { statsFor } from './decision-numbers';
import { DecisionsTable } from './decisions-table';

/** Models › Decisions: every routine decision with the model it uses; its detail opens in the drawer. */
export function DecisionsModelsView() {
  const status = useJudgeStatus();
  const stats = useDecisionStats();
  const shadow = useShapeMeasures();
  const [open, setOpen] = useState<JudgeDecision | null>(null);
  const keyed =
    status.data !== undefined && !status.data.off && status.data.account?.secretSet === true;
  const models = useDecisionModels(keyed);
  if (status.isPending) return <Text c="dimmed">Loading…</Text>;
  if (status.isError) return <Alert color="red">{status.error.message}</Alert>;
  const modelList = models.data?.models;
  return (
    <Stack gap="lg">
      <DecisionsTable
        status={status.data}
        stats={stats.data}
        shadow={shadow.data?.shadow}
        models={modelList}
        onOpen={setOpen}
        withStatus={false}
      />
      <DecisionDrawer
        decision={open}
        status={status.data}
        statsFailed={stats.isError}
        stats={open === null ? undefined : statsFor(stats.data, open)}
        shadow={shadow.data?.shadow.find((a) => a.decision === open)}
        models={modelList}
        onClose={() => {
          setOpen(null);
        }}
      />
    </Stack>
  );
}
