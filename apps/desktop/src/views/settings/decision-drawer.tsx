import type {
  DecisionModelDto,
  DecisionStatsDto,
  JudgeDecision,
  JudgeStatusDto,
  ShadowAgreementDto,
} from '@10db/contracts';
import { Badge, Drawer, Stack, Switch, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { usePatchJudge } from '../../daemon/judge-queries';
import { DECISIONS, DecisionMode } from './decision-catalogue';
import { DecisionModelPicker } from './decision-model-picker';
import { formatDecisionUsd } from './decision-numbers';
import { RecentDecisions } from './recent-decisions';
import { SureEnough } from './sure-enough';

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Stack gap={4}>
      <Title order={6}>{title}</Title>
      {children}
    </Stack>
  );
}

const percent = (part: number, whole: number): string =>
  `${String(Math.round((part / whole) * 100))}%`;

function agreementText(a: ShadowAgreementDto | undefined): string {
  if (a === undefined) return 'In shadow';
  if (a.scored === 0) return 'In shadow: No scored answers yet';
  return `In shadow: ${String(a.agreed)} of ${String(a.scored)} scored answers agreed (${percent(a.agreed, a.scored)})`;
}

/** What the decision's last 30 days came to; a count shows only when it is not zero. */
function lastThirtyDaysParts(stats: DecisionStatsDto): string[] {
  const counted: readonly (readonly [string, number])[] = [
    ['calls', stats.calls],
    ['acted', stats.acted],
    ['not sure enough', stats.belowFloor],
    ['shadow', stats.shadow],
  ];
  const fellBack: readonly (readonly [string, number])[] = [
    ['off', stats.fallbacks.off],
    ['no key', stats.fallbacks.no_key],
    ['timed out', stats.fallbacks.timeout],
    ['failed', stats.fallbacks.error],
  ];
  return [
    ...counted.filter(([, n]) => n > 0).map(([name, n]) => `${String(n)} ${name}`),
    ...fellBack.filter(([, n]) => n > 0).map(([name, n]) => `fell back, ${name} ${String(n)}`),
    formatDecisionUsd(stats.costUsd),
    stats.medianLatencyMs === null
      ? 'median time —'
      : `median ${(stats.medianLatencyMs / 1000).toFixed(1)} s`,
  ];
}

function DrawerBody({
  decision,
  status,
  stats,
  shadow,
  models,
}: {
  readonly decision: JudgeDecision;
  readonly status: JudgeStatusDto;
  readonly stats: DecisionStatsDto | undefined;
  readonly shadow: ShadowAgreementDto | undefined;
  readonly models: readonly DecisionModelDto[] | undefined;
}) {
  const patch = usePatchJudge();
  const entry = DECISIONS[decision];
  const config = status.config.decisions[decision];
  // Controls stay disabled while the daemon runs with the judge off.
  const disabled = status.off;
  return (
    <Stack gap="md">
      <Text size="sm">{entry.asks}</Text>
      <Section title="On each answer">
        <Text size="sm">{entry.onAnswer}</Text>
      </Section>
      <Section title="When it isn’t sure">
        <Text size="sm">{entry.whenUnsure}</Text>
      </Section>
      {entry.mode === DecisionMode.Shadow ? (
        <Stack gap={4}>
          {entry.note === undefined ? null : (
            <Text size="xs" c="dimmed">
              {entry.note}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {agreementText(shadow)}
          </Text>
          {shadow?.canShow ? (
            <Badge size="xs" variant="light" w="fit-content">
              Ready to show
            </Badge>
          ) : null}
        </Stack>
      ) : null}
      <Switch
        aria-label={entry.label}
        label={entry.label}
        checked={config.enabled}
        disabled={disabled}
        onChange={(event) => {
          patch.mutate({ decisions: { [decision]: { enabled: event.currentTarget.checked } } });
        }}
      />
      <Section title="Model">
        <DecisionModelPicker decision={decision} status={status} disabled={disabled} />
      </Section>
      <Section title="Sure enough">
        <SureEnough
          decision={decision}
          floor={config.floor}
          answers={stats?.answers ?? []}
          model={config.model}
          disabled={disabled}
        />
      </Section>
      <Section title="Last 30 days">
        <Text size="sm">
          {stats === undefined
            ? '—'
            : stats.calls === 0
              ? 'No calls in the last 30 days'
              : lastThirtyDaysParts(stats).join(' · ')}
        </Text>
      </Section>
      <RecentDecisions decision={decision} {...(models === undefined ? {} : { models })} />
    </Stack>
  );
}

/** One decision's drawer: what it asks, what 10db does, its switch, model and Sure enough, and its calls. */
export function DecisionDrawer({
  decision,
  status,
  stats,
  shadow,
  models,
  onClose,
}: {
  /** The decision shown; null keeps the drawer closed. */
  readonly decision: JudgeDecision | null;
  readonly status: JudgeStatusDto;
  readonly stats: DecisionStatsDto | undefined;
  readonly shadow: ShadowAgreementDto | undefined;
  readonly models: readonly DecisionModelDto[] | undefined;
  readonly onClose: () => void;
}) {
  return (
    <Drawer
      opened={decision !== null}
      onClose={onClose}
      position="right"
      size="lg"
      title={decision === null ? '' : DECISIONS[decision].label}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {decision === null ? null : (
        <DrawerBody
          key={decision}
          decision={decision}
          status={status}
          stats={stats}
          shadow={shadow}
          models={models}
        />
      )}
    </Drawer>
  );
}
