import type { InboxItemDto, PassViewDto } from '@10db/contracts';
import { Button, List, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { FormModal } from '../../shell/form-modal';
import { PageStatus, pageStatus } from './page-status';
import { medianTurnMinutes } from './timing';

export interface AbandonModalProps {
  readonly view: PassViewDto;
  /** The open Inbox items, which a page's status reads. */
  readonly inbox: readonly InboxItemDto[];
  /** Now, in epoch milliseconds. */
  readonly now: number;
  readonly onClose: () => void;
  /** Abandons the pass: its route in the daemon. */
  readonly abandon: () => Promise<unknown>;
}

interface PageListProps {
  /** The list's name for assistive tech. */
  readonly name: string;
  readonly says: string;
  readonly pages: readonly string[];
}

function PageList({ name, says, pages }: PageListProps) {
  return (
    <Stack gap={4}>
      <Text size="sm">{says}</Text>
      <List size="sm" aria-label={name}>
        {pages.map((page) => (
          <List.Item key={page}>{page}</List.Item>
        ))}
      </List>
    </Stack>
  );
}

/**
 * Abandon Pass…'s confirm (Workbench spec §5.4): names every page that goes back to how it was before
 * the pass, its task keeping the work, and every signed-off page, which stays.
 */
export function AbandonModal({ view, inbox, now, onClose, abandon }: AbandonModalProps) {
  const leaving = useMutation({ mutationFn: () => abandon(), onSuccess: onClose });
  const clock = { now, medianTurnMinutes: medianTurnMinutes(view.turns) };
  const signedOff = (page: PassViewDto['pages'][number]) =>
    pageStatus(page, inbox, clock).status === PageStatus.SignedOff;
  const reverts = view.pages.filter((page) => !signedOff(page)).map((page) => page.area);
  const stays = view.pages.filter(signedOff).map((page) => page.area);
  return (
    <FormModal
      opened
      onClose={onClose}
      title="Abandon Pass"
      size="md"
      error={leaving.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={leaving.isPending}
            onClick={() => {
              leaving.mutate();
            }}
          >
            Abandon Pass
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Text size="sm">{`Abandon ${view.pass.name}? Turns that are working stop.`}</Text>
        {reverts.length > 0 ? (
          <PageList
            name="Pages that go back"
            says="These go back to how they were before the pass; each task keeps its work for its next start:"
            pages={reverts}
          />
        ) : null}
        {stays.length > 0 ? (
          <PageList
            name="Pages that stay"
            says="These are signed off and stay as they landed:"
            pages={stays}
          />
        ) : null}
      </Stack>
    </FormModal>
  );
}
