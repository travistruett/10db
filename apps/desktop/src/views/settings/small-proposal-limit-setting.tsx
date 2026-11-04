import { MAX_SMALL_PROPOSAL_LIMIT, type ProjectDto } from '@10db/contracts';
import { Button, NumberInput, Stack } from '@mantine/core';
import { useState } from 'react';
import { useSetSmallProposalLimit, useSmallProposalLimit } from '../../daemon/proposal-queries';
import { SettingRow, SettingsCard } from './setting-row';

export const SMALL_PROPOSAL_LIMIT_LABEL = 'Size limit for small proposals';

/**
 * How large a lane's new-task proposal can be, in characters of title and body, for 10db to file it to
 * the Icebox without an Inbox card. A proposal with a risk tag, over the limit or asking to join a
 * running batch still raises a card, and so does every proposal when this is zero.
 */
export function SmallProposalLimitSetting({ project }: { readonly project: ProjectDto }) {
  const setting = useSmallProposalLimit(project.id);
  const set = useSetSmallProposalLimit(project.id);
  const [draft, setDraft] = useState<number | null>(null);
  const saved = setting.data?.limit;
  const value = draft ?? saved;
  const changed = draft !== null && draft !== saved;
  return (
    <SettingsCard>
      <SettingRow
        label={SMALL_PROPOSAL_LIMIT_LABEL}
        description="A task a lane proposes that is no longer than this many characters (title and body) and carries no risk tag (security, auth, migration, dependency) is filed to the Icebox by 10db, with no Inbox card. Anything bigger, risky, or asking to join a running batch still comes to the Inbox. Zero sends every proposal to the Inbox."
        stacked
      >
        <Stack gap="xs">
          <NumberInput
            aria-label={SMALL_PROPOSAL_LIMIT_LABEL}
            min={0}
            max={MAX_SMALL_PROPOSAL_LIMIT}
            allowDecimal={false}
            allowNegative={false}
            clampBehavior="strict"
            value={value ?? ''}
            disabled={setting.data === undefined}
            onChange={(next) => {
              setDraft(typeof next === 'number' ? next : null);
            }}
          />
          <Button
            size="xs"
            w="fit-content"
            disabled={!changed || set.isPending}
            onClick={() => {
              if (draft === null) return;
              set.mutate(draft, {
                onSuccess: () => {
                  setDraft(null);
                },
              });
            }}
          >
            Save proposal limit
          </Button>
        </Stack>
      </SettingRow>
    </SettingsCard>
  );
}
