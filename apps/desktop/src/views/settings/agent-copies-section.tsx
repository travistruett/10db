import { AgentCopyState, ToolName, type AgentCopy } from '@10db/contracts';
import { Badge, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useId } from 'react';
import { useSystemCheck } from '../../daemon/queries';
import { HelpText } from './help-hint';
import { SettingsCard } from './setting-row';
import { SectionHeading } from './section-heading';

const TITLE = 'Harnesses';

/** Where the copy stands, when it is not simply ready; a refused one has its card in the Inbox. */
function stateNote(agent: AgentCopy): string | null {
  switch (agent.state) {
    case AgentCopyState.Ready:
      return null;
    case AgentCopyState.Fetching:
      return 'Being downloaded; sessions that need it start once it is ready.';
    case AgentCopyState.Refused:
      return 'This copy was refused; the Inbox says why and offers to fetch it again.';
  }
}

function VersionBadge({ label, color }: { readonly label: string; readonly color: string }) {
  return (
    <Badge
      variant="light"
      color={color}
      style={{ minWidth: 'max-content' }}
      styles={{ label: { overflow: 'visible', textOverflow: 'clip' } }}
    >
      {label}
    </Badge>
  );
}

/**
 * The release of Claude Code and Codex 10db runs, and a newer one when it is out: one row each, the pinned
 * version on the right with a badge. Nothing here asks the builder to act: 10db doesn't move its pin by itself,
 * and a 10db update that has passed the live test on the newer release moves it.
 */
export function AgentCopiesSection() {
  const check = useSystemCheck().data;
  const titleId = useId();
  const agents = check?.agents ?? [];
  if (!check || agents.length === 0) return null;
  const warningOf = (agent: AgentCopy): string | null =>
    agent.tool === ToolName.Claude ? check.claudeCode.warning : check.codex.warning;
  return (
    <Stack gap="xs" role="region" aria-labelledby={titleId}>
      <SectionHeading
        id={titleId}
        title={TITLE}
        line="The Claude Code and Codex releases 10db runs your sessions on."
        help={
          <HelpText>
            10db runs each agent on the release it has tested. A newer release reaches you in a 10db
            update, once 10db has passed its live test on it; nothing here needs you.
          </HelpText>
        }
      />
      <SettingsCard>
        {agents.map((agent) => {
          const newer = agent.newerRelease;
          const notes = [stateNote(agent), warningOf(agent)].filter((line) => line !== null);
          return (
            <Box key={agent.tool} px="md" py="sm">
              <Group justify="space-between" wrap="nowrap" gap="md">
                <Text size="sm" fw={500}>
                  {agent.label}
                </Text>
                <Group gap="sm" wrap="nowrap" align="center">
                  <Text size="sm" ff="monospace" lh={1}>
                    {agent.pinned}
                  </Text>
                  {newer === null ? (
                    <VersionBadge label="Up to Date" color="teal" />
                  ) : (
                    <Tooltip label="Comes with a 10db update once 10db is tested on it" withArrow>
                      <span>
                        <VersionBadge label={`Latest: ${newer}`} color="gray" />
                      </span>
                    </Tooltip>
                  )}
                </Group>
              </Group>
              {notes.length === 0 ? null : (
                <Text size="xs" c="dimmed">
                  {notes.join(' ')}
                </Text>
              )}
            </Box>
          );
        })}
      </SettingsCard>
    </Stack>
  );
}
