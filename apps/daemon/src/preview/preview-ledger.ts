import {
  createLaneProcessWatch,
  createProcessLedger,
  LaneProcessFailure,
  removeProcessLedger,
  type LaneProcessSetup,
  type LedgerSweep,
} from '../sandbox';

/** Where a preview's processes are remembered, as the pictures browser's are. */
export interface PreviewLedgers {
  /** The files root the lane ledgers live in, which no lane command reads or writes. */
  readonly root: string;
  readonly sweep: LedgerSweep;
  readonly processes: LaneProcessSetup;
}

/**
 * Remembers a running preview's processes in a ledger: the sweep spares it while the preview runs,
 * and a daemon that dies leaves it for the next start to reap.
 */
export interface PreviewLedger {
  /** Watches the preview's process group from its leader. */
  track(pid: number): Promise<void>;
  /** Stops whatever of the preview still runs and lets the ledger go. */
  end(): Promise<void>;
}

/** Creates the ledger and holds it in the sweep at once, before the preview starts. */
export function openPreviewLedger(
  deps: PreviewLedgers,
  onError: (failure: LaneProcessFailure, error: unknown) => void,
): PreviewLedger {
  const file = createProcessLedger(deps.root, deps.processes.ownPid ?? process.pid);
  deps.sweep.hold(file);
  const watch = createLaneProcessWatch({ ...deps.processes, ledger: file, onError });
  let ended = false;
  return {
    async track(pid) {
      // With no start time the watch reads the process itself.
      await watch.track({ pid, startedAt: null });
    },
    async end() {
      if (ended) return;
      ended = true;
      try {
        await watch.end();
      } catch (error) {
        onError(LaneProcessFailure.Table, error);
      }
      // What could not be stopped stays named: the sweep tries again, and the next start if it never can.
      const kept = watch.pending();
      deps.sweep.release(file);
      if (kept) deps.sweep.later();
      else removeProcessLedger(file, deps.root);
    },
  };
}
