import {
  AccountId,
  CeilingMeasure,
  USAGE_HANDOFF_MAX,
  USAGE_HANDOFF_MIN,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import { NumberInput, Stack, Text } from '@mantine/core';
import { useAccounts, useAutoCeilingToday } from '../../daemon/account-queries';
import { usePatchProject } from '../../daemon/queries';
import { AccountSelect } from './account-select';
import { cantRunAgents } from './accounts/used-by';
import { HiddenFieldAlert } from './hidden-field-alert';
import { asNumber, useProjectFields } from './project-fields-state';
import { useDraft } from './settings-drafts';
import { SettingRow, SettingsCard } from './setting-row';

const MIN_PCT = Math.round(USAGE_HANDOFF_MIN * 100);
const MAX_PCT = Math.round(USAGE_HANDOFF_MAX * 100);

/**
 * Which account pays for the project, and the fallback 10db moves it to near a usage limit
 * (accounts spec §6, §7). Work in flight follows a move at each lane's next session. Every field here
 * waits for the page's Save.
 */
export function ProjectBilling({ project }: { readonly project: ProjectDto }) {
  const accounts = useAccounts().data ?? [];
  const patch = usePatchProject(project.id);
  const limit = useProjectFields(project, [
    'budgetCeiling',
    'autoCeilingUsd',
    'autoCeilingShare',
    'autoCeilingSessions',
  ]);
  // One patch for both: the daemon checks the backup against the account sent with it.
  const pair = useDraft({
    saved: { accountId: project.accountId, fallbackAccountId: project.fallbackAccountId },
    // Only what the builder changed: a move 10db made since the edit began is not undone.
    save: (value) =>
      patch.mutateAsync({
        ...(value.accountId === project.accountId ? {} : { accountId: value.accountId }),
        ...(value.fallbackAccountId === project.fallbackAccountId
          ? {}
          : { fallbackAccountId: value.fallbackAccountId }),
      }),
  });
  const accountId = pair.value?.accountId ?? project.accountId;
  const fallbackAccountId = pair.value?.fallbackAccountId ?? null;
  const handoff = useDraft<string | number>({
    saved: Math.round(project.usageHandoffAt * 100),
    save: (pct) => patch.mutateAsync({ usageHandoffAt: Number(pct) / 100 }),
    // The API's range, in whole percent: Save never sends what PATCH would refuse.
    problem: (value) => {
      const pct = Number(value);
      return value !== '' && Number.isInteger(pct) && pct >= MIN_PCT && pct <= MAX_PCT
        ? null
        : `Between ${String(MIN_PCT)}% and ${String(MAX_PCT)}%`;
    },
    same: (a, b) => Number(a) === Number(b) && a !== '',
  });
  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingRow
          label="Account"
          description="Whose plan pays for this project's sessions."
          help="Running tasks switch at their next session."
        >
          <AccountSelect
            aria-label="Account"
            accounts={accounts}
            isDisabled={cantRunAgents}
            value={accountId}
            allowDeselect={false}
            onChange={(value) => {
              if (value === null) return;
              const next = AccountId.parse(value);
              // The new account can't also be its own backup.
              pair.set({
                accountId: next,
                fallbackAccountId: fallbackAccountId === next ? null : fallbackAccountId,
              });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Backup Account"
          description="Used when the account reaches its usage limit."
          help="A pay-as-you-go backup needs a monthly cap."
        >
          <AccountSelect
            aria-label="Backup Account"
            placeholder="None"
            // The project's own account is never offered, but after 10db moved the project onto its fallback
            // the recorded fallback is that account, and it still shows.
            accounts={accounts.filter(
              (a) =>
                a.id !== accountId ||
                (a.id === project.fallbackAccountId && accountId === project.accountId),
            )}
            isDisabled={cantRunAgents}
            value={fallbackAccountId}
            clearable
            onChange={(value) => {
              pair.set({
                accountId,
                fallbackAccountId: value === null ? null : AccountId.parse(value),
              });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Switch At"
          description="How much of a Claude plan's limit to use first."
          help="On a Claude plan, how much of the usage limit to use before running tasks hand off and move to the backup."
        >
          <NumberInput
            aria-label="Switch At"
            suffix="%"
            min={MIN_PCT}
            max={MAX_PCT}
            allowDecimal={false}
            clampBehavior="none"
            value={handoff.value ?? ''}
            error={handoff.problem}
            onChange={handoff.set}
          />
        </SettingRow>
        <SettingRow
          label="Spending Limit per Task"
          description="Models that cost more per task aren't used."
        >
          <NumberInput
            aria-label="Spending Limit per Task"
            min={0}
            decimalScale={2}
            prefix="$"
            placeholder="No limit"
            value={limit.values.budgetCeiling}
            error={limit.errors.budgetCeiling}
            onChange={(v) => {
              limit.set({ budgetCeiling: asNumber(v) });
            }}
          />
        </SettingRow>
      </SettingsCard>
      <SettingsCard
        title="Daily Ceiling for 10db's Own Work"
        description="Fix tasks, CI fixes and re-runs 10db starts itself wait for the day once they reach it. Work you start is never held."
      >
        <SettingRow
          label="Dollars a Day"
          description="Counted on a pay-as-you-go account (Bedrock, an API key or OpenRouter)."
        >
          <NumberInput
            aria-label="Daily Ceiling, Dollars"
            min={0}
            decimalScale={2}
            prefix="$"
            clampBehavior="none"
            value={limit.values.autoCeilingUsd}
            error={limit.errors.autoCeilingUsd}
            onChange={(v) => {
              limit.set({ autoCeilingUsd: asNumber(v) });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Share of the Plan's Limit"
          description="Counted on a Claude or ChatGPT plan, from the share each session reports."
        >
          <NumberInput
            aria-label="Daily Ceiling, Share of the Plan's Limit"
            min={0}
            max={100}
            decimalScale={1}
            suffix="%"
            clampBehavior="none"
            value={limit.values.autoCeilingShare}
            error={limit.errors.autoCeilingShare}
            onChange={(v) => {
              limit.set({ autoCeilingShare: asNumber(v) });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Sessions Not Measured"
          description="Counted for a plan session that reported no share and for a metered session that used tokens but has no cost (a model its list gives no price, or a Codex report of $0). Every kind of account checks this one."
        >
          <NumberInput
            aria-label="Daily Ceiling, Sessions Not Measured"
            min={1}
            allowDecimal={false}
            clampBehavior="none"
            value={limit.values.autoCeilingSessions}
            error={limit.errors.autoCeilingSessions}
            onChange={(v) => {
              limit.set({ autoCeilingSessions: asNumber(v) });
            }}
          />
        </SettingRow>
        <AutoCeilingToday projectId={project.id} />
      </SettingsCard>
      <HiddenFieldAlert fields={limit} />
    </Stack>
  );
}

/** What each measure of the ceiling is counted in, for the line that says which one the account uses. */
const MEASURE_WORDS: Readonly<Record<CeilingMeasure, string>> = {
  [CeilingMeasure.Usd]: "Counted in dollars: this project's account is pay-as-you-go.",
  [CeilingMeasure.Share]: "Counted by the share of the plan's limit its sessions report.",
  [CeilingMeasure.Sessions]:
    'Counted by sessions that could not be measured: this plan has reported no share today.',
};

/** Today's count of 10db's own work, the measure in use and what it can't tell. */
function AutoCeilingToday({ projectId }: { readonly projectId: ProjectId }) {
  const today = useAutoCeilingToday(projectId).data;
  if (today === undefined) return null;
  const dollars = `$${today.usd.toFixed(2)}`;
  const share = `${String(Math.round(today.share * 1000) / 10)}% of the plan's limit`;
  const sessions = `${String(today.unmeasured)} ${today.unmeasured === 1 ? 'session' : 'sessions'} not measured`;
  return (
    <Stack gap={4} p="md" data-testid="auto-ceiling-today">
      <Text size="sm" fw={500}>
        Today: {dollars} · {share} · {sessions}
      </Text>
      <Text size="xs" c="dimmed">
        {MEASURE_WORDS[today.measure]}
        {today.carryOns > 0
          ? ` Carried on ${String(today.carryOns)} ${today.carryOns === 1 ? 'time' : 'times'} today.`
          : ''}
      </Text>
      <Text size="xs" c="dimmed">
        On a plan the share is the account&apos;s whole rise while a session ran, so other use of
        the plan then (other sessions, your own, use outside 10db) counts as 10db&apos;s: 10db stops
        early, never late.
      </Text>
    </Stack>
  );
}
