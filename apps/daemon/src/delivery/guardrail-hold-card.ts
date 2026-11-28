import {
  BuilderOwns,
  InboxAnswerRefused,
  Urgency,
  type BatchDto,
  type BatchId,
  type InboxAnswer,
  type InboxItemDto,
} from '@10db/contracts';
import {
  deleteAppSetting,
  findOpenByFoldKey,
  getBatch,
  setAppSetting,
  type WriteContext,
} from '@10db/db';
import { GUARDRAIL_PATHS } from '../guardrails';
import {
  BY_ANSWER,
  CardTier,
  decidedByBuilder,
  GUARDRAIL_DIFF_DETAIL,
  GUARDRAIL_HOLD_DETAIL,
  GuardrailHoldDetail,
  GuardrailPrChoice,
  guardrailNoDiffDetail,
  guardrailPatchDetail,
  guardrailPrOptions,
  guardrailPrTitle,
} from '../inbox';
import type { Card } from './cards';
import { detailOf } from './cards';
import { patchCiOutOfMoves } from './ci-stop';
import { ghCall, raiseIn, withdrawIn, type DeliveryContext } from './context';
import { guardrailHoldKey, type GuardrailReading } from './guardrail-hold';

/** The one card of the root batch's held pull request. */
export const guardrailHoldCardKey = (rootId: BatchId): string => `guardrail-hold:${rootId}`;

/** How many hit paths the card's body lists before it counts the rest. */
const LISTED_PATHS = 20;

/** The kinds the reading's hits touch, as the labels of the list's own rows, in the list's order. */
function labelsOf(reading: GuardrailReading): string[] {
  const hit = new Set((reading.hits ?? []).map((h) => h.label));
  return GUARDRAIL_PATHS.map((row) => row.label).filter((label) => hit.has(label));
}

/** The card for a pull request held for the builder: what changes, the diff, and Merge or Close. */
export function guardrailHoldCard(root: BatchDto, prUrl: string, reading: GuardrailReading): Card {
  const readable = reading.hits !== null && reading.diffHash !== null;
  const hits = reading.hits ?? [];
  const listed = hits.slice(0, LISTED_PATHS).map((hit) => `- ${hit.path}`);
  if (hits.length > LISTED_PATHS) listed.push(`- and ${String(hits.length - LISTED_PATHS)} more`);
  const body = readable
    ? [
        `Pull request: ${prUrl}`,
        `10db left auto-merge off because this pull request changes the files that guard your machine:\n${listed.join('\n')}`,
        'Merge approves exactly the diff below and lets the pull request merge as the batch asked. A later, different change to these files asks again. Close closes the pull request.',
      ].join('\n\n')
    : [
        `Pull request: ${prUrl}`,
        "10db could not read what this pull request changes, so it left auto-merge off and merged nothing. Look at the pull request. Close closes it; to merge it, do so yourself on GitHub once you've read it.",
      ].join('\n\n');
  const diff =
    reading.diff !== null && reading.diff !== ''
      ? guardrailPatchDetail(reading.diff)
      : guardrailNoDiffDetail(
          readable ? 'git shows no text for these files' : 'the diff could not be read',
        );
  return {
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    decision: decidedByBuilder(BuilderOwns.Guardrails),
    title: guardrailPrTitle(labelsOf(reading)),
    body,
    foldKey: guardrailHoldCardKey(root.id),
    options: guardrailPrOptions(readable),
    detail: {
      batchId: root.id,
      prUrl,
      link: prUrl,
      [GUARDRAIL_HOLD_DETAIL]: { batchId: root.id, hash: reading.diffHash, prUrl },
      [GUARDRAIL_DIFF_DETAIL]: diff,
    },
  };
}

/**
 * Raises the held pull request's card in the caller's own write. A card already open for the same diff stays
 * as it is; one raised for another diff is withdrawn and raised afresh, so it always shows what is held now.
 */
export function raiseGuardrailHold(
  ctx: Pick<DeliveryContext, 'state'>,
  root: BatchDto,
  prUrl: string,
  reading: GuardrailReading,
): void {
  ctx.state.write((w) => {
    const key = guardrailHoldCardKey(root.id);
    const open = findOpenByFoldKey(w.tx, root.projectId, key);
    if (open) {
      const raisedFor = GuardrailHoldDetail.safeParse(open.detail?.[GUARDRAIL_HOLD_DETAIL]);
      if (raisedFor.success && raisedFor.data.hash === reading.diffHash) return;
      withdrawIn(w, root.projectId, [key]);
    }
    raiseIn(w, root.projectId, guardrailHoldCard(root, prUrl, reading));
  });
}

/** Drops the hold's approval and its card, inside the write that records the pull request merged or closed. */
export function clearGuardrailHold(w: WriteContext, root: BatchDto): void {
  withdrawIn(w, root.projectId, [guardrailHoldCardKey(root.id)]);
  deleteAppSetting(w, guardrailHoldKey(root.id));
}

/**
 * Closes the held pull request once the answer that dropped it is committed. A refusal from GitHub clears the drop,
 * so the watch raises its own card for a close it did not expect, and raises a card saying 10db could not close it.
 */
export function closeHeldPullRequest(ctx: DeliveryContext, rootId: BatchId, prUrl: string): void {
  const root = getBatch(ctx.state.db, rootId);
  if (root.repo === null) return;
  const call = ghCall(ctx, new AbortController().signal);
  ctx.gh.closePullRequest({ repo: root.repo, url: prUrl }, call).catch((error: unknown) => {
    ctx.logger.warn(
      { batchId: rootId, err: detailOf(error) },
      'could not close a held pull request',
    );
    ctx.state.write((w) => {
      patchCiOutOfMoves(w, rootId, { dropped: false });
      raiseIn(w, root.projectId, {
        tier: CardTier.Ask,
        urgency: Urgency.Normal,
        closesWhen: BY_ANSWER,
        decision: decidedByBuilder(BuilderOwns.Guardrails),
        title: `Could not close the pull request for ${root.title}`,
        body: `GitHub did not close it: ${detailOf(error)}\n\nPull request: ${prUrl}\n\n10db has not merged it. Close it on GitHub.`,
        foldKey: `${guardrailHoldCardKey(rootId)}:close`,
        detail: { batchId: rootId, prUrl, link: prUrl },
      });
    });
  });
}

/** What answering the card needs of the shipper. */
export interface GuardrailHoldArming {
  /**
   * Reads the held pull request's diff at its current head once the answer is committed, and turns
   * auto-merge on for the root when the builder's approval covers it; a head that moved raises the card again.
   */
  armApproved(rootId: BatchId, prUrl: string): void;
}

/**
 * Acts on a held pull request's card inside the write that closes it. Merge stores the card's hash as the
 * approval in that write, and arms the pull request once the write committed. Close marks the pull request
 * as dropped by the builder (so the watch raises no closed card) and closes it once the write committed; a
 * refusal from GitHub raises a card saying so. Any other card changes nothing.
 */
export function createGuardrailHoldAnswers(
  ctx: DeliveryContext,
  shipper: GuardrailHoldArming,
): {
  onAnswerInWrite(
    w: WriteContext,
    item: InboxItemDto,
    answer: InboxAnswer,
  ): (() => void) | undefined;
} {
  return {
    onAnswerInWrite(w, item, answer) {
      const held = GuardrailHoldDetail.safeParse(item.detail?.[GUARDRAIL_HOLD_DETAIL]);
      if (!held.success) return undefined;
      const { batchId, hash, prUrl } = held.data;
      switch (answer.choice) {
        case GuardrailPrChoice.Merge:
          if (hash === null)
            throw new InboxAnswerRefused(
              "10db could not read this diff, so it can't approve it. Merge the pull request on GitHub yourself, or close it",
            );
          setAppSetting(w, guardrailHoldKey(batchId), { approved: hash });
          return () => {
            shipper.armApproved(batchId, prUrl);
          };
        case GuardrailPrChoice.Close:
          patchCiOutOfMoves(w, batchId, { dropped: true });
          return () => {
            closeHeldPullRequest(ctx, batchId, prUrl);
          };
        default:
          return undefined;
      }
    },
  };
}
