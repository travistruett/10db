import {
  AccountId,
  AccountKind,
  JudgeDecision,
  SHAPE_JUDGE_DECISIONS,
  type JudgeConfig,
  type JudgeDecisionConfig,
  type JudgeStatusDto,
  type QuestionMeasureDto,
  type ShadowAgreementDto,
  type ShapeJudgeDecision,
  type SizingMeasureDto,
} from '@10db/contracts';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { DaemonRequestError } from '../../daemon/client';
import { useJudgeStatus, usePatchJudge } from '../../daemon/judge-queries';
import { useShapeMeasures } from '../../daemon/shape-measures-queries';
import { AccountSelect } from './account-select';
import { AddAccountModal } from './accounts/add-account-modal';
import { cantRunDecisions } from './accounts/used-by';
import { ConnectionStatus, ConnectionTone } from './connection-status';
import { DecisionModelPicker } from './decision-model-picker';
import { RecentDecisions } from './recent-decisions';
import { useFocusTarget } from './focus-target';
import { SettingsSectionKey } from './sections';
import { SettingRow, SettingsCard } from './setting-row';

const REVIEW = JudgeDecision.ReviewSize;
const REVIEW_LABEL = 'Skip review for small, well-tested changes';

/** Shape's decisions are named by the chip each would show (spec §9). */
const SHAPE_LABEL: Readonly<Record<ShapeJudgeDecision, string>> = {
  [JudgeDecision.ShapeReady]: 'Enough to propose',
  [JudgeDecision.ShapeRecord]: 'Record as a decision?',
  [JudgeDecision.ShapeElsewhere]: 'Question for someone else?',
};

const SHAPE_QUESTION: Readonly<Record<ShapeJudgeDecision, string>> = {
  [JudgeDecision.ShapeReady]: 'After each message, until the first Propose: have you said enough?',
  [JudgeDecision.ShapeRecord]: 'Does this message state a decision or principle worth recording?',
  [JudgeDecision.ShapeElsewhere]: 'Is this a question only someone else can answer?',
};

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

function agreementText(a: ShadowAgreementDto): string {
  if (a.scored === 0) return 'In shadow: No scored answers yet';
  return `In shadow: ${String(a.agreed)} of ${String(a.scored)} scored answers agreed (${percent(a.agreed, a.scored)})`;
}

/** One of Shape's decisions: what it asks, its switch, and how often its shadow answers agreed. */
function ShapeDecisionRow({
  decision,
  config,
  agreement,
  disabled,
  onEnabled,
}: {
  readonly decision: ShapeJudgeDecision;
  readonly config: JudgeDecisionConfig;
  readonly agreement: ShadowAgreementDto | undefined;
  readonly disabled: boolean;
  readonly onEnabled: (enabled: boolean) => void;
}) {
  const label = SHAPE_LABEL[decision];
  return (
    <SettingRow label={label} description={SHAPE_QUESTION[decision]}>
      <Stack gap={2} role="group" aria-label={label}>
        <Switch
          aria-label={label}
          checked={config.enabled}
          disabled={disabled}
          onChange={(event) => {
            onEnabled(event.currentTarget.checked);
          }}
        />
        <Text size="xs" c="dimmed">
          {agreement === undefined ? 'In shadow' : agreementText(agreement)}
        </Text>
        {agreement?.canShow ? (
          <Badge size="xs" variant="light">
            Ready to show
          </Badge>
        ) : null}
      </Stack>
    </SettingRow>
  );
}

/** Shape's measures: the Sizing line, and its three decisions in shadow. */
function ShapeMeasures({
  decisions,
  disabled,
  onEnabled,
}: {
  readonly decisions: JudgeConfig['decisions'];
  readonly disabled: boolean;
  readonly onEnabled: (decision: ShapeJudgeDecision, enabled: boolean) => void;
}) {
  const measures = useShapeMeasures();
  if (measures.data === undefined) return null;
  return (
    <Stack gap="xs">
      <SettingsCard>
        <SizingRow sizing={measures.data.sizing} />
        <QuestionsRow questions={measures.data.questions} />
        {SHAPE_JUDGE_DECISIONS.map((decision) => (
          <ShapeDecisionRow
            key={decision}
            decision={decision}
            config={decisions[decision]}
            agreement={measures.data.shadow.find((a) => a.decision === decision)}
            disabled={disabled}
            onEnabled={(enabled) => {
              onEnabled(decision, enabled);
            }}
          />
        ))}
      </SettingsCard>
      <Text size="xs" c="dimmed">
        Plan asks these only for a project with “Send brainstorm messages to fast models” on in its
        settings, and only logs the answers until each has 20 scored answers with 75% agreeing.
      </Text>
    </Stack>
  );
}

const UNREACHABLE = "Couldn't reach the daemon.";

function failureText(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : UNREACHABLE;
}

function AccountLink({
  account,
  children,
}: {
  readonly account: NonNullable<JudgeStatusDto['account']>;
  readonly children: string;
}) {
  return (
    <Anchor
      size="xs"
      renderRoot={(props) => (
        <Link
          {...props}
          to="/settings/$section"
          params={{ section: SettingsSectionKey.Accounts }}
          search={{ focus: account.id }}
        />
      )}
    >
      {children}
    </Anchor>
  );
}

/** The state of the account decisions run on, beside the select. */
function RunsOnState({
  account,
  off,
}: {
  readonly account: NonNullable<JudgeStatusDto['account']>;
  readonly off: boolean;
}) {
  if (account.secretState === 'set')
    return (
      <Group gap="sm">
        <ConnectionStatus tone={off ? ConnectionTone.Off : ConnectionTone.Works} label="Key set" />
        <AccountLink account={account}>View account</AccountLink>
      </Group>
    );
  const problem = account.secretState === 'changed' ? 'Key changed outside 10db' : 'No key';
  return (
    <Stack gap={2}>
      <ConnectionStatus tone={ConnectionTone.NeedsYou} label={problem} />
      <AccountLink account={account}>Set the key again in Accounts</AccountLink>
    </Stack>
  );
}

/** Which account decisions run on: an OpenRouter account's key is what 10db sends. */
function RunsOn({
  status,
  disabled,
}: {
  readonly status: JudgeStatusDto;
  readonly disabled: boolean;
}) {
  const accounts = useAccounts();
  const patch = usePatchJudge();
  const { ref } = useFocusTarget<HTMLDivElement>('runs-on');
  const [adding, setAdding] = useState(false);
  const live = (accounts.data ?? []).filter((a) => !a.archived);
  const hasRouter = live.some((a) => a.kind === AccountKind.OpenRouter);
  return (
    <div ref={ref}>
      <SettingRow
        label="Runs on"
        description="The account whose OpenRouter key 10db sends decisions with."
      >
        {accounts.isPending ? (
          <Loader size="sm" aria-label="Loading accounts" />
        ) : accounts.data === undefined ? (
          <Text size="sm" c="red" role="alert">
            Accounts could not be loaded. Check that the daemon is running.
          </Text>
        ) : hasRouter ? (
          <Stack gap={4}>
            <AccountSelect
              aria-label="Runs on"
              placeholder="Pick an account"
              accounts={live}
              isDisabled={cantRunDecisions}
              value={status.config.accountId}
              allowDeselect={false}
              disabled={disabled || patch.isPending}
              onChange={(value) => {
                if (value !== null && value !== status.config.accountId)
                  patch.mutate({ accountId: AccountId.parse(value) });
              }}
            />
            {status.account === null ? null : (
              <RunsOnState account={status.account} off={status.off} />
            )}
          </Stack>
        ) : (
          <Stack gap="xs" align="flex-end">
            <Text size="sm">No account can run decisions yet.</Text>
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              Add OpenRouter Account
            </Button>
          </Stack>
        )}
      </SettingRow>
      <AddAccountModal
        opened={adding}
        initialKind={AccountKind.OpenRouter}
        onClose={() => {
          setAdding(false);
        }}
        onCreated={() => {
          setAdding(false);
        }}
      />
    </div>
  );
}

/** Settings › Decisions: the account they run on, the master switch and each routine decision a fast model makes. */
export function DecisionsSection() {
  const status = useJudgeStatus();
  const patch = usePatchJudge();
  if (status.isPending) return <Text c="dimmed">Loading…</Text>;
  if (status.isError) return <Alert color="red">{status.error.message}</Alert>;
  const { config, off } = status.data;
  const review = config.decisions[REVIEW];
  // Controls stay disabled while the daemon runs with the judge off.
  const disabled = off;
  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        These are the routine calls 10db makes with a fast model, such as whether a change needs a
        review. The decisions you and your agents record are in{' '}
        <Anchor component={Link} to="/knowledge" size="sm" underline="always">
          Knowledge
        </Anchor>
        .
      </Text>
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
      <SettingsCard>
        <RunsOn status={status.data} disabled={disabled} />
      </SettingsCard>
      <SettingsCard>
        <SettingRow
          label="Use fast models for routine decisions"
          description="When off, 10db makes every decision the way it did before and never calls OpenRouter."
        >
          <Switch
            aria-label="Use fast models for routine decisions"
            checked={config.enabled}
            disabled={disabled}
            onChange={(event) => {
              patch.mutate({ enabled: event.currentTarget.checked });
            }}
          />
        </SettingRow>
        <SettingRow
          label={REVIEW_LABEL}
          description="After a step's checks pass, ask a fast model whether an independent review is needed."
        >
          <Switch
            aria-label={REVIEW_LABEL}
            checked={review.enabled}
            disabled={disabled}
            onChange={(event) => {
              patch.mutate({ decisions: { [REVIEW]: { enabled: event.currentTarget.checked } } });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Model"
          description="One of OpenRouter's decision models. 10db saves it once it answers a test decision."
        >
          <DecisionModelPicker decision={REVIEW} status={status.data} disabled={disabled} />
        </SettingRow>
        <SettingRow
          label="Confidence needed"
          description="Skip a review only at or above this, from 0 to 1."
        >
          <NumberInput
            key={review.floor}
            aria-label="Confidence needed"
            defaultValue={review.floor}
            min={0}
            max={1}
            step={0.05}
            decimalScale={2}
            disabled={disabled}
            onBlur={(event) => {
              const floor = Number.parseFloat(event.currentTarget.value);
              if (Number.isFinite(floor) && floor >= 0 && floor <= 1 && floor !== review.floor)
                patch.mutate({ decisions: { [REVIEW]: { floor } } });
            }}
          />
        </SettingRow>
      </SettingsCard>
      <ShapeMeasures
        decisions={config.decisions}
        disabled={disabled}
        onEnabled={(decision, enabled) => {
          patch.mutate({ decisions: { [decision]: { enabled } } });
        }}
      />
      <RecentDecisions />
    </Stack>
  );
}
