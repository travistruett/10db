import { Alert, Stack } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useSystemCheck } from '../daemon/queries';
import { syncNeedsBuilder } from './benchmark-sync-urgency';

/**
 * What the daemon found that stops or degrades work until the builder acts: a missing tool, an unreadable login
 * shell, or an Artificial Analysis key that was refused. A sync failure that clears itself is a note in the
 * Factory header instead.
 */
export function SystemAlert() {
  const check = useSystemCheck().data;
  if (!check) return null;
  const missing = check.tools.filter((tool) => tool.required && tool.path === null);
  const warning = check.loginEnv.warning;
  const benchmarkSync =
    check.benchmarkSync && syncNeedsBuilder(check.benchmarkSync) ? check.benchmarkSync : null;
  const versionWarning = check.claudeCode.warning;
  if (missing.length === 0 && !warning && !benchmarkSync && !versionWarning) return null;
  const icon = <IconAlertTriangle size={20} stroke={1.5} />;
  const versionAlert = versionWarning ? (
    <Alert color="yellow" icon={icon} title="This Claude Code is newer than 10db's account checks">
      {versionWarning}
    </Alert>
  ) : null;
  return (
    <Stack gap="xs" mb="md">
      {missing.map((tool) => (
        <Alert
          key={tool.name}
          color="red"
          icon={icon}
          title={`${tool.name} was not found where 10db looks for it`}
        >
          10db runs it only from /opt/homebrew/bin, /usr/local/bin or /usr/bin (claude also from
          ~/.local/bin), never from your PATH, where a lane could put one. Install it there, then
          restart 10db. Sessions can't start until it is found.
        </Alert>
      ))}
      {warning && (
        <Alert color="yellow" icon={icon} title="10db couldn't read your login shell's environment">
          {warning}
        </Alert>
      )}
      {benchmarkSync && (
        <Alert color="yellow" icon={icon} title={benchmarkSync.message}>
          Replace the key in the Keychain; the next sync reads it. Routing uses the last good scores
          until a sync succeeds.
        </Alert>
      )}
      {versionAlert}
    </Stack>
  );
}
