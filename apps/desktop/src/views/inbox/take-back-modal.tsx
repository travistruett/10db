import type { InboxItemDto } from '@10db/contracts';
import { useTakeBack } from '../../daemon/people';
import { ConfirmModal } from '../../shell/confirm-modal';
import { joinNames } from './route-line';

/** Take Back posts in the person's Slack thread, so it asks first and says what it will do. */
export function TakeBackModal({
  item,
  opened,
  onClose,
}: {
  readonly item: InboxItemDto;
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  const takeBack = useTakeBack();
  const names = joinNames((item.send?.people ?? []).filter((p) => p.recipient).map((p) => p.name));
  return (
    <ConfirmModal
      opened={opened}
      title={`Take this back from ${names}?`}
      confirmLabel="Take Back"
      loading={takeBack.isPending}
      error={takeBack.isError ? takeBack.error.message : null}
      onCancel={onClose}
      onConfirm={() => {
        takeBack.mutate(item.id, { onSuccess: onClose });
      }}
    >
      10db tells them in the Slack thread that you have it, and the question comes back to your Open
      tab for you to answer.
    </ConfirmModal>
  );
}
