import { HealthResponse } from '@10db/contracts';
import { Badge } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { daemonClient } from '../daemon/client';

async function fetchHealth(): Promise<HealthResponse> {
  const res = await daemonClient.health.$get();
  return HealthResponse.parse(await res.json());
}

export function DaemonStatus() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 5_000 });
  if (health.isPending) return <Badge color="gray">Connecting…</Badge>;
  if (health.isError) return <Badge color="red">Daemon unreachable</Badge>;
  return <Badge color="teal">Daemon connected</Badge>;
}
