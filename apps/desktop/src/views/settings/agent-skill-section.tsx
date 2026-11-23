import {
  AgentSkillLinkState,
  AgentSkillNotInstallable,
  AgentSkillTool,
  type AgentSkillStatus,
} from '@10db/contracts';
import { Group, Stack, Switch, Text } from '@mantine/core';
import { useAgentSkill, useSetAgentSkill } from '../../daemon/queries';
import { HelpText } from './help-hint';
import { SettingRow, SettingsCard } from './setting-row';

const LABEL = 'Agents in any repo can use 10db';
const DESCRIPTION = 'Links the 10db-task skill for Claude Code and Codex.';
const HELP =
  '10db keeps its 10db-task skill in ~/.10db/skills and links it for Claude Code and Codex, so an agent in any repo can file and read tasks.';

type Link = AgentSkillStatus['links'][number];

const TOOL_NAME: Readonly<Record<AgentSkillTool, string>> = {
  [AgentSkillTool.ClaudeCode]: 'Claude Code',
  [AgentSkillTool.Codex]: 'Codex',
};

function notInstallableLine(reason: AgentSkillNotInstallable): string {
  switch (reason) {
    case AgentSkillNotInstallable.OtherDataDir:
      return 'This 10db uses another data folder, so it installs nothing';
    case AgentSkillNotInstallable.FromSource:
      return 'This 10db runs from source, so it installs nothing';
  }
}

function linkLine(link: Link): string {
  switch (link.state) {
    case AgentSkillLinkState.Linked:
      return 'Linked';
    case AgentSkillLinkState.Missing:
      return 'Not linked';
    case AgentSkillLinkState.PointsElsewhere:
      return `Points at ${link.target ?? 'somewhere else'}: left as it is`;
    case AgentSkillLinkState.InTheWay:
      return 'A folder of yours is there: left as it is';
  }
}

function installLine(status: AgentSkillStatus): string {
  if (status.installedVersion === null) return 'Not installed';
  return status.installedVersion === status.version
    ? 'Installed, current'
    : 'Installed copy is out of date';
}

export function AgentSkillSection() {
  const query = useAgentSkill();
  const set = useSetAgentSkill();
  const status = query.data;
  const installable = status?.installable === true;
  return (
    <SettingsCard>
      <SettingRow label={LABEL} description={DESCRIPTION} help={<HelpText>{HELP}</HelpText>}>
        <Group justify="flex-end">
          <Switch
            aria-label={LABEL}
            checked={status?.enabled ?? false}
            disabled={!installable}
            onChange={(e) => {
              set.mutate(e.currentTarget.checked);
            }}
          />
        </Group>
      </SettingRow>
      {status ? (
        <SettingRow label="Status" stacked>
          <Stack gap={4}>
            {status.installable === true ? (
              <>
                <Text size="sm">{installLine(status)}</Text>
                {status.links.map((link) => (
                  <Stack key={link.tool} gap={0}>
                    <Text size="xs" c="dimmed">{`${TOOL_NAME[link.tool]}: ${link.path}`}</Text>
                    <Text size="xs">{linkLine(link)}</Text>
                  </Stack>
                ))}
              </>
            ) : (
              <Text size="sm">{notInstallableLine(status.installable.reason)}</Text>
            )}
            {status.error ? (
              <Text size="xs" c="red">
                {status.error}
              </Text>
            ) : null}
          </Stack>
        </SettingRow>
      ) : null}
    </SettingsCard>
  );
}
