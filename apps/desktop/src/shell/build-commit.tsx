import { Code, Tooltip } from '@mantine/core';
import { useDaemonStatus } from '../daemon/provider';

const SHORT = 7;

/**
 * The commit this app was built from, so the builder can tell which fixes it has. A run from source
 * has no commit and says so; nothing shows while the daemon is not connected.
 */
export function BuildCommit() {
  const status = useDaemonStatus();
  if (status.kind !== 'connected') return null;
  const label =
    status.commit === null
      ? 'Not an installed build: running from source'
      : `Running commit ${status.commit}`;
  return (
    <Tooltip label={label}>
      <Code aria-label={label}>
        {status.commit === null ? 'dev' : status.commit.slice(0, SHORT)}
      </Code>
    </Tooltip>
  );
}
