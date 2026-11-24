import type { AskedDecision } from '@10db/contracts';
import {
  Alert,
  Anchor,
  Divider,
  Group,
  Paper,
  Stack,
  Switch,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
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
import { PlanMeasures } from './plan-measures';
import { PaidBy } from './paid-by';
import { RecentDecisions } from './recent-decisions';
import { ModelClass } from './focus-target';
import { SettingsSectionKey } from './sections';
import { SettingRow } from './setting-row';

const ASK_A_MODEL = 'Let a Model Make These Calls';

const DecisionsTab = { Decisions: 'decisions', Recent: 'recent' } as const;
type DecisionsTab = (typeof DecisionsTab)[keyof typeof DecisionsTab];

const UNREACHABLE = "Couldn't reach the daemon.";

function failureText(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : UNREACHABLE;
}

/** Settings › Decisions: who decides. The master switch, who pays and every decision, then the Recent calls. */
export function DecisionsSection() {
  const status = useJudgeStatus();
  const patch = usePatchJudge();
  const stats = useDecisionStats();
  const shadow = useShapeMeasures();
  const [open, setOpen] = useState<AskedDecision | null>(null);
  const [tab, setTab] = useState<DecisionsTab>(DecisionsTab.Decisions);
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
        if (next === DecisionsTab.Decisions || next === DecisionsTab.Recent) setTab(next);
      }}
      keepMounted={false}
    >
      <Tabs.List mb="lg">
        <Tabs.Tab value={DecisionsTab.Decisions}>Decisions</Tabs.Tab>
        <Tabs.Tab value={DecisionsTab.Recent}>Recent</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value={DecisionsTab.Decisions}>
        <Stack gap="xl">
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Small calls 10db makes many times a day, such as how much process a task needs or
              whether a command is safe. Decisions you record yourself are in{' '}
              <Anchor component={Link} to="/knowledge" size="sm">
                Knowledge
              </Anchor>
              .
            </Text>
            <Paper withBorder radius="md">
              <SettingRow
                label={ASK_A_MODEL}
                description={
                  config.enabled
                    ? 'Each call goes to its model below, Jev unless you pick another.'
                    : "Off: 10db's fixed rules make every call, and no model is asked."
                }
              >
                <Group justify="flex-end">
                  <Switch
                    aria-label={ASK_A_MODEL}
                    checked={config.enabled}
                    disabled={disabled}
                    onChange={(event) => {
                      patch.mutate({ enabled: event.currentTarget.checked });
                    }}
                  />
                </Group>
              </SettingRow>
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
            <Anchor
              size="xs"
              renderRoot={(props) => (
                <Link
                  {...props}
                  to="/settings/$section"
                  params={{ section: SettingsSectionKey.Models }}
                  search={{ class: ModelClass.Decision }}
                />
              )}
            >
              Compare decision models in Models
            </Anchor>
          </Stack>
          <PlanMeasures />
        </Stack>
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
