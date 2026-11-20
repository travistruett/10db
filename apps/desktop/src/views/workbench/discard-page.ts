import {
  SharedChoiceKind,
  type PassId,
  type SharedChoice,
  type SharedUnlandedDto,
  type TaskId,
} from '@10db/contracts';
import { useMutation } from '@tanstack/react-query';
import { useTakeOutPage } from '../../daemon/pass-queries';

/** A Discard the daemon stopped before deleting anything, said in words. */
export class DiscardStoppedError extends Error {
  override readonly name = 'DiscardStoppedError';
}

/** Drop for every shared change that can be dropped, Keep for the rest. */
export function discardChoices(shared: readonly SharedUnlandedDto[]): SharedChoice[] {
  return shared.map((change) => ({
    seq: change.seq,
    choice: change.dropRefusal === null ? SharedChoiceKind.Drop : SharedChoiceKind.Keep,
  }));
}

/**
 * Discard Page: one take-out that deletes the page's changes, puts its files back as they were before
 * the pass, retires a Board task the pass made for it and sends one brought in from the Board back
 * there open. Recorded on the daemon's take-out row, so a restart finishes it the same way.
 */
export function useDiscardPage({
  passId,
  taskId,
  label,
}: {
  readonly passId: PassId;
  readonly taskId: TaskId;
  readonly label: string;
}) {
  const takeOut = useTakeOutPage();
  return useMutation({
    mutationFn: async (shared: readonly SharedUnlandedDto[]): Promise<void> => {
      const taken = await takeOut.mutateAsync({
        passId,
        taskId,
        shared: discardChoices(shared),
        discard: true,
      });
      if (!taken.tookOut)
        throw new DiscardStoppedError(
          `${label} stays, with nothing deleted: its files kept changing (${taken.stillChanging.join(', ')}). Try again once they settle.`,
        );
    },
  });
}
