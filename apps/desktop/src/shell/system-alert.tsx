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
  const agents = check.agents ?? [];
  // Claude Code and Codex are 10db's own pinned copies: their state is told by their own alerts below.
  const missing = check.tools.filter(
    (tool) =>
      tool.required && tool.path === null && !agents.some((agent) => agent.tool === tool.name),
  );
  const unready = agents.filter((agent) => agent.state !== 'ready');
  const newer = agents.filter((agent) => agent.newerRelease !== null);
  const warning = check.loginEnv.warning;
  const benchmarkSync =
    check.benchmarkSync && syncNeedsBuilder(check.benchmarkSync) ? check.benchmarkSync : null;
  const versionWarning = check.claudeCode.warning;
  const codexWarning = check.codex.warning;
  if (
    missing.length === 0 &&
    unready.length === 0 &&
    newer.length === 0 &&
    !warning &&
    !benchmarkSync &&
    !versionWarning &&
    !codexWarning
  )
    return null;
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
      {unready.map((agent) =>
        agent.state === 'refused' ? (
          <Alert
            key={agent.tool}
            color="red"
            icon={icon}
            title={`${agent.label} ${agent.pinned} can't be used`}
          >
            {agent.problem ?? 'Its copy failed the check.'} No session runs on it. Recheck once the
            cause is fixed.
          </Alert>
        ) : (
          <Alert
            key={agent.tool}
            color="blue"
            icon={icon}
            title={`${agent.label} ${agent.pinned} is being downloaded`}
          >
            10db runs its own copy of {agent.label}, checked against a recorded checksum. Sessions
            that need it start once it is ready.
          </Alert>
        ),
      )}
      {newer.map((agent) => (
        <Alert
          key={`newer-${agent.tool}`}
          color="yellow"
          icon={icon}
          title={`${agent.label} ${agent.newerRelease ?? ''} is out`}
        >
          10db runs {agent.label} {agent.pinned}, the release it is verified on, and doesn't update
          it by itself. A 10db update that has passed its live test on {agent.newerRelease} moves
          it.
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
      {codexWarning ? (
        <Alert
          color="yellow"
          icon={icon}
          title="This Codex differs from the one 10db's account checks were verified on"
        >
          {codexWarning}
        </Alert>
      ) : null}
    </Stack>
  );
}
