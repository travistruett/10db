import type { PassTurnId, TaskId } from '@10db/contracts';

// Workbench spec §8.1: the changed-files check after a page's turn is coalesced per pass. A pass has
// at most one check running and one waiting; a turn that ends while one waits joins it, since the
// check reads the folder as it is and the latest run covers every turn before it. Pure: the service
// (`turn-checks.ts`) keeps one state per pass and carries out the effects.

/** A page's turn that ended Ready and asks for a check. */
export interface TurnAsk {
  readonly taskId: TaskId;
  readonly turnId: PassTurnId;
}

/** `run` numbers the pass's runs, so the end of a stopped run is told from the end of a later one. */
export type CheckQueueState =
  | { readonly kind: 'idle'; readonly run: number }
  | {
      readonly kind: 'running';
      readonly run: number;
      /** The turns the running check covers: every turn that ended since the last run started. */
      readonly turns: readonly TurnAsk[];
      /** The turns that ended while it runs, one check's worth; null when none waits. */
      readonly waiting: readonly TurnAsk[] | null;
    };

export type CheckQueueEvent =
  /** A page's turn ended Ready; `checks` says whether the project has a changed-files check. */
  | { readonly kind: 'ready'; readonly turn: TurnAsk; readonly checks: boolean }
  /** Run `run` ended, however it went: passed, failed, could not start, threw or was stopped. */
  | { readonly kind: 'ended'; readonly run: number }
  /** The pass left OPEN, its close or Abandon stopped its checks, or the daemon is stopping. */
  | { readonly kind: 'stop' };

export type CheckQueueEffect =
  | { readonly kind: 'start'; readonly run: number; readonly turns: readonly TurnAsk[] }
  | { readonly kind: 'abort'; readonly run: number };

export interface CheckStep {
  readonly state: CheckQueueState;
  readonly effects: readonly CheckQueueEffect[];
}

/** A pass no check has run for. */
export const CHECK_IDLE: CheckQueueState = { kind: 'idle', run: 0 };

const starting = (run: number, turns: readonly TurnAsk[]): CheckStep => ({
  state: { kind: 'running', run, turns, waiting: null },
  effects: [{ kind: 'start', run, turns }],
});

/** The pass's next state, and what to start or abort, after `event`. */
export function step(state: CheckQueueState, event: CheckQueueEvent): CheckStep {
  const still: CheckStep = { state, effects: [] };
  switch (event.kind) {
    case 'ready': {
      if (!event.checks) return still;
      if (state.kind === 'idle') return starting(state.run + 1, [event.turn]);
      const waiting = state.waiting ?? [];
      if (waiting.some((t) => t.turnId === event.turn.turnId)) return still;
      return { state: { ...state, waiting: [...waiting, event.turn] }, effects: [] };
    }
    case 'ended':
      if (state.kind === 'idle' || state.run !== event.run) return still;
      if (state.waiting === null) return { state: { kind: 'idle', run: state.run }, effects: [] };
      return starting(state.run + 1, state.waiting);
    case 'stop':
      if (state.kind === 'idle') return still;
      return {
        state: { kind: 'idle', run: state.run },
        effects: [{ kind: 'abort', run: state.run }],
      };
  }
}
