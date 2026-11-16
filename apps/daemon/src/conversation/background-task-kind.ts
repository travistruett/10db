import { BackgroundTaskKind } from '@10db/contracts';

/** Claude Code's task type read as what the builder sees: a shell, a monitor or a subagent. */
export function taskKind(type: string | undefined): BackgroundTaskKind {
  const t = type?.toLowerCase() ?? '';
  if (t.includes('agent')) return BackgroundTaskKind.Agent;
  if (t.includes('monitor')) return BackgroundTaskKind.Monitor;
  if (t.includes('bash') || t.includes('shell')) return BackgroundTaskKind.Shell;
  return BackgroundTaskKind.Other;
}
