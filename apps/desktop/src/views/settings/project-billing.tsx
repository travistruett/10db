import { AccountId, USAGE_HANDOFF_MAX, USAGE_HANDOFF_MIN, type ProjectDto } from '@10db/contracts';
import { Alert, NumberInput, Select, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useAccounts, usePatchProject } from '../../daemon/queries';
import { accountOptions } from './account-kind-label';

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
    <Stack gap="xs">
      <Select
        label="Account"
        description="Who pays for this project's sessions. Work in flight moves with it: each lane's next session runs on the new account."
        data={accountOptions(accounts)}
        value={project.accountId}
        allowDeselect={false}
        disabled={patch.isPending}
        onChange={(value) => {
          if (value !== null && value !== project.accountId)
            patch.mutate({ accountId: AccountId.parse(value) });
        }}
      />
      <Select
        label="Fallback account"
        description="Where 10db moves the project when its account reaches a usage limit: at 95% on a Claude subscription, after a handoff, and at the limit itself on any account. A metered fallback needs a monthly cap."
        placeholder="None"
        // The project's own account is never offered, but after 10db moved the project onto its fallback
        // the recorded fallback is that account, and it still shows.
        data={accountOptions(accounts).filter(
          (o) => o.value !== project.accountId || o.value === project.fallbackAccountId,
        )}
        value={project.fallbackAccountId}
        clearable
        disabled={patch.isPending}
        onChange={(value) => {
          if (value !== project.fallbackAccountId)
            patch.mutate({ fallbackAccountId: value === null ? null : AccountId.parse(value) });
        }}
      />
      <NumberInput
        label="Hand off at"
        description="The share of the account's usage limit at which 10db asks running lanes to hand off and moves the project to its fallback, or asks where to move it. It applies only on a Claude subscription account: other accounts report only the limit itself."
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
      {patch.error ? (
        <Alert color="red" title="Couldn't change the project's accounts">
          {patch.error.message}
        </Alert>
      ) : null}
      <Text size="sm" c="dimmed">{`Default model: ${project.model}@${project.effort}`}</Text>
    </Stack>
  );
}
