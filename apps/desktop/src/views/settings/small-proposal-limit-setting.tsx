import { MAX_SMALL_PROPOSAL_LIMIT, type ProjectDto } from '@10db/contracts';
import { Button, NumberInput, Stack } from '@mantine/core';
import { useState } from 'react';
import { useSetSmallProposalLimit, useSmallProposalLimit } from '../../daemon/proposal-queries';
import { SettingRow, SettingsCard } from './setting-row';

export const SMALL_PROPOSAL_LIMIT_LABEL = 'Size limit for small proposals';

/**
 * How large a lane's new-task proposal can be, in characters of title and body, for 10db to file it to
 * the Icebox without an Inbox card. A proposal of a kind that goes to the Inbox, over the limit or asking to join a
 * running batch still raises a card, and so does every proposal when this is zero.
 */
export function SmallProposalLimitSetting({ project }: { readonly project: ProjectDto }) {
  const setting = useSmallProposalLimit(project.id);
  const set = useSetSmallProposalLimit(project.id);
  // null = untouched (show the saved limit); '' = the builder cleared the field, which stays empty
  // until a number is typed, so retyping from scratch (backspace, then 0) works.
  const [draft, setDraft] = useState<number | '' | null>(null);
  const saved = setting.data?.limit;
  const value = draft ?? saved;
  const changed = typeof draft === 'number' && draft !== saved;
  return (
    <SettingsCard>
      <SettingRow
        label={SMALL_PROPOSAL_LIMIT_LABEL}
        description="A task a lane proposes that is no longer than this many characters (title and body) and has no kind that sends its proposals to the Inbox is filed to the Icebox by 10db, with no Inbox card. Anything bigger, of such a kind, or asking to join a running batch still comes to the Inbox. Zero sends every proposal to the Inbox."
        stacked
      >
        <Stack gap="xs">
          <NumberInput
            aria-label={SMALL_PROPOSAL_LIMIT_LABEL}
            min={0}
            max={MAX_SMALL_PROPOSAL_LIMIT}
            allowDecimal={false}
            allowNegative={false}
            allowLeadingZeros={false}
            clampBehavior="strict"
            value={value ?? ''}
            disabled={setting.data === undefined}
            onChange={(next) => {
              // Mantine can hand a number over as text; only '' means cleared.
              setDraft(next === '' ? '' : Number(next));
            }}
          />
          <Button
            size="xs"
            w="fit-content"
            disabled={!changed || set.isPending}
            onClick={() => {
              if (typeof draft !== 'number') return;
              set.mutate(draft, {
                onSuccess: () => {
                  setDraft(null);
                },
              });
            }}
          >
            Save Proposal Limit
          </Button>
        </Stack>
      </SettingRow>
    </SettingsCard>
  );
}
