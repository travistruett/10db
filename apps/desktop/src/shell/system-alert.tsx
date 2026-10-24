import { Alert, Stack } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useSystemCheck } from '../daemon/queries';

/** What the daemon's startup check found that stops or degrades work: a missing tool, or an unreadable login shell. */
export function SystemAlert() {
  const check = useSystemCheck().data;
  if (!check) return null;
  const missing = check.tools.filter((tool) => tool.required && tool.path === null);
  const warning = check.loginEnv.warning;
  const versionWarning = check.claudeCode.warning;
  if (missing.length === 0 && !warning && !versionWarning) return null;
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
      {versionAlert}
    </Stack>
  );
}
