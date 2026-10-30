import {
  CARD_RESOLVES_WHEN,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
} from '@10db/contracts';
import type { DbReader } from '@10db/db';
import { z } from 'zod';
import { CheckoutPin, GitTrustError, trustCard, type Git } from '../git';
import { cardsResolvedByEvent, resolveStaleCards, type InboxService } from '../inbox';
import type { Logger } from '../log';
import { projectAt } from './checkout-pins';

const GIT_TRUST_DETAIL = 'gitTrust';
const TRUST = 'Trust the checkout as it is now';
const OPTIONS: readonly InboxOption[] = [
  {
    label: TRUST,
    description: "10db records the checkout's git dirs and origin as they are now and carries on.",
  },
  { label: 'Later', description: 'Nothing changes; 10db keeps refusing until you choose.' },
];
const GitTrustDetail = z.object({ repo: z.string().startsWith('/'), candidate: CheckoutPin });

/**
 * Turns each refusal of the daemon's git into a card on the project whose checkout it refused, so
 * the builder hears of it whichever caller hit it. One card per checkout and cause stays open.
 */
export function createGitRefusalHandler(deps: {
  readonly db: DbReader;
  readonly inbox: InboxService;
  readonly logger: Logger;
}): (error: GitTrustError) => void {
  return (error) => {
    deps.logger.warn({ repo: error.repo, detail: error.detail }, 'git refused a checkout');
    const project = projectAt(deps.db, error.repo);
    if (!project) return;
    const card = trustCard(error);
    deps.inbox.flag({
      projectId: project.id,
      workstreamId: null,
      title: card.title,
      body: card.body,
      foldKey: card.foldKey,
      ...(card.candidate
        ? {
            options: OPTIONS,
            detail: {
              [GIT_TRUST_DETAIL]: { repo: error.repo, candidate: { ...card.candidate } },
              // Trusting the checkout again, by whichever card, settles every card that offers it.
              [CARD_RESOLVES_WHEN]: { event: 'checkout_trusted', repo: error.repo },
            },
          }
        : {}),
    });
  };
}

/**
 * Closes the open cards that offered to trust `repo` once it is trusted: the builder answered one of
 * them, and the others (an earlier move, a changed origin that was put back) describe a state that no
 * longer needs a decision.
 */
export function createCheckoutTrustedHandler(deps: {
  readonly db: DbReader;
  readonly inbox: Pick<InboxService, 'resolve'>;
}): (repo: string) => void {
  return (repo) => {
    resolveStaleCards(deps.db, deps.inbox, null, (when) =>
      when.event === 'checkout_trusted' && when.repo === repo ? `${repo} is trusted again` : null,
    );
  };
}

/**
 * The checkouts whose cards still offer to trust them, at startup: `Git` looks at each again on its
 * next call, so a card raised before a restart closes too once the builder put the checkout back.
 */
export function refusedTrustCheckouts(db: DbReader): string[] {
  const repos = new Set<string>();
  for (const { when } of cardsResolvedByEvent(db, null))
    if (when.event === 'checkout_trusted') repos.add(when.repo);
  return [...repos];
}

/**
 * Re-trusts a checkout when the builder answers its card so, pinning exactly the state the card
 * showed; nothing else ever re-trusts one. If the checkout changed again since, `retrust` refuses and
 * its refusal raises a new card.
 */
export function createGitCardAnswers(git: Pick<Git, 'retrust'>) {
  return async (item: InboxItemDto, answer: InboxAnswer): Promise<void> => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const card = GitTrustDetail.safeParse(item.detail?.[GIT_TRUST_DETAIL]);
    if (!card.success || answer.choice !== TRUST) return;
    await git.retrust(card.data.repo, card.data.candidate).catch((error: unknown) => {
      if (!(error instanceof GitTrustError)) throw error;
    });
  };
}
