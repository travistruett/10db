import { AgentCopyState, ToolName, type AgentCopy } from '@10db/contracts';
import { Stack, Text, Title } from '@mantine/core';
import { useId } from 'react';
import { useSystemCheck } from '../../daemon/queries';
import { SettingRow, SettingsCard } from './setting-row';

const TITLE = 'Claude Code and Codex';

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

/**
 * The release of Claude Code and Codex 10db runs, and a newer one when it is out. Nothing here asks the
 * builder to act: 10db doesn't move its pin by itself, and a 10db update that has passed the live test on
 * the newer release moves it.
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
      <Title order={5} id={titleId}>
        {TITLE}
      </Title>
      <SettingsCard>
        {agents.map((agent) => {
          const newer = agent.newerRelease;
          const lines = [
            `Runs ${agent.pinned}, the release 10db is verified on.`,
            newer === null
              ? null
              : `${newer} is out. Nothing to do: a 10db update moves to it once it has passed its live test on ${newer}.`,
            stateNote(agent),
            warningOf(agent),
          ].filter((line) => line !== null);
          return (
            <SettingRow
              key={agent.tool}
              label={agent.label}
              description={
                <Text size="sm" c="dimmed" component="span">
                  {lines.join(' ')}
                </Text>
              }
            >
              <span />
            </SettingRow>
          );
        })}
      </SettingsCard>
    </Stack>
  );
}
