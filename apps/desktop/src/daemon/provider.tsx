import { HealthResponse, PROTOCOL_VERSION } from '@10db/contracts';
import { Center, Loader, Stack, Text } from '@mantine/core';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { VersionMismatch } from '../shell/version-mismatch';
import { createDaemonClient, readJson, type DaemonClient } from './client';
import type { ConnectionResolver, DaemonConnection } from './connection';

/** How often a connected UI checks the daemon is still there. */
export const HEALTH_INTERVAL_MS = 5_000;
/** How often a disconnected UI asks where the daemon is and tries again. */
export const RECONNECT_INTERVAL_MS = 1_000;
/** How long a health check may take before the daemon counts as down; below the poll interval. */
export const HEALTH_TIMEOUT_MS = 2_000;

export interface DaemonIntervals {
  readonly healthy: number;
  readonly disconnected: number;
}

const DEFAULT_INTERVALS: DaemonIntervals = {
  healthy: HEALTH_INTERVAL_MS,
  disconnected: RECONNECT_INTERVAL_MS,
};

export type DaemonStatus =
  | { readonly kind: 'connecting'; readonly lastError: string | null }
  | { readonly kind: 'connected'; readonly startedAt: string }
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
  readonly children: ReactNode;
}

function sameConnection(a: DaemonConnection, b: DaemonConnection): boolean {
  return a.url === b.url && a.token === b.token;
}

function ConnectingScreen({ lastError }: { readonly lastError: string | null }) {
  return (
    <Center h="100vh">
      <Stack align="center" gap="xs">
        <Loader size="sm" />
        <Text>Connecting to the 10db daemon…</Text>
        {lastError !== null && (
          <Text size="sm" c="dimmed" maw={480} ta="center">
            {lastError}
          </Text>
        )}
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
  children,
}: DaemonProviderProps) {
  const [value, setValue] = useState<DaemonValue | null>(null);
  const [status, setStatus] = useState<DaemonStatus>({ kind: 'connecting', lastError: null });
  const { healthy: healthyMs, disconnected: disconnectedMs } = intervals;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: DaemonValue | null = null;
    let healthy = false;
    let everConnected = false;
    let downSince: number | null = null;

    async function tick(): Promise<void> {
      try {
        let active = current;
        if (!healthy || active === null) {
          const connection = await resolve();
          if (active === null || !sameConnection(active.connection, connection)) {
            active = { connection, client: createDaemonClient(connection) };
          }
          current = active;
        }
        const health = await readJson(
          await active.client.health.$get(undefined, {
            init: { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
          }),
          HealthResponse,
        );
        if (stopped) return;
        healthy = true;
        everConnected = true;
        downSince = null;
        setValue(active);
        setStatus(
          health.protocolVersion === PROTOCOL_VERSION
            ? { kind: 'connected', startedAt: health.startedAt }
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
      timer = setTimeout(
        () => {
          void tick();
        },
        healthy ? healthyMs : disconnectedMs,
      );
    }

    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [resolve, healthyMs, disconnectedMs]);

  if (status.kind === 'mismatch') {
    return (
      <StatusContext value={status}>
        <VersionMismatch daemonVersion={status.daemonVersion} />
      </StatusContext>
    );
  }
  if (value === null)
    return <ConnectingScreen lastError={status.kind === 'connecting' ? status.lastError : null} />;
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
