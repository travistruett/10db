import { Box, Tooltip } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { useSystemCheck } from '../daemon/queries';
import { fetchingAgents } from '../views/inbox/system-cards';

/**
 * A pinned copy of Claude Code or Codex being downloaded, quietly at the rail's foot: it clears by itself and
 * there is nothing for the builder to do. Sessions that need it wait for it.
 */
export function AgentDownloadStatus() {
  const fetching = fetchingAgents(useSystemCheck().data);
  if (fetching.length === 0) return null;
  return (
    <>
      {fetching.map((agent) => {
        const name = `${agent.label} ${agent.pinned}`;
        return (
          <Tooltip
            key={agent.tool}
            multiline
            w={280}
            position="right"
            label={`Downloading ${name}. 10db runs its own copy of ${agent.label}, checked against a recorded checksum. Sessions that need it start once it is ready.`}
          >
            <Box
              role="status"
              aria-label={`Downloading ${name}`}
              style={{ display: 'grid', placeItems: 'center', width: 36, height: 34 }}
            >
              <IconDownload
                size={18}
                stroke={1.6}
                color="var(--mantine-color-dimmed)"
                aria-hidden
              />
            </Box>
          </Tooltip>
        );
      })}
    </>
  );
}
