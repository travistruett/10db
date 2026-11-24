import { MAX_SMALL_PROPOSAL_LIMIT, type ProjectDto } from '@10db/contracts';
import { NumberInput } from '@mantine/core';
import { useSetSmallProposalLimit, useSmallProposalLimit } from '../../daemon/proposal-queries';
import { SettingRow } from './setting-row';
import { useDraft } from './settings-drafts';

export const SMALL_PROPOSAL_LIMIT_LABEL = 'Size Limit for Small Proposals';

/**
 * How large a lane's new-task proposal can be, in characters of title and body, for 10db to file it to
 * the Icebox without an Inbox card. A proposal of a kind that goes to the Inbox, over the limit or asking to join a
 * running batch still raises a card, and so does every proposal when this is zero.
 */
export function SmallProposalLimitSetting({ project }: { readonly project: ProjectDto }) {
  const setting = useSmallProposalLimit(project.id);
  const set = useSetSmallProposalLimit(project.id);
  // '' is a field the builder cleared: it stays empty until a number is typed, and Save refuses it.
  const limit = useDraft<number | ''>({
    saved: setting.data?.limit,
    save: (value) => set.mutateAsync(Number(value)),
    problem: (value) =>
      value === '' ? 'Enter a limit, or 0 to send every proposal to the Inbox' : null,
  });
  return (
    <SettingRow
      label={SMALL_PROPOSAL_LIMIT_LABEL}
      description="The longest proposal filed to the Icebox without a card."
      help="A task a lane proposes that is no longer than this many characters (title and body) and has no kind that sends its proposals to the Inbox is filed to the Icebox by 10db, with no Inbox card. Anything bigger, of such a kind, or asking to join a running batch still comes to the Inbox. Zero sends every proposal to the Inbox."
    >
      <NumberInput
        aria-label={SMALL_PROPOSAL_LIMIT_LABEL}
        suffix=" characters"
        style={{ flex: 1 }}
        min={0}
        max={MAX_SMALL_PROPOSAL_LIMIT}
        allowDecimal={false}
        allowNegative={false}
        allowLeadingZeros={false}
        clampBehavior="strict"
        value={limit.value ?? ''}
        error={limit.problem}
        disabled={setting.data === undefined}
        onChange={(next) => {
          // Mantine can hand a number over as text; only '' means cleared.
          limit.set(next === '' ? '' : Number(next));
        }}
      />
    </SettingRow>
  );
}
