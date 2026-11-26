import { createHash } from 'node:crypto';
import {
  EventType,
  SHARE_PORT_DEFAULT,
  SharingState,
  SharingStep,
  SharingStepStatus,
  type PutSharingBody,
  type SharingStatusDto,
  DomainError,
} from '@10db/contracts';
import { getAppSetting, setAppSetting } from '@10db/db';
import { z } from 'zod';
import { Listener, type ListenerAllowlists } from '../listeners';
import type { Clock, Timer } from '../clock';
import type { SocketRegistry } from '../devices';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { ShareListener, ShareListenResult } from './share-listener';
import { createCertificateProbe, type CertificateProbe } from './certificate-probe';
import {
  ServeStatus,
  isTendbMapping,
  loopbackMappingOn,
  mappingProblem,
  serveArgs,
  shareRefusal,
  unserveArgs,
  type MappingProblem,
} from './serve-mapping';
import { readTailscaleSelf, type TailscaleRun, type TailscaleSelf } from './tailscale-cli';

export interface SharingService {
  /** The cache, at once; also starts a refresh (not awaited) when the last one is over 10 s old. */
  status(): SharingStatusDto;
  /** Share, Stop or change the port. Throws `SharingRefusedError`. */
  set(body: PutSharingBody): Promise<SharingStatusDto>;
  /** The builder's Get Certificate: runs the first probe for a name with no certificate. */
  requestCertificate(): Promise<SharingStatusDto>;
  /** For the share listener; null until sharing is Ready with a known name. */
  allowlists(): ListenerAllowlists | null;
  hostLogin(): string | null;
  /** At daemon start; never throws. */
  start(): Promise<void>;
  /** At shutdown: unshare, then close. */
  stop(): Promise<void>;
}

/** Share was refused; the message says why and is shown to the builder. */
/** A Share, Stop or certificate request 10db refuses; the API answers it as a 409 with its sentence. */
export class SharingRefusedError extends DomainError {
  override readonly name: string = 'SharingRefusedError';
  constructor(message: string) {
    super('conflict', message);
  }
}

class ServeUnreadableError extends Error {
  override readonly name = 'ServeUnreadableError';
}

const KEY_ENABLED = 'sharing.enabled';
const KEY_PORT = 'sharing.port';
const KEY_CERTIFICATE_FOR = 'sharing.certificateFor';

const MONITOR_MS = 60_000;
const STALE_MS = 10_000;
const SERVE_TIMEOUT_MS = 10_000;
const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;

const EnabledSetting = z.boolean();
const PortSetting = z.int().min(1024).max(65535);
const HashSetting = z.string();

/** Why the listener is down: `retry` may clear on its own, `blocked` needs the builder. */
type PauseKind = 'retry' | 'blocked';

function hashOf(fqdn: string): string {
  return createHash('sha256').update(fqdn).digest('hex');
}

function describeProblem(problem: MappingProblem, fqdn: string, port: number): string {
  switch (problem.kind) {
    case 'funnel':
      return `Tailscale Funnel is on for ${fqdn}:${String(port)}, which would put 10db on the public internet. Turn Funnel off first.`;
    case 'tcp':
      return `Port ${String(port)} already has a TCP forward in Tailscale serve. Pick another port or remove it.`;
    case 'elsewhere':
      return `Port ${String(port)} already maps to ${problem.target} in Tailscale serve. Pick another port or remove it.`;
  }
}

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
  let self: TailscaleSelf | null = null;
  let selfError: string | null = null;
  let serve: ServeStatus | null = null;
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
  let lastState: SharingState | null = null;
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

  function readEnabled(): boolean {
    const parsed = EnabledSetting.safeParse(getAppSetting(deps.state.db, KEY_ENABLED));
    return parsed.success && parsed.data;
  }
  function readPort(): number {
    const parsed = PortSetting.safeParse(getAppSetting(deps.state.db, KEY_PORT));
    return parsed.success ? parsed.data : SHARE_PORT_DEFAULT;
  }
  function readCertificateFor(): string | null {
    const parsed = HashSetting.safeParse(getAppSetting(deps.state.db, KEY_CERTIFICATE_FOR));
    return parsed.success ? parsed.data : null;
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

  function publish(force = false): void {
    const state = compute().state;
    if (!force && state === lastState) return;
    lastState = state;
    emitChanged(state);
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
    const cli = deps.cli();
    const enabled = readEnabled();
    const port = readPort();
    const fqdn = self?.fqdn ?? null;
    const requested = fqdn !== null && readCertificateFor() === hashOf(fqdn);
    const exists = certificateExists(fqdn);
    const mapped =
      listener !== null && serve !== null && fqdn !== null && isTendbMapping(serve, fqdn, port);
    const ok = (detail: string | null) =>
      ({ status: SharingStepStatus.Ok, detail, error: null }) as const;
    const failed = (detail: string | null, error: string) =>
      ({ status: SharingStepStatus.Failed, detail, error }) as const;
    const pending = { status: SharingStepStatus.Todo, detail: null, error: null } as const;

    const connected =
      self === null
        ? selfError === null
          ? pending
          : failed(null, selfError)
        : self.running && fqdn !== null
          ? ok(fqdn)
          : failed(null, 'Open Tailscale and connect');
    const connectedOk = self?.running === true && fqdn !== null;
    const untagged =
      !connectedOk || self === null
        ? pending
        : self.tags.length === 0
          ? ok(null)
          : failed(
              self.tags.join(', '),
              'A tagged Mac gets no identity headers. Untag it in the Tailscale admin console.',
            );
    const https =
      !connectedOk || self === null
        ? pending
        : self.certDomains.includes(fqdn)
          ? ok(fqdn)
          : failed(fqdn, 'Turn on HTTPS in the Tailscale admin console (DNS).');
    const certificate = !connectedOk
      ? pending
      : exists
        ? ok(fqdn)
        : ({
            status: SharingStepStatus.Waiting,
            detail: fqdn,
            error: requested ? (probe?.current().error ?? null) : null,
          } as const);
    const shared = mapped
      ? ok(fqdn)
      : enabled
        ? failed(null, pausedReason ?? 'Not shared yet')
        : pending;

    const steps =
      cli === null
        ? []
        : [
            { step: SharingStep.Installed, ...ok(cli) },
            { step: SharingStep.Connected, ...connected },
            { step: SharingStep.Untagged, ...untagged },
            { step: SharingStep.Https, ...https },
            { step: SharingStep.Certificate, ...certificate },
            { step: SharingStep.Shared, ...shared },
          ];
    const prerequisitesOk =
      cli !== null && steps.slice(0, 5).every((step) => step.status === SharingStepStatus.Ok);
    const allOk = prerequisitesOk && mapped;
    const state = enabled
      ? allOk
        ? SharingState.Ready
        : SharingState.Paused
      : prerequisitesOk
        ? SharingState.Off
        : SharingState.SettingUp;
    return {
      state,
      enabled,
      port,
      fqdn,
      login: self?.login ?? null,
      certificateRequested: requested,
      certificateExists: exists,
      url: state === SharingState.Ready && fqdn !== null ? `https://${fqdn}:${String(port)}` : null,
      portHolder,
      steps,
    };
  }

  async function readServe(cli: string): Promise<ServeStatus> {
    const result = await deps.run(cli)(['serve', 'status', '--json'], SERVE_TIMEOUT_MS);
    if (result.timedOut || result.code !== 0) {
      throw new ServeUnreadableError('tailscale serve status failed');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new ServeUnreadableError('tailscale serve status output is not JSON');
    }
    const parsed = ServeStatus.safeParse(raw);
    if (!parsed.success) throw new ServeUnreadableError('tailscale serve status is malformed');
    serve = parsed.data;
    return parsed.data;
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
    if (fqdn !== null && readCertificateFor() === hashOf(fqdn)) {
      const current = currentProbe();
      if (current !== null) {
        probeName = fqdn;
        await current.tick(fqdn);
      }
    }
    refreshedAt = deps.clock.now().getTime();
  }

  /** Removes 10db's own mapping, and only that. Never throws. */
  async function removeOwnMapping(port: number): Promise<void> {
    const cli = deps.cli();
    if (cli === null) return;
    try {
      const status = await readServe(cli);
      const fqdn = self?.fqdn ?? null;
      const own =
        fqdn !== null ? isTendbMapping(status, fqdn, port) : loopbackMappingOn(status, port);
      if (!own) return;
      const result = await deps.run(cli)(unserveArgs(port), SERVE_TIMEOUT_MS);
      if (result.code !== 0 || result.timedOut) {
        deps.log.warn(
          { timedOut: result.timedOut, stderr: result.stderr.slice(-300) },
          'sharing: could not remove the mapping',
        );
      } else {
        serve = await readServe(cli).catch(() => null);
      }
    } catch (error) {
      deps.log.warn(
        { error: String(error) },
        'sharing: could not read serve to remove the mapping',
      );
    }
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
  async function unshare(port: number): Promise<void> {
    await removeOwnMapping(port);
    await closeListener();
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
          if (!closed && readEnabled()) scheduleMonitor();
        });
    }, MONITOR_MS);
  }

  function pause(reason: string, kind: PauseKind): void {
    pausedReason = reason;
    pauseKind = kind;
  }

  /** The start sequence: check the mapping, listen, restore it. Never throws. */
  async function startSharing(): Promise<void> {
    const port = readPort();
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
        await removeOwnMapping(port);
        return;
      }
      const status = await readServe(cli);
      const problem = mappingProblem(status, fqdn, port);
      if (problem !== null) {
        pause(describeProblem(problem, fqdn, port), 'blocked');
        return;
      }
      if (!certificateExists(fqdn)) {
        pause('Waiting for the certificate of this Mac’s tailnet name', 'retry');
        return;
      }
      const opened = await deps.listen(port);
      if (!opened.ok) {
        portHolder = opened.holder ?? 'another process';
        pause(`Port ${String(port)} is held by ${portHolder}`, 'blocked');
        await removeOwnMapping(port);
        return;
      }
      listener = opened.listener;
      listenerFqdn = fqdn;
      portHolder = null;
      if (!isTendbMapping(status, fqdn, port)) {
        const result = await deps.run(cli)(serveArgs(port), SERVE_TIMEOUT_MS);
        if (result.code !== 0 || result.timedOut) {
          pause(result.timedOut ? 'tailscale serve timed out' : result.stderr.slice(-300), 'retry');
          return;
        }
        await readServe(cli);
      }
      pausedReason = null;
    } catch (error) {
      deps.log.warn({ error: String(error) }, 'sharing: could not start sharing');
      pause(error instanceof Error ? error.message : 'Sharing could not start', 'retry');
    }
  }

  async function monitorTick(): Promise<void> {
    if (closed || !readEnabled()) return;
    const port = readPort();
    await refresh();
    if (listener === null) {
      if (pauseKind === 'retry') await startSharing();
      else await removeOwnMapping(port);
      publish();
      return;
    }
    const fqdn = self?.fqdn ?? null;
    if (fqdn !== null && listenerFqdn !== null && fqdn !== listenerFqdn) {
      deps.sockets.closeListener(Listener.Share);
      listenerFqdn = fqdn;
    }
    const cli = deps.cli();
    if (cli === null) return;
    let status: ServeStatus;
    try {
      status = await readServe(cli);
    } catch (error) {
      deps.log.warn({ error: String(error) }, 'sharing: monitor could not read serve');
      publish();
      return;
    }
    const problem = mappingProblem(status, fqdn ?? listenerFqdn ?? '', port);
    if (problem !== null) {
      await closeListener();
      pause(describeProblem(problem, fqdn ?? '', port), 'blocked');
    }
    publish();
  }

  async function stopSharing(port: number): Promise<void> {
    stopMonitor();
    await unshare(port);
    deps.state.write((ctx) => {
      setAppSetting(ctx, KEY_ENABLED, false);
    });
    pausedReason = null;
    portHolder = null;
  }

  async function share(port: number): Promise<void> {
    await refresh();
    const cli = deps.cli();
    if (cli === null) throw new SharingRefusedError('Tailscale is not installed');
    const failing = compute().steps.find(
      (step, index) => index < 5 && step.status !== SharingStepStatus.Ok,
    );
    if (failing !== undefined) {
      throw new SharingRefusedError(
        failing.error ?? `Finish the ${failing.step} step before sharing`,
      );
    }
    const fqdn = self?.fqdn;
    if (fqdn === null || fqdn === undefined) {
      throw new SharingRefusedError('Tailscale is not connected');
    }
    const status = await readServe(cli).catch((error: unknown) => {
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
      const result = await deps.run(cli)(serveArgs(port), SERVE_TIMEOUT_MS);
      if (result.code !== 0 || result.timedOut) {
        await unshare(port);
        throw new SharingRefusedError(
          result.timedOut ? 'tailscale serve timed out' : result.stderr.slice(-300),
        );
      }
      deps.state.write((ctx) => {
        setAppSetting(ctx, KEY_ENABLED, true);
        setAppSetting(ctx, KEY_PORT, port);
      });
    } catch (error) {
      await closeListener();
      throw error;
    }
    await readServe(cli).catch(() => null);
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
          await stopSharing(readPort());
          publish(true);
          return compute();
        }
        const port = body.port ?? readPort();
        const refusal = shareRefusal(port, deps.mainPort());
        if (refusal !== null) throw new SharingRefusedError(refusal);
        if (readEnabled() && port === readPort() && listener !== null) return compute();
        if (readEnabled() || listener !== null) await stopSharing(readPort());
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
        deps.state.write((ctx) => {
          setAppSetting(ctx, KEY_CERTIFICATE_FOR, hashOf(fqdn));
        });
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
      const host = `${fqdn}:${String(readPort())}`;
      return { hosts: [host], origins: [`https://${host}`, ...TAURI_ORIGINS] };
    },
    hostLogin: () => self?.login ?? null,
    start() {
      return enqueue(async () => {
        if (!readEnabled()) return;
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
        await unshare(readPort());
      }).catch((error: unknown) => {
        deps.log.warn({ error: String(error) }, 'sharing: stop failed');
      });
    },
  };
}
