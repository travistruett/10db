import { JudgeDecision, isAskedDecision, type AskedDecision } from '@10db/contracts';
import { Alert, Anchor, Divider, Group, Paper, Stack, Switch } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { usePageGuide } from '../../shell/page-guide';
import { PageTabs, type PageTab } from '../../shell/page-intro';
import { PageLoading, PageLoadingShape } from '../../shell/page-loading';
import { DaemonRequestError } from '../../daemon/client';
import {
  useDecisionModels,
  useDecisionStats,
  useJudgeStatus,
  usePatchJudge,
} from '../../daemon/judge-queries';
import { useShapeMeasures } from '../../daemon/shape-measures-queries';
import { DecisionDrawer } from './decision-drawer';
import { DecisionModelPicker } from './decision-model-picker';
import { statsFor } from './decision-numbers';
import { DecisionsGuide, DECISIONS_GUIDE } from './decisions-guide';
import { DecisionsTable } from './decisions-table';
import { PlanMeasures } from './plan-measures';
import { PaidBy } from './paid-by';
import { RecentDecisions } from './recent-decisions';
import { ModelClass, useSettingsTab } from './focus-target';
import { SettingsSectionKey } from './sections';
import { SectionHeading } from './section-heading';
import { SettingRow } from './setting-row';
import { SettingsPageHeader } from './settings-page';

const ASK_A_MODEL = 'Let a Model Make These Calls';

/**
 * Every decision 10db still asks a model, in the order the contract lists them, but the second opinions:
 * it runs on a stronger model than the rest, so one model for every decision leaves it where it is.
 */
const EVERY_DECISION: readonly AskedDecision[] = Object.values(JudgeDecision)
  .filter(isAskedDecision)
  .filter((d) => d !== JudgeDecision.CrossesLimitSecond && d !== JudgeDecision.AcceptanceSecond);

const DecisionsTab = { Setup: 'setup', Recent: 'recent' } as const;
type DecisionsTab = (typeof DecisionsTab)[keyof typeof DecisionsTab];

const DECISIONS_TABS: readonly PageTab<DecisionsTab>[] = [
  { value: DecisionsTab.Setup, label: 'Setup' },
  { value: DecisionsTab.Recent, label: 'Recent' },
];

const UNREACHABLE = "Couldn't reach the daemon.";

function failureText(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : UNREACHABLE;
}

/**
 * Settings › Decisions: who decides. Setup holds the master switch, who pays and every decision; Recent the calls.
 * The tab is kept in the address.
 */
export function DecisionsSection() {
  const status = useJudgeStatus();
  const patch = usePatchJudge();
  const stats = useDecisionStats();
  const shadow = useShapeMeasures();
  const [open, setOpen] = useState<AskedDecision | null>(null);
  const [tab, setTab] = useSettingsTab(
    SettingsSectionKey.Decisions,
    DECISIONS_TABS,
    DecisionsTab.Setup,
  );
  const guide = usePageGuide(DECISIONS_GUIDE);
  const keyed =
    status.data !== undefined && !status.data.off && status.data.account?.secretSet === true;
  const models = useDecisionModels(keyed);
  const header = (
    <>
      <SettingsPageHeader
        sectionKey={SettingsSectionKey.Decisions}
        guide={guide.opener}
        tabs={<PageTabs label="Decisions" tabs={DECISIONS_TABS} value={tab} onChange={setTab} />}
      />
      <DecisionsGuide guide={guide} />
    </>
  );
  if (status.isPending)
    return (
      <>
        {header}
        <PageLoading shape={PageLoadingShape.Cards} label="Reading the decisions" />
      </>
    );
  if (status.isError)
    return (
      <>
        {header}
        <Alert color="red">{status.error.message}</Alert>
      </>
    );
  const { config, off } = status.data;
  // Controls stay disabled while the daemon runs with the judge off.
  const disabled = off;
  const modelList = models.data?.models;
  return (
    <>
      {header}
      {tab === DecisionsTab.Setup ? (
        <Stack gap="xl">
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
            <Divider />
            <SettingRow
              label="Model"
              description="Sets every decision below at once. Open one to change only that one."
            >
              <DecisionModelPicker
                decisions={EVERY_DECISION}
                status={status.data}
                disabled={disabled || !config.enabled}
                label="Model for every decision"
              />
            </SettingRow>
          </Paper>
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
            <SectionHeading
              title="Every Decision"
              line="Open one to change its model or how sure it must be."
            />
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
      ) : (
        <RecentDecisions {...(modelList === undefined ? {} : { models: modelList })} />
      )}
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
    </>
  );
}
