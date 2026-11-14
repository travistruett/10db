import type { JudgeDecision, QuestionMeasureDto, SizingMeasureDto } from '@10db/contracts';
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
import { SettingRow, SettingsCard } from './setting-row';

const percent = (part: number, whole: number): string =>
  `${String(Math.round((part / whole) * 100))}%`;

/** Settings › Decisions › Sizing (spec §8 Calibration). */
function SizingRow({ sizing }: { readonly sizing: SizingMeasureDto }) {
  const buckets = (['S', 'M', 'L', 'XL'] as const)
    .filter((b) => sizing.buckets[b].n > 0)
    .map((b) => `${b} ${String(sizing.buckets[b].within)} of ${String(sizing.buckets[b].n)}`);
  return (
    <SettingRow
      label="Sizing"
      description="Finished tasks Plan converted, whose size was within one bucket of the lane time they took."
    >
      <Stack gap={2} role="group" aria-label="Sizing">
        {sizing.n === 0 ? (
          <Text size="sm" c="dimmed">
            No converted task has finished yet
          </Text>
        ) : (
          <>
            <Text size="sm">
              {percent(sizing.within, sizing.n)} within one bucket ({String(sizing.within)} of{' '}
              {String(sizing.n)})
            </Text>
            <Text size="xs" c="dimmed">
              {buckets.join(' · ')}
            </Text>
          </>
        )}
        {sizing.overrides > 0 ? (
          <Text size="xs" c="dimmed">
            {String(sizing.overrides)} set by you, not counted
          </Text>
        ) : null}
      </Stack>
    </SettingRow>
  );
}

const taskCount = (n: number): string => `${String(n)} ${n === 1 ? 'task' : 'tasks'}`;

const perTask = (rate: QuestionMeasureDto['converted']): string =>
  `${String(Math.round((rate.cards / rate.tasks) * 100) / 100)} question cards per task (${taskCount(rate.tasks)})`;

/** Settings › Decisions › Questions (spec §7 Measure): Inbox question cards, converted against other tasks. */
function QuestionsRow({ questions }: { readonly questions: QuestionMeasureDto }) {
  const { converted, other } = questions;
  return (
    <SettingRow
      label="Questions"
      description="Inbox question cards on tasks Plan converted, against the project's other tasks. Only tasks that started count."
    >
      <Stack gap={2} role="group" aria-label="Questions">
        {converted.tasks === 0 ? (
          <Text size="sm" c="dimmed">
            No converted task has started yet
          </Text>
        ) : (
          <Text size="sm">{perTask(converted)} converted</Text>
        )}
        {other.tasks === 0 ? null : (
          <Text size="xs" c="dimmed">
            {perTask(other)} for the project&apos;s other tasks
          </Text>
        )}
      </Stack>
    </SettingRow>
  );
}

const UNREACHABLE = "Couldn't reach the daemon.";

function failureText(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : UNREACHABLE;
}

/** Sizing and Questions: what Plan's converted tasks came to. */
function PlanMeasuresCard() {
  const measures = useShapeMeasures();
  if (measures.data === undefined) return null;
  return (
    <SettingsCard>
      <SizingRow sizing={measures.data.sizing} />
      <QuestionsRow questions={measures.data.questions} />
    </SettingsCard>
  );
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
      <PlanMeasuresCard />
      <RecentDecisions {...(modelList === undefined ? {} : { models: modelList })} />
      <DecisionDrawer
        decision={open}
        status={status.data}
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
