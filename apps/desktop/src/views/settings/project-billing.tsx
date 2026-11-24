import { AccountId, USAGE_HANDOFF_MAX, USAGE_HANDOFF_MIN, type ProjectDto } from '@10db/contracts';
import { NumberInput, Stack } from '@mantine/core';
import { useAccounts } from '../../daemon/account-queries';
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
  const limit = useProjectFields(project, ['budgetCeiling']);
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
      <HiddenFieldAlert fields={limit} />
    </Stack>
  );
}
