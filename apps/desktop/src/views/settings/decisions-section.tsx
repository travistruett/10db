import type { JudgeDecision } from '@10db/contracts';
import { Alert, Anchor, Group, Stack, Switch, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import {
  useDecisionModels,
  useDecisionStats,
  useJudgeStatus,
  usePatchJudge,
} from '../../daemon/judge-queries';
import { useShapeMeasures } from '../../daemon/shape-measures-queries';
import { DecisionDrawer } from './decision-drawer';
import { statsFor } from './decision-numbers';
import { DecisionsTable } from './decisions-table';
import { PaidBy } from './paid-by';
import { RecentDecisions } from './recent-decisions';

const UNREACHABLE = "Couldn't reach the daemon.";

function failureText(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : UNREACHABLE;
}

/** Settings › Decisions: the master switch, who pays, every routine decision a fast model makes and its recent calls. */
export function DecisionsSection() {
  const status = useJudgeStatus();
  const patch = usePatchJudge();
  const stats = useDecisionStats();
  const shadow = useShapeMeasures();
  const [open, setOpen] = useState<JudgeDecision | null>(null);
  const keyed =
    status.data !== undefined && !status.data.off && status.data.account?.secretSet === true;
  const models = useDecisionModels(keyed);
  if (status.isPending) return <Text c="dimmed">Loading…</Text>;
  if (status.isError) return <Alert color="red">{status.error.message}</Alert>;
  const { config, off } = status.data;
  // Controls stay disabled while the daemon runs with the judge off.
  const disabled = off;
  const modelList = models.data?.models;
  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text size="sm" c="dimmed" maw={480}>
          These are the routine calls 10db makes with a fast model, such as whether a change needs a
          review. The decisions you and your agents record are in{' '}
          <Anchor component={Link} to="/knowledge" size="sm" underline="always">
            Knowledge
          </Anchor>
          .
        </Text>
        <Stack gap="xs" align="flex-end" miw={360}>
          <Switch
            aria-label="Fast-model decisions"
            label="Fast-model decisions"
            checked={config.enabled}
            disabled={disabled}
            onChange={(event) => {
              patch.mutate({ enabled: event.currentTarget.checked });
            }}
          />
          <Text size="xs" c="dimmed" ta="right" maw={360}>
            When off, 10db makes every decision the way it did before and never calls OpenRouter.
          </Text>
          <PaidBy status={status.data} disabled={disabled} />
        </Stack>
      </Group>
      {off ? (
        <Alert color="yellow" title="Decisions are off">
          The daemon was started with TENDB_JUDGE=off, so it never calls OpenRouter. Restart 10db
          without it to change these.
        </Alert>
      ) : null}
      {patch.error ? (
        <Alert color="red" role="alert">
          {failureText(patch.error)}
        </Alert>
      ) : null}
      <DecisionsTable
        status={status.data}
        stats={stats.data}
        shadow={shadow.data?.shadow}
        models={modelList}
        onOpen={setOpen}
      />
      <RecentDecisions {...(modelList === undefined ? {} : { models: modelList })} />
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
