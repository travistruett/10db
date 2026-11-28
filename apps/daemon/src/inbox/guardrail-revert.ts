import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  Answerer,
  BuilderOwns,
  InboxKind,
  type InboxAnswer,
  type InboxItemDto,
} from '@10db/contracts';
import { updateInboxItem, type WriteContext } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import { existsAsEntry, type Git } from '../git';
import type { Logger } from '../log';
import { keepCopy } from '../watcher';
import { BY_ANSWER, CardTier, decidedByBuilder } from './card-tier';
import { GuardrailStrayChoice } from './guardrail-card';
import { flagCard, type FlagInput } from './service';
import {
  changedSinceCard,
  readSmallFile,
  shaOf,
  stampedStray,
  stampFile,
  type StampedStray,
} from './trusted-writes';

/** A file bigger than this is neither kept nor removed by Revert. */
const MAX_REVERT_BYTES = 32 * 1024 * 1024;

/** What a Revert came to: what the card's answer says, and the card to raise again when the file was not put back. */
interface Reverted {
  readonly note: string;
  readonly again?: FlagInput;
}

/** Whether `rel` in `root` lies in the checkout itself, with no link on the way that leads out of it. */
function insideCheckout(root: string, rel: string): boolean {
  try {
    const real = realpathSync(root);
    const parent = realpathSync(dirname(join(root, rel)));
    return parent === real || parent.startsWith(`${real}${sep}`);
  } catch {
    return false;
  }
}

/** The card again, with the reason the file was not reverted; the file is as it was. */
function notReverted(item: InboxItemDto, stray: StampedStray, reason: string): Reverted {
  return {
    note: `Not reverted: ${reason}`,
    again: {
      projectId: item.projectId,
      tier: CardTier.Ask,
      urgency: item.urgency,
      closesWhen: BY_ANSWER,
      decision: decidedByBuilder(BuilderOwns.Guardrails),
      workstreamId: item.targets[0]?.workstreamId ?? null,
      title: item.title,
      body: `${item.body.split('\n')[0] ?? stray.path}\nCould not revert: ${reason}`,
      detail: item.detail ?? {},
      options: item.options,
      foldKey: stray.foldKey,
    },
  };
}

/**
 * Answers to a guardrail stray-write card that act on the file. Keep trusts the stamped content in the answer's
 * own write (`applyTrustChoice`). Revert runs after that write, as a job: the file is stamped again, and one that
 * no longer holds the card's stamp is left alone and the card is raised afresh. A committed file is restored from
 * `HEAD`; an untracked one is copied under `<home>/.10db/kept`, the copy read back and compared byte for byte, and
 * only then removed. The card's answer says what was done, and for an untracked file where the copy is.
 */
export function createGuardrailAnswers(deps: {
  readonly state: StateStore;
  readonly git: Git;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The builder's home, where kept copies go; the daemon's own by default. */
  readonly home?: string;
}): {
  onAnswer(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): (() => void) | undefined;
} {
  const home = deps.home ?? homedir();

  async function revert(item: InboxItemDto, stray: StampedStray): Promise<Reverted> {
    const { path, root, foldKey, stamped } = stray;
    const now = stampFile(root, path);
    if (now === null && !existsAsEntry(join(root, path)))
      return { note: `${path} is already gone, so there is nothing to revert` };
    if (now !== stamped)
      return {
        note: 'Not reverted: the file changed after the card was raised, so a new card shows what it holds now',
        again: changedSinceCard(item, root, foldKey, now),
      };
    const committed = await deps.git.fileAt(root, 'HEAD', path, MAX_REVERT_BYTES);
    if (committed.kind !== 'missing') {
      const [onDisk] = await deps.git.hashOnDisk(root, [path]);
      const done = await deps.git.restoreFiles(
        root,
        [{ path, from: 'HEAD' }],
        [{ path, blob: onDisk?.blob ?? null }],
      );
      if (done.left.includes(path))
        return notReverted(
          item,
          stray,
          'the file is not one git can put back, or it changed while it was read',
        );
      return { note: `Reverted ${path}: put back as the committed file has it` };
    }
    const read = readSmallFile(join(root, path), MAX_REVERT_BYTES);
    if (read.kind !== 'file' || !insideCheckout(root, path))
      return notReverted(
        item,
        stray,
        'the path is not a plain file in the checkout, so it is left as it is',
      );
    const copy = keepCopy(home, item.projectId, path, read.bytes, deps.clock.now());
    if (!readFileSync(copy).equals(read.bytes))
      return notReverted(
        item,
        stray,
        `the copy at ${copy} did not match the file, so the file is left as it is`,
      );
    if (shaOf(read.bytes) !== stamped || stampFile(root, path) !== stamped)
      return {
        note: `Not reverted: the file changed while a copy was made (the copy is at ${copy}), so a new card shows what it holds now`,
        again: changedSinceCard(item, root, foldKey, stampFile(root, path)),
      };
    unlinkSync(join(root, path));
    return { note: `Removed ${path}. A copy is kept at ${copy}` };
  }

  async function run(item: InboxItemDto, stray: StampedStray, answer: InboxAnswer): Promise<void> {
    let result: Reverted;
    try {
      result = await revert(item, stray);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.logger.error({ cardId: item.id, path: stray.path, error: reason }, 'a Revert failed');
      result = notReverted(item, stray, reason);
    }
    const recorded = item.answer;
    deps.state.write((ctx) => {
      if (result.again) flagCard(ctx, result.again);
      if (recorded === null) return;
      updateInboxItem(ctx, item.id, {
        answer: {
          ...recorded,
          answerer: recorded.answerer ?? Answerer.Builder,
          note: [answer.note, result.note]
            .filter((part) => part !== undefined && part !== '')
            .join('\n'),
        },
      });
    });
  }

  return {
    onAnswer(_ctx, item, answer) {
      if (item.kind !== InboxKind.Flag || answer.choice !== GuardrailStrayChoice.Revert)
        return undefined;
      if (!item.options.some((option) => option.label === GuardrailStrayChoice.Revert))
        return undefined;
      const stray = stampedStray(item);
      if (stray === null) return undefined;
      return () => {
        void run(item, stray, answer).catch((error: unknown) => {
          deps.logger.error(
            { cardId: item.id, error: String(error) },
            'a Revert could not be recorded',
          );
        });
      };
    },
  };
}
