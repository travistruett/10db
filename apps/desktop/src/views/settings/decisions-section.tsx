import { JudgeDecision, JudgeKeyInput, JudgeOutcome, type JudgeCallDto } from '@10db/contracts';
import {
  Alert,
  Badge,
  Button,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type SubmitEvent } from 'react';
import { DaemonRequestError } from '../../daemon/client';
import {
  judgeKeys,
  useJudgeCalls,
  useJudgeStatus,
  usePatchJudge,
  useTestJudge,
} from '../../daemon/judge-queries';
import { removeJudgeKey, sendJudgeKey } from '../../daemon/judge-secret';
import { useDaemon } from '../../daemon/provider';
import { SettingRow, SettingsCard } from './setting-row';

const REVIEW = JudgeDecision.ReviewSize;
const REVIEW_LABEL = 'Skip review for small, well-tested changes';

const DECISION_LABEL: Readonly<Record<JudgeDecision, string>> = {
  [JudgeDecision.ReviewSize]: REVIEW_LABEL,
};

/** What 10db did, in the builder's words, for the outcomes that do not depend on the answer. */
const OUTCOME_TEXT: Readonly<Record<Exclude<JudgeOutcome, 'acted'>, string>> = {
  [JudgeOutcome.BelowFloor]: 'Not sure enough; the review ran',
  [JudgeOutcome.FallbackOff]: 'Decisions were off; the review ran',
  [JudgeOutcome.FallbackNoKey]: 'No key; the review ran',
  [JudgeOutcome.FallbackTimeout]: 'Timed out; the review ran',
  [JudgeOutcome.FallbackError]: 'The call failed; the review ran',
  [JudgeOutcome.Stopped]: 'Stopped before it answered',
};

/**
 * `acted` means 10db followed the model's answer, which is a skip or a review: what it did depends on
 * which, so the text follows the answer and the outcome together.
 */
function outcomeText(call: Pick<JudgeCallDto, 'outcome' | 'answer'>): string {
  if (call.outcome !== JudgeOutcome.Acted) return OUTCOME_TEXT[call.outcome];
  if (call.answer === 'skip') return 'Skipped the review';
  if (call.answer === 'review') return 'Ran the review (model said review)';
  return 'Followed the answer';
}

const UNREACHABLE = "Couldn't reach the daemon.";

function failureText(error: unknown): string {
  return error instanceof DaemonRequestError ? error.message : UNREACHABLE;
}

/** The key field is write-only: read once on submit, cleared before anything is awaited, sent outside TanStack Query. */
function KeyRow({ keySet, disabled }: { readonly keySet: boolean; readonly disabled: boolean }) {
  const { client } = useDaemon();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: judgeKeys.status });

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const entered = new FormData(form).get('key');
    form.reset();
    // reset() skips the value setter, so React DOM's tracked copy would keep the key; this replaces it.
    const field = form.elements.namedItem('key');
    if (field instanceof HTMLInputElement) field.value = '';
    if (busy) return;
    const parsed = JudgeKeyInput.safeParse({ key: typeof entered === 'string' ? entered : '' });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Not a valid key');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendJudgeKey(client, parsed.data);
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await removeJudgeKey(client);
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  return (
    <SettingRow
      stacked
      label="OpenRouter key"
      description="Stored in your login Keychain, never in 10db's database. It can't be shown again; paste it again to replace it."
    >
      <Stack gap="xs">
        <Group gap="xs">
          <Text size="sm">Key:</Text>
          {keySet ? <Badge color="green">Set</Badge> : <Badge color="yellow">Not set</Badge>}
        </Group>
        <form onSubmit={(event) => void submit(event)}>
          <Group align="flex-end" gap="xs">
            <TextInput
              flex={1}
              type="password"
              name="key"
              aria-label="OpenRouter key"
              placeholder="sk-or-..."
              autoComplete="new-password"
              spellCheck={false}
              autoCapitalize="off"
              disabled={disabled}
            />
            <Button type="submit" loading={busy} disabled={disabled}>
              {keySet ? 'Replace Key' : 'Set Key'}
            </Button>
            <Button
              variant="default"
              color="red"
              disabled={disabled || busy || !keySet}
              onClick={() => void remove()}
            >
              Remove Key
            </Button>
          </Group>
        </form>
        {error ? (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        ) : null}
      </Stack>
    </SettingRow>
  );
}

function TestRow({ disabled }: { readonly disabled: boolean }) {
  const test = useTestJudge();
  const result = test.data;
  return (
    <SettingRow
      stacked
      label="Test connection"
      description="One tiny call on the review decision's model."
    >
      <Stack gap="xs" align="flex-start">
        <Button
          variant="default"
          loading={test.isPending}
          disabled={disabled}
          onClick={() => {
            test.mutate();
          }}
        >
          Test Connection
        </Button>
        {result?.ok === true ? (
          <Text size="sm">
            {result.model} answered in {Math.round(result.latencyMs)} ms
            {result.costUsd === null ? '' : `, $${result.costUsd.toFixed(5)}`}.
          </Text>
        ) : null}
        {result?.ok === false ? (
          <Alert color="red" role="alert">
            {result.error}
          </Alert>
        ) : null}
        {test.error ? (
          <Alert color="red" role="alert">
            {failureText(test.error)}
          </Alert>
        ) : null}
      </Stack>
    </SettingRow>
  );
}

function RecentCall({ call }: { readonly call: JudgeCallDto }) {
  const answer =
    call.answer === null
      ? 'no answer'
      : `${call.answer}${call.confidence === null ? '' : ` (${call.confidence.toFixed(2)})`}`;
  return (
    <li>
      <Stack gap={0} py="xs" px="md">
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Text size="sm" fw={500}>
            {DECISION_LABEL[call.decision]}
          </Text>
          <Text size="xs" c="dimmed">
            {new Date(call.createdAt).toLocaleString()}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          {call.model} · {answer}
        </Text>
        <Group gap="xs">
          <Text size="xs">{outcomeText(call)}</Text>
          {call.taskId ? (
            <Text size="xs" component="span">
              <Link to="/board" search={{ task: call.taskId }}>
                Open on the board
              </Link>
            </Text>
          ) : null}
        </Group>
      </Stack>
    </li>
  );
}

function RecentDecisions() {
  const calls = useJudgeCalls();
  const rows = calls.data ?? [];
  return (
    <Stack gap="xs">
      <Text component="h5" fw={600} size="sm" m={0}>
        Recent decisions
      </Text>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No decisions yet.
        </Text>
      ) : (
        <ul aria-label="Recent decisions" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((call) => (
            <RecentCall key={call.id} call={call} />
          ))}
        </ul>
      )}
    </Stack>
  );
}

/** Settings › Decisions: the OpenRouter key, the master switch and each routine decision a fast model makes. */
export function DecisionsSection() {
  const status = useJudgeStatus();
  const patch = usePatchJudge();
  if (status.isPending) return <Text c="dimmed">Loading…</Text>;
  if (status.isError) return <Alert color="red">{status.error.message}</Alert>;
  const { config, keySet, off } = status.data;
  const review = config.decisions[REVIEW];
  // Controls stay disabled while the daemon runs with the judge off.
  const disabled = off;
  return (
    <Stack gap="lg">
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
        <KeyRow keySet={keySet} disabled={disabled} />
        <TestRow disabled={disabled} />
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
        <SettingRow label="Model" description="An OpenRouter model id.">
          <TextInput
            key={review.model}
            aria-label="Model"
            defaultValue={review.model}
            disabled={disabled}
            spellCheck={false}
            onBlur={(event) => {
              const model = event.currentTarget.value.trim();
              if (model !== '' && model !== review.model)
                patch.mutate({ decisions: { [REVIEW]: { model } } });
            }}
          />
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
      <RecentDecisions />
    </Stack>
  );
}
