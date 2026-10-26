import { Alert, Stack } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useSystemCheck } from '../daemon/queries';

/**
 * What the daemon found that stops or degrades work: a missing tool, an unreadable login shell, or a failed
 * Artificial Analysis sync. Routing keeps the last good scores through a failed sync, so the alert says so.
 */
export function SystemAlert() {
  const check = useSystemCheck().data;
  if (!check) return null;
  const missing = check.tools.filter((tool) => tool.required && tool.path === null);
  const warning = check.loginEnv.warning;
  const benchmarkSync = check.benchmarkSync;
  if (missing.length === 0 && !warning && !benchmarkSync) return null;
  const icon = <IconAlertTriangle size={20} stroke={1.5} />;
  return (
    <Stack gap="xs" mb="md">
      {missing.map((tool) => (
        <Alert
          key={tool.name}
          color="red"
          icon={icon}
          title={`${tool.name} was not found on your login PATH`}
        >
          Install it, then restart 10db. Sessions can't start until it is found.
        </Alert>
      ))}
      {warning && (
        <Alert color="yellow" icon={icon} title="10db couldn't read your login shell's environment">
          {warning}
        </Alert>
      )}
      {benchmarkSync && (
        <Alert
          color="yellow"
          icon={icon}
          title={`Artificial Analysis sync failed (${benchmarkSync.outcome})`}
        >
          {`${benchmarkSync.message}. Routing uses the last good scores until a sync succeeds.`}
        </Alert>
      )}
    </Stack>
  );
}
