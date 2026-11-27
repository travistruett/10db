import { HealthResponse, PROTOCOL_VERSION } from '@10db/contracts';
import { Box, Center, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { VersionMismatch } from '../shell/version-mismatch';
import { createDaemonClient, readJson, type DaemonClient } from './client';
import type { ConnectionResolver, DaemonConnection } from './connection';

/** How often a connected UI checks the daemon is still there. */
export const HEALTH_INTERVAL_MS = 5_000;
/** How often a disconnected UI asks where the daemon is and tries again. */
export const RECONNECT_INTERVAL_MS = 1_000;
/** How long a health check of a connected daemon may take before it counts as down; below the poll interval. */
export const HEALTH_TIMEOUT_MS = 2_000;
/**
 * How long a health check may take while looking for a daemon again. A daemon that has just started, or a Mac
 * under load, answers slowly, and a timeout that gives up on it keeps the window out for as long as it stays slow.
 */
export const RECONNECT_HEALTH_TIMEOUT_MS = 5_000;
/**
 * The longest one whole attempt (asking where the daemon is, then its health) may take. It bounds the attempt
 * itself rather than one request in it, so a lookup that never returns can't stop the next try from being made.
 */
export const ATTEMPT_DEADLINE_MS = RECONNECT_HEALTH_TIMEOUT_MS + 3_000;

export interface DaemonIntervals {
  readonly healthy: number;
  readonly disconnected: number;
  /** Overrides `ATTEMPT_DEADLINE_MS`. */
  readonly attemptDeadline?: number;
}

const DEFAULT_INTERVALS: DaemonIntervals = {
  healthy: HEALTH_INTERVAL_MS,
  disconnected: RECONNECT_INTERVAL_MS,
};

class AttemptTimeoutError extends Error {
  override readonly name = 'AttemptTimeoutError';
  constructor() {
    super('The daemon did not answer in time');
  }
}

/** `work`'s result, or an `AttemptTimeoutError` once `ms` pass; the work is left to finish unheard. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AttemptTimeoutError());
    }, ms);
    work.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type DaemonStatus =
  | { readonly kind: 'connecting'; readonly lastError: string | null }
  | {
      readonly kind: 'connected';
      readonly startedAt: string;
      readonly commit: string | null;
      /** The browser origin the daemon trusts as 10db's own dev UI; null when none. */
      readonly devUiOrigin: string | null;
    }
  | { readonly kind: 'reconnecting'; readonly since: number }
  | { readonly kind: 'mismatch'; readonly daemonVersion: number };

interface DaemonValue {
  readonly client: DaemonClient;
  readonly connection: DaemonConnection;
}

const DaemonContext = createContext<DaemonValue | null>(null);
const StatusContext = createContext<DaemonStatus>({ kind: 'connecting', lastError: null });

export interface DaemonProviderProps {
  readonly resolve: ConnectionResolver;
  readonly intervals?: DaemonIntervals;
  /** What the connecting screen adds once the first connection has failed for `CONNECTING_HELP_AFTER_MS`. */
  readonly connectingHelp?: ReactNode;
  readonly children: ReactNode;
}

function sameConnection(a: DaemonConnection, b: DaemonConnection): boolean {
  return a.url === b.url && a.token === b.token;
}

/** How long the first connection may fail before the connecting screen shows its help. */
const CONNECTING_HELP_AFTER_MS = 10_000;

function ConnectingScreen({
  lastError,
  help,
}: {
  readonly lastError: string | null;
  readonly help: ReactNode;
}) {
  const [helpDue, setHelpDue] = useState(false);
  useEffect(() => {
    if (help === undefined || help === null) return undefined;
    const timer = setTimeout(() => {
      setHelpDue(true);
    }, CONNECTING_HELP_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [help]);
  return (
    <Center h="100vh">
      <Stack align="center" gap="xs">
        <Loader size="sm" />
        <Text>Connecting to the 10db daemon…</Text>
        {lastError !== null && (
          // The reason is for the curious; what the builder needs is that it keeps trying.
          <Tooltip label={lastError} multiline maw={480}>
            {/* Focusable, so the reason is there for the keyboard and a screen reader as well. */}
            <Text size="sm" c="dimmed" maw={480} ta="center" tabIndex={0}>
              Still trying to reach the 10db daemon. It retries on its own.
            </Text>
          </Tooltip>
        )}
        {helpDue && lastError !== null ? (
          <Box maw={420} px="md" mt="sm">
            {help}
          </Box>
        ) : null}
      </Stack>
    </Center>
  );
}

/**
 * Finds the daemon, checks its health and protocol version, and keeps checking. The app renders
 * only after the first healthy answer; after that, an outage shows as `reconnecting` while the
 * views stay up. While disconnected it re-resolves the connection on every try, because a
 * restarted sidecar listens on a new port.
 */
export function DaemonProvider({
  resolve,
  intervals = DEFAULT_INTERVALS,
  connectingHelp,
  children,
}: DaemonProviderProps) {
  const [value, setValue] = useState<DaemonValue | null>(null);
  const [status, setStatus] = useState<DaemonStatus>({ kind: 'connecting', lastError: null });
  const { healthy: healthyMs, disconnected: disconnectedMs } = intervals;
  const deadlineMs = intervals.attemptDeadline ?? ATTEMPT_DEADLINE_MS;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: DaemonValue | null = null;
    let healthy = false;
    let everConnected = false;
    let downSince: number | null = null;
    let attempts = 0;
    let ticking = false;
    let tickAgain = false;

    /** Asks where the daemon is (when not connected) and for its health. */
    async function attempt(): Promise<HealthResponse & { readonly active: DaemonValue }> {
      const mine = ++attempts;
      const known = current;
      // Not connected: the address and token are read again, because a restarted daemon has new ones.
      const searching = !healthy || known === null;
      let active: DaemonValue;
      if (known === null || searching) {
        const connection = await resolve();
        active =
          known !== null && sameConnection(known.connection, connection)
            ? known
            : { connection, client: createDaemonClient(connection) };
        // An attempt that outlived its deadline must not put an older address over a newer one.
        if (mine === attempts) current = active;
      } else {
        active = known;
      }
      const health = await readJson(
        await active.client.health.$get(undefined, {
          init: {
            signal: AbortSignal.timeout(
              searching ? RECONNECT_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS,
            ),
          },
        }),
        HealthResponse,
      );
      return { ...health, active };
    }

    async function tick(): Promise<void> {
      // One attempt at a time: a wake during one runs the next as soon as it ends.
      if (ticking) {
        tickAgain = true;
        return;
      }
      ticking = true;
      clearTimeout(timer);
      try {
        const { active, ...health } = await withDeadline(attempt(), deadlineMs);
        if (stopped) return;
        healthy = true;
        everConnected = true;
        downSince = null;
        setValue(active);
        setStatus(
          health.protocolVersion === PROTOCOL_VERSION
            ? {
                kind: 'connected',
                startedAt: health.startedAt,
                commit: health.commit,
                devUiOrigin: health.devUiOrigin,
              }
            : { kind: 'mismatch', daemonVersion: health.protocolVersion },
        );
      } catch (error) {
        if (stopped) return;
        healthy = false;
        downSince ??= Date.now();
        setStatus(
          everConnected
            ? { kind: 'reconnecting', since: downSince }
            : {
                kind: 'connecting',
                lastError: error instanceof Error ? error.message : String(error),
              },
        );
      }
      // Both branches above return when the effect stopped during an await; nothing since can stop it.
      ticking = false;
      if (tickAgain) {
        tickAgain = false;
        void tick();
        return;
      }
      timer = setTimeout(
        () => {
          void tick();
        },
        healthy ? healthyMs : disconnectedMs,
      );
    }

    // A page coming back (a phone's screen on, the app brought forward, the network back) asks at once instead of
    // waiting on a timer the browser held while it was away, and a status shown as healthy is checked again.
    const wake = (): void => {
      if (document.visibilityState !== 'visible') return;
      void tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);

    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [resolve, healthyMs, disconnectedMs, deadlineMs]);

  if (status.kind === 'mismatch') {
    return (
      <StatusContext value={status}>
        <VersionMismatch daemonVersion={status.daemonVersion} />
      </StatusContext>
    );
  }
  if (value === null)
    return (
      <ConnectingScreen
        lastError={status.kind === 'connecting' ? status.lastError : null}
        help={connectingHelp}
      />
    );
  return (
    <StatusContext value={status}>
      <DaemonContext value={value}>{children}</DaemonContext>
    </StatusContext>
  );
}

/** The client for the connected daemon. Only valid below a connected `DaemonProvider`. */
export function useDaemon(): DaemonValue {
  const value = use(DaemonContext);
  if (!value) throw new Error('useDaemon must be used inside a connected DaemonProvider');
  return value;
}

export function useDaemonStatus(): DaemonStatus {
  return use(StatusContext);
}
