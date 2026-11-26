import { EventType, SharingState, SharingStepStatus, type SharingStatusDto } from '@10db/contracts';
import { Listener } from '../listeners';
import type { Clock, Timer } from '../clock';
import type { SocketRegistry } from '../devices';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { ShareListener, ShareListenResult } from './share-listener';
import { createCertificateProbe, type CertificateProbe } from './certificate-probe';
import { createServeControl } from './serve-control';
import {
  describeProblem,
  isTendbMapping,
  mappingProblem,
  shareRefusal,
  type ServeStatus,
} from './serve-mapping';
import { SharingRefusedError, type SharingService } from './sharing-service-api';
import { createSharingSettings } from './sharing-settings';
import { computeSharingStatus } from './sharing-status';
import { readTailscaleSelf, type TailscaleRun, type TailscaleSelf } from './tailscale-cli';

export { SharingRefusedError, type SharingService };

const MONITOR_MS = 60_000;
const STALE_MS = 10_000;
const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;

/** Why the listener is down: `retry` may clear on its own, `blocked` needs the builder. */
type PauseKind = 'retry' | 'blocked';

export function createSharingService(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly log: Logger;
  readonly cli: () => string | null;
  readonly run: (cli: string) => TailscaleRun;
  readonly listen: (port: number) => Promise<ShareListenResult>;
  readonly sockets: SocketRegistry;
  readonly mainPort: () => number;
}): SharingService {
  const settings = createSharingSettings(deps.state);
  let self: TailscaleSelf | null = null;
  let selfError: string | null = null;
  const serveControl = createServeControl({
    cli: deps.cli,
    run: deps.run,
    log: deps.log,
    fqdn: () => self?.fqdn ?? null,
  });
  let probe: CertificateProbe | null = null;
  let probeName: string | null = null;
  let listener: ShareListener | null = null;
  let listenerFqdn: string | null = null;
  let portHolder: string | null = null;
  let pausedReason: string | null = null;
  let pauseKind: PauseKind = 'retry';
  let refreshedAt = 0;
  let refreshQueued = false;
  let monitor: Timer | null = null;
  let closed = false;
  /** The status last published, as JSON: `publish` emits only when the status the UI reads has changed. */
  let lastView: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  /** set, requestCertificate, start, stop and the monitor's ticks run one at a time. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function emitChanged(state: SharingState): void {
    deps.state.write((ctx) => {
      ctx.emit({
        type: EventType.SharingChanged,
        entityType: 'sharing',
        entityId: 'this_mac',
        data: { state },
      });
    });
  }

  /**
   * Emits `sharing.changed` when the status the UI reads has changed since the last emit, not only the state
   * label: a Paused status can change under the same label, when the CLI goes and its steps empty, or when the
   * failing step does. The rail names that step.
   */
  function publish(force = false): void {
    const status = compute();
    const view = JSON.stringify(status);
    if (!force && view === lastView) return;
    lastView = view;
    emitChanged(status.state);
  }

  function currentProbe(): CertificateProbe | null {
    const cli = deps.cli();
    if (cli === null) return null;
    probe ??= createCertificateProbe({ run: deps.run(cli), clock: deps.clock });
    return probe;
  }

  function certificateExists(fqdn: string | null): boolean {
    return fqdn !== null && probeName === fqdn && (probe?.current().issued ?? false);
  }

  function compute(): SharingStatusDto {
    const fqdn = self?.fqdn ?? null;
    return computeSharingStatus({
      cli: deps.cli(),
      enabled: settings.enabled(),
      port: settings.port(),
      self,
      selfError,
      listening: listener !== null,
      serve: serveControl.current(),
      certificateRequested: fqdn !== null && settings.certificateRequestedFor(fqdn),
      certificateExists: certificateExists(fqdn),
      certificateError: probe?.current().error ?? null,
      pausedReason,
      portHolder,
    });
  }

  async function refresh(): Promise<void> {
    const cli = deps.cli();
    if (cli === null) return;
    const before = self?.fqdn ?? null;
    try {
      self = await readTailscaleSelf(deps.run(cli));
      selfError = null;
    } catch (error) {
      self = null;
      selfError = error instanceof Error ? error.message : 'Tailscale could not be read';
      deps.log.warn({ error: selfError }, 'sharing: tailscale status unreadable');
    }
    const fqdn = self?.fqdn ?? null;
    if (before !== null && fqdn !== null && before !== fqdn) {
      probe = null;
      probeName = null;
    }
    if (fqdn !== null && settings.certificateRequestedFor(fqdn)) {
      const current = currentProbe();
      if (current !== null) {
        probeName = fqdn;
        await current.tick(fqdn);
      }
    }
    refreshedAt = deps.clock.now().getTime();
  }

  /** Retries a removal an earlier Stop could not finish, enabled or not. */
  async function settleOwed(): Promise<void> {
    const owed = settings.unserveOwed();
    if (owed.length === 0) return;
    const left: number[] = [];
    for (const port of owed) {
      if (!(await serveControl.removeOwnMapping(port))) left.push(port);
    }
    if (left.length !== owed.length) settings.writeUnserveOwed(left);
  }

  async function closeListener(): Promise<void> {
    deps.sockets.closeListener(Listener.Share);
    const open = listener;
    listener = null;
    listenerFqdn = null;
    if (open === null) return;
    try {
      await open.close();
    } catch (error) {
      deps.log.warn({ error: String(error) }, 'sharing: the share listener did not close cleanly');
    }
  }

  /** Unserve first, then the sockets, then the listener, so a later process on the port gets no traffic. */
  async function unshare(port: number): Promise<boolean> {
    const settled = await serveControl.removeOwnMapping(port);
    await closeListener();
    return settled;
  }

  function stopMonitor(): void {
    monitor?.cancel();
    monitor = null;
  }

  function scheduleMonitor(): void {
    if (closed || monitor !== null) return;
    monitor = deps.clock.setTimeout(() => {
      monitor = null;
      enqueue(monitorTick)
        .catch((error: unknown) => {
          deps.log.warn({ error: String(error) }, 'sharing: monitor tick failed');
        })
        .finally(() => {
          if (!closed && (settings.enabled() || settings.unserveOwed().length > 0))
            scheduleMonitor();
        });
    }, MONITOR_MS);
  }

  function pause(reason: string, kind: PauseKind): void {
    pausedReason = reason;
    pauseKind = kind;
  }

  /** The start sequence: check the mapping, listen, restore it. Never throws. */
  async function startSharing(): Promise<void> {
    const port = settings.port();
    try {
      await refresh();
      const cli = deps.cli();
      const fqdn = self?.fqdn ?? null;
      if (cli === null) {
        pause('Tailscale is not installed', 'retry');
        return;
      }
      if (fqdn === null) {
        pause(selfError ?? 'Tailscale is not connected', 'retry');
        await serveControl.removeOwnMapping(port);
        return;
      }
      const status = await serveControl.read(cli);
      const problem = mappingProblem(status, fqdn, port);
      if (problem !== null) {
        pause(describeProblem(problem, fqdn, port), 'blocked');
        return;
      }
      if (!certificateExists(fqdn)) {
        pause('Waiting for the certificate of this Mac’s tailnet name', 'retry');
        await serveControl.removeOwnMapping(port);
        return;
      }
      const opened = await deps.listen(port);
      if (!opened.ok) {
        portHolder = opened.holder ?? 'another process';
        pause(`Port ${String(port)} is held by ${portHolder}`, 'blocked');
        await serveControl.removeOwnMapping(port);
        return;
      }
      listener = opened.listener;
      listenerFqdn = fqdn;
      portHolder = null;
      if (!isTendbMapping(status, fqdn, port)) {
        const failure = await serveControl.applyMapping(cli, port);
        if (failure !== null) {
          pause(failure, 'retry');
          return;
        }
        await serveControl.read(cli);
      }
      pausedReason = null;
    } catch (error) {
      deps.log.warn({ error: String(error) }, 'sharing: could not start sharing');
      pause(error instanceof Error ? error.message : 'Sharing could not start', 'retry');
    }
  }

  /** The step that stops Share before the listener and mapping: Installed through Certificate. */
  function failingPrerequisite(): { step: string; error: string | null } | undefined {
    return compute().steps.find((step, index) => index < 5 && step.status !== SharingStepStatus.Ok);
  }

  async function monitorTick(): Promise<void> {
    if (closed) return;
    await settleOwed();
    if (!settings.enabled()) return;
    const port = settings.port();
    await refresh();
    if (listener === null) {
      if (pauseKind === 'retry') await startSharing();
      else await serveControl.removeOwnMapping(port);
      publish();
      return;
    }
    const fqdn = self?.fqdn ?? null;
    if (fqdn !== null && listenerFqdn !== null && fqdn !== listenerFqdn) {
      deps.sockets.closeListener(Listener.Share);
      listenerFqdn = fqdn;
    }
    const cli = deps.cli();
    if (cli === null) {
      // Nothing more can be read without the CLI; publish, since the steps it reports are gone.
      publish();
      return;
    }
    let status: ServeStatus;
    try {
      status = await serveControl.read(cli);
    } catch (error) {
      deps.log.warn({ error: String(error) }, 'sharing: monitor could not read serve');
      publish();
      return;
    }
    const problem = mappingProblem(status, fqdn ?? listenerFqdn ?? '', port);
    if (problem !== null) {
      await closeListener();
      pause(describeProblem(problem, fqdn ?? '', port), 'blocked');
    } else if (
      fqdn !== null &&
      !isTendbMapping(status, fqdn, port) &&
      failingPrerequisite() === undefined
    ) {
      const failure = await serveControl.applyMapping(cli, port);
      if (failure !== null) pause(failure, 'retry');
      else pausedReason = null;
      await serveControl.read(cli).catch(() => null);
    }
    publish();
  }

  /**
   * True when this daemon holds no share: no listener and not enabled. Stop then unserves nothing and owes nothing,
   * since the port's mapping may be another daemon's; an unserve owed by an earlier Stop is retried by the monitor.
   */
  function notSharing(): boolean {
    return listener === null && !settings.enabled();
  }

  async function stopSharing(port: number): Promise<void> {
    stopMonitor();
    const settled = notSharing() || (await unshare(port));
    settings.setEnabled(false);
    if (!settled) settings.writeUnserveOwed([...new Set([...settings.unserveOwed(), port])]);
    pausedReason = null;
    portHolder = null;
    // stopMonitor above cancelled any pending run, so schedule one again while an unserve is owed.
    if (settings.unserveOwed().length > 0) scheduleMonitor();
  }

  async function share(port: number): Promise<void> {
    await refresh();
    await settleOwed();
    const cli = deps.cli();
    if (cli === null) throw new SharingRefusedError('Tailscale is not installed');
    const failing = failingPrerequisite();
    if (failing !== undefined) {
      throw new SharingRefusedError(
        failing.error ?? `Finish the ${failing.step} step before sharing`,
      );
    }
    const fqdn = self?.fqdn;
    if (fqdn === null || fqdn === undefined) {
      throw new SharingRefusedError('Tailscale is not connected');
    }
    const status = await serveControl.read(cli).catch((error: unknown) => {
      throw new SharingRefusedError(error instanceof Error ? error.message : 'Serve unreadable');
    });
    const problem = mappingProblem(status, fqdn, port);
    if (problem !== null) throw new SharingRefusedError(describeProblem(problem, fqdn, port));
    const opened = await deps.listen(port);
    if (!opened.ok) {
      portHolder = opened.holder ?? 'another process';
      throw new SharingRefusedError(`Port ${String(port)} is held by ${portHolder}`);
    }
    listener = opened.listener;
    listenerFqdn = fqdn;
    portHolder = null;
    try {
      const failure = await serveControl.applyMapping(cli, port);
      if (failure !== null) {
        await unshare(port);
        throw new SharingRefusedError(failure);
      }
      settings.enable(port);
      settings.writeUnserveOwed(settings.unserveOwed().filter((owed) => owed !== port));
    } catch (error) {
      await closeListener();
      throw error;
    }
    await serveControl.read(cli).catch(() => null);
    pausedReason = null;
    pauseKind = 'retry';
    scheduleMonitor();
  }

  return {
    status() {
      if (
        !refreshQueued &&
        deps.cli() !== null &&
        deps.clock.now().getTime() - refreshedAt > STALE_MS
      ) {
        refreshQueued = true;
        void enqueue(refresh)
          .catch((error: unknown) => {
            deps.log.warn({ error: String(error) }, 'sharing: refresh failed');
          })
          .finally(() => {
            refreshQueued = false;
            publish();
          });
      }
      return compute();
    },
    set(body) {
      return enqueue(async () => {
        if (!body.enabled) {
          await stopSharing(settings.port());
          publish(true);
          return compute();
        }
        const port = body.port ?? settings.port();
        const refusal = shareRefusal(port, deps.mainPort());
        if (refusal !== null) throw new SharingRefusedError(refusal);
        if (settings.enabled() && port === settings.port()) {
          // Share on a shared port restores what is missing; it never clears `enabled`.
          if (listener !== null) await monitorTick();
          else await startSharing();
          scheduleMonitor();
          publish(true);
          if (compute().state !== SharingState.Ready && pausedReason !== null) {
            throw new SharingRefusedError(pausedReason);
          }
          return compute();
        }
        if (settings.enabled() || listener !== null) await stopSharing(settings.port());
        try {
          await share(port);
        } catch (error) {
          publish(true);
          throw error;
        }
        publish(true);
        return compute();
      });
    },
    requestCertificate() {
      return enqueue(async () => {
        await refresh();
        const fqdn = self?.fqdn ?? null;
        if (fqdn === null) throw new SharingRefusedError('Tailscale is not connected');
        settings.requestCertificateFor(fqdn);
        probe = null;
        const current = currentProbe();
        if (current !== null) {
          probeName = fqdn;
          await current.tick(fqdn);
        }
        publish();
        return compute();
      });
    },
    allowlists() {
      const fqdn = self?.fqdn ?? null;
      if (listener === null || fqdn === null || compute().state !== SharingState.Ready) return null;
      const host = `${fqdn}:${String(settings.port())}`;
      return { hosts: [host], origins: [`https://${host}`, ...TAURI_ORIGINS] };
    },
    hostLogin: () => self?.login ?? null,
    start() {
      return enqueue(async () => {
        await settleOwed();
        if (settings.unserveOwed().length > 0) scheduleMonitor();
        if (!settings.enabled()) return;
        await startSharing();
        scheduleMonitor();
        publish();
      }).catch((error: unknown) => {
        deps.log.warn({ error: String(error) }, 'sharing: start failed');
      });
    },
    stop() {
      return enqueue(async () => {
        closed = true;
        stopMonitor();
        await settleOwed();
        if (notSharing()) return;
        const port = settings.port();
        if (!(await unshare(port)))
          settings.writeUnserveOwed([...new Set([...settings.unserveOwed(), port])]);
      }).catch((error: unknown) => {
        deps.log.warn({ error: String(error) }, 'sharing: stop failed');
      });
    },
  };
}
