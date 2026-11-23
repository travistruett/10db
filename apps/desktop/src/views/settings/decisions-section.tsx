import type { AskedDecision } from '@10db/contracts';
import { Alert, Anchor, Divider, Paper, Stack, Switch, Tabs, Text, Title } from '@mantine/core';
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
import { DecisionsModelsView } from './decisions-models-view';
import { HintedRow } from './hinted-row';
import { statsFor } from './decision-numbers';
import { DecisionsTable } from './decisions-table';
import { PaidBy } from './paid-by';
import { RecentDecisions } from './recent-decisions';

const DecisionsTab = { Overview: 'overview', Models: 'models', Recent: 'recent' } as const;
type DecisionsTab = (typeof DecisionsTab)[keyof typeof DecisionsTab];

const UNREACHABLE = "Couldn't reach the daemon.";

function failureText(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : UNREACHABLE;
}

/** Settings › Decisions: Overview (the master switch, who pays, every decision), Models (time and cost) and Recent calls. */
export function DecisionsSection() {
  const status = useJudgeStatus();
  const patch = usePatchJudge();
  const stats = useDecisionStats();
  const shadow = useShapeMeasures();
  const [open, setOpen] = useState<AskedDecision | null>(null);
  const [tab, setTab] = useState<DecisionsTab>(DecisionsTab.Overview);
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
    <Tabs
      value={tab}
      onChange={(next) => {
        if (
          next === DecisionsTab.Overview ||
          next === DecisionsTab.Models ||
          next === DecisionsTab.Recent
        )
          setTab(next);
      }}
      keepMounted={false}
    >
      <Tabs.List mb="lg">
        <Tabs.Tab value={DecisionsTab.Overview}>Overview</Tabs.Tab>
        <Tabs.Tab value={DecisionsTab.Models}>Models</Tabs.Tab>
        <Tabs.Tab value={DecisionsTab.Recent}>Recent</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value={DecisionsTab.Overview}>
        <Stack gap="xl">
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Routine calls 10db makes with a fast model. Decisions you record are in{' '}
              <Anchor component={Link} to="/knowledge" size="sm">
                Knowledge
              </Anchor>
              .
            </Text>
            <Paper withBorder radius="md">
              <HintedRow
                label="Fast-Model Decisions"
                hint="When off, 10db makes every decision the way it did before and never calls a model."
              >
                <Switch
                  aria-label="Fast-Model Decisions"
                  checked={config.enabled}
                  disabled={disabled}
                  onChange={(event) => {
                    patch.mutate({ enabled: event.currentTarget.checked });
                  }}
                />
              </HintedRow>
              <Divider />
              <PaidBy status={status.data} disabled={disabled} />
            </Paper>
          </Stack>
          {off ? (
            <Alert color="yellow" title="Decisions are off">
              The daemon was started with TENDB_JUDGE=off, so it never calls a model. Restart 10db
              without it to change these.
            </Alert>
          ) : null}
          {patch.error ? (
            <Alert color="red" role="alert">
              {failureText(patch.error)}
            </Alert>
          ) : null}
          <Stack gap="xs">
            <Title order={4}>Every Decision</Title>
            <Text size="xs" c="dimmed">
              Open one to change its model or how sure it must be.
            </Text>
            <DecisionsTable
              status={status.data}
              stats={stats.data}
              shadow={shadow.data?.shadow}
              models={modelList}
              onOpen={setOpen}
            />
          </Stack>
        </Stack>
      </Tabs.Panel>
      <Tabs.Panel value={DecisionsTab.Models}>
        <DecisionsModelsView
          onPickAccount={() => {
            setTab(DecisionsTab.Overview);
          }}
        />
      </Tabs.Panel>
      <Tabs.Panel value={DecisionsTab.Recent}>
        <RecentDecisions {...(modelList === undefined ? {} : { models: modelList })} />
      </Tabs.Panel>
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
    </Tabs>
  );
}
