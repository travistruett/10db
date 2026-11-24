import type { ProjectId } from '@10db/contracts';
import type { Clock } from '../clock';
import { clearGateHoldCard, raiseGateHoldCard, type InboxService } from '../inbox';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { gateHoldReason, type GateRequest, type GateResult, type GateRunner } from '../verify';

/** How long a held gate waits between tries. */
export const GATE_HOLD_RETRY_MS = 60_000;

export interface GateHoldDeps {
  readonly clock: Clock;
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly logger: Logger;
  /** How long a held gate waits before it runs again. */
  readonly retryMs: number;
}

/** Waits `ms` on the clock; false when `signal` aborted first. */
function pause(clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      timer.cancel();
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Holds a project's gate that failed for its environment (`gateHoldReason`) instead of failing the
 * task: one Inbox card says what to start, and the gate runs again every `retryMs` until it gets past
 * that check, then returns its real result. The retry is the precondition check, since the gate
 * prints its failing precondition first and fails fast. Wrap the limited runner, so a held gate keeps
 * no slot between tries. A gate that names no project is left alone.
 */
export function holdStaleGates(inner: GateRunner, deps: GateHoldDeps): GateRunner {
  /** Held gates per project; the card closes when the last one is released. */
  const held = new Map<ProjectId, number>();

  function release(projectId: ProjectId): void {
    const left = (held.get(projectId) ?? 1) - 1;
    if (left > 0) {
      held.set(projectId, left);
      return;
    }
    held.delete(projectId);
    clearGateHoldCard(deps, projectId);
  }

  return {
    async run(request: GateRequest): Promise<GateResult> {
      let result = await inner.run(request);
      const project = request.project;
      let reason = project.id === undefined ? null : gateHoldReason(result);
      if (project.id === undefined || reason === null) return result;
      const projectId = project.id;
      held.set(projectId, (held.get(projectId) ?? 0) + 1);
      try {
        raiseGateHoldCard(deps, { projectId, reason });
        deps.logger.info({ projectId, reason }, 'a gate is held until its environment is ready');
        while (reason !== null) {
          if (!(await pause(deps.clock, deps.retryMs, request.signal))) return result;
          result = await inner.run(request);
          reason = gateHoldReason(result);
        }
        return result;
      } finally {
        release(projectId);
      }
    },
  };
}
