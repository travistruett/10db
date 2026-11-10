import { PassNoticeKind, PassState, type PassId } from '@10db/contracts';
import { clearPassNotice, findPass, setPassNotice } from '@10db/db';
import type { DeliveryContext } from './context';
import { reviewPassTip, type PassReviewDeps } from './pass-review';

// Workbench spec §8.3, D21: once Open Pull Request has pushed, the pass's gate and its one review
// read the pushed commit, outside the delivery key, so a sign-off waits for neither. Each pass's
// checks have their own abort, which the close and Abandon raise before they go on.

/** The gate of one pushed tip, as `PassShipDeps.gatePassTip` runs it. */
export type GateTip = (input: {
  readonly passId: PassId;
  readonly sha: string;
  readonly signal: AbortSignal;
}) => Promise<unknown>;

export interface PassChecksDeps extends Pick<
  DeliveryContext,
  'state' | 'git' | 'logger' | 'clock'
> {
  /** The gate in a scratch worktree, which records its own result; absent, no gate runs. */
  readonly gate: GateTip | null;
  /** The one review's model; absent, no review runs. */
  readonly review: PassReviewDeps | null;
}

export interface PassChecks {
  /**
   * Starts the gate and the review of pushed tip `sha` (each when asked), beside each other under one
   * abort. Checks still running for the pass are stopped first, so one tip is checked at a time.
   */
  start(input: {
    readonly passId: PassId;
    readonly sha: string;
    readonly gate: boolean;
    readonly review: boolean;
    /** The branch the pull request targets on `origin`, where the review's diff starts. */
    readonly baseRef: string | null;
  }): void;
  /** Raises the abort of the pass's running checks and waits for them to end. */
  stop(passId: PassId): Promise<void>;
  /** Stops every pass's checks, as the daemon shuts down. */
  stopAll(): Promise<void>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The header notices that say the gate or the one review could not run. */
const GATE_NOTICE = 'gate';
const REVIEW_NOTICE = 'review';

export function createPassChecks(deps: PassChecksDeps): PassChecks {
  /** Puts a notice the builder reads, but cannot send, in the pass's header. */
  function tell(
    passId: PassId,
    notice: { readonly id: string; readonly kind: PassNoticeKind; readonly text: string },
  ): void {
    deps.state.write((w) => {
      setPassNotice(w, passId, { ...notice, sendable: false, cardId: null, at: w.now });
    });
  }

  const running = new Map<
    PassId,
    { readonly abort: AbortController; readonly done: Promise<void> }
  >();

  async function stop(passId: PassId): Promise<void> {
    const live = running.get(passId);
    if (!live) return;
    live.abort.abort();
    await live.done;
  }

  async function run(
    input: Parameters<PassChecks['start']>[0],
    signal: AbortSignal,
  ): Promise<void> {
    const gate = deps.gate;
    const review = deps.review;
    await Promise.all([
      input.gate && gate
        ? gate({ passId: input.passId, sha: input.sha, signal }).catch((error: unknown) => {
            deps.logger.warn(
              { passId: input.passId, sha: input.sha, err: message(error) },
              'pass gate not run',
            );
            if (!signal.aborted)
              tell(input.passId, {
                id: GATE_NOTICE,
                kind: PassNoticeKind.GateFailed,
                text: `The gate on ${input.sha.slice(0, 7)} could not run: ${message(error)}`,
              });
          })
        : null,
      input.review && review
        ? reviewPassTip(
            { ...deps, ...review },
            { passId: input.passId, sha: input.sha, baseRef: input.baseRef, signal },
          ).then(
            () => {
              deps.state.write((w) => clearPassNotice(w, input.passId, REVIEW_NOTICE));
            },
            (error: unknown) => {
              deps.logger.warn(
                { passId: input.passId, sha: input.sha, err: message(error) },
                'pass pull request not reviewed',
              );
              if (!signal.aborted)
                tell(input.passId, {
                  id: REVIEW_NOTICE,
                  kind: PassNoticeKind.ReviewFailed,
                  text: `The review of ${input.sha.slice(0, 7)} could not run: ${message(error)}. The next Open Pull Request asks again.`,
                });
            },
          )
        : null,
    ]);
  }

  return {
    start(input) {
      const before = running.get(input.passId);
      const abort = new AbortController();
      const done = (async () => {
        if (before) {
          before.abort.abort();
          await before.done;
        }
        // Checks of a pass no longer open (closed or abandoned while they waited) never start.
        const open = findPass(deps.state.db, input.passId)?.state === PassState.Open;
        if (!abort.signal.aborted && open) await run(input, abort.signal);
      })().finally(() => {
        if (running.get(input.passId)?.abort === abort) running.delete(input.passId);
      });
      running.set(input.passId, { abort, done });
    },
    stop,
    async stopAll() {
      await Promise.all([...running.keys()].map(stop));
    },
  };
}
