import { AccountId, USAGE_HANDOFF_MAX, USAGE_HANDOFF_MIN, type ProjectDto } from '@10db/contracts';
import { NumberInput, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useAccounts } from '../../daemon/account-queries';
import { usePatchProject } from '../../daemon/queries';
import { AccountSelect } from './account-select';
import { SettingRow, SettingsCard } from './setting-row';

const MIN_PCT = Math.round(USAGE_HANDOFF_MIN * 100);
const MAX_PCT = Math.round(USAGE_HANDOFF_MAX * 100);

/**
 * Which account pays for the project, and the fallback 10db moves it to near a usage limit
 * (accounts spec §6, §7). Work in flight follows a move at each lane's next session.
 */
export function ProjectBilling({ project }: { readonly project: ProjectDto }) {
  const accounts = useAccounts().data ?? [];
  const patch = usePatchProject(project.id);
  const [handoffPct, setHandoffPct] = useState<string | number>(
    Math.round(project.usageHandoffAt * 100),
  );
  const pct = Number(handoffPct);
  // The API's range, in whole percent: the field never sends what PATCH would refuse.
  const handoffError =
    Number.isInteger(pct) && pct >= MIN_PCT && pct <= MAX_PCT
      ? null
      : `Between ${String(MIN_PCT)}% and ${String(MAX_PCT)}%`;
  return (
    <Stack gap="md">
      <SettingsCard>
        <SettingRow
          label="Account"
          description="Whose plan pays for this project's sessions. Running tasks switch at their next session."
        >
          <AccountSelect
            aria-label="Account"
            accounts={accounts}
            value={project.accountId}
            allowDeselect={false}
            disabled={patch.isPending}
            onChange={(value) => {
              if (value !== null && value !== project.accountId)
                patch.mutate({ accountId: AccountId.parse(value) });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Backup account"
          description="Used when this account reaches its usage limit. A pay-as-you-go backup needs a monthly cap."
        >
          <AccountSelect
            aria-label="Backup account"
            placeholder="None"
            // The project's own account is never offered, but after 10db moved the project onto its fallback
            // the recorded fallback is that account, and it still shows.
            accounts={accounts.filter(
              (a) => a.id !== project.accountId || a.id === project.fallbackAccountId,
            )}
            value={project.fallbackAccountId}
            clearable
            disabled={patch.isPending}
            onChange={(value) => {
              if (value !== project.fallbackAccountId)
                patch.mutate({ fallbackAccountId: value === null ? null : AccountId.parse(value) });
            }}
          />
        </SettingRow>
        <SettingRow
          label="Switch at"
          description="On a Claude plan, how much of the usage limit to use before running tasks hand off and move to the backup."
        >
          <NumberInput
            aria-label="Switch at"
            suffix="%"
            min={MIN_PCT}
            max={MAX_PCT}
            allowDecimal={false}
            clampBehavior="none"
            value={handoffPct}
            error={handoffError}
            disabled={patch.isPending}
            onChange={setHandoffPct}
            onBlur={() => {
              if (handoffError === null && pct / 100 !== project.usageHandoffAt)
                patch.mutate({ usageHandoffAt: pct / 100 });
            }}
          />
        </SettingRow>
      </SettingsCard>
      {patch.error ? (
        <Text size="sm" c="red" role="alert">
          {`Couldn't change the project's accounts: ${patch.error.message}`}
        </Text>
      ) : null}
    </Stack>
  );
}
