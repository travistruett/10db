import {
  AgentSkillLinkState,
  AgentSkillNotInstallable,
  AgentSkillTool,
  type AgentSkillStatus,
} from '@10db/contracts';
import { Badge, Box, Group, Stack, Switch, Text } from '@mantine/core';
import { IconAdjustments, IconBulb, IconListCheck } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useAgentSkill, useSetAgentSkill } from '../../daemon/queries';
import { HelpText } from './help-hint';
import { SettingRow, SettingsCard } from './setting-row';

const LABEL = 'Agents in any repo can use 10db';
const DESCRIPTION = 'Links the 10db-task skill into Claude Code and Codex.';
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

/** A link's state as a badge: its words and its color. */
function linkBadge(link: Link): { readonly label: string; readonly color: string } {
  switch (link.state) {
    case AgentSkillLinkState.Linked:
      return { label: 'Linked', color: 'teal' };
    case AgentSkillLinkState.Missing:
      return { label: 'Not Linked', color: 'gray' };
    case AgentSkillLinkState.PointsElsewhere:
      return { label: 'Points Elsewhere', color: 'yellow' };
    case AgentSkillLinkState.InTheWay:
      return { label: 'Folder in the Way', color: 'yellow' };
  }
}

/** Why a link was left alone, when it was. */
function linkNote(link: Link): string | null {
  switch (link.state) {
    case AgentSkillLinkState.PointsElsewhere:
      return `Points at ${link.target ?? 'somewhere else'}; left as it is.`;
    case AgentSkillLinkState.InTheWay:
      return 'A folder of yours is there; left as it is.';
    case AgentSkillLinkState.Linked:
    case AgentSkillLinkState.Missing:
      return null;
  }
}

function installBadge(status: AgentSkillStatus): {
  readonly label: string;
  readonly color: string;
} {
  if (status.installedVersion === null) return { label: 'Not Installed', color: 'gray' };
  return status.installedVersion === status.version
    ? { label: 'Current', color: 'teal' }
    : { label: 'Out of Date', color: 'yellow' };
}

function StateBadge({ label, color }: { readonly label: string; readonly color: string }) {
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

/** What an agent can ask of 10db once the skill is linked, in the words a builder would type. */
const USES: readonly { readonly icon: typeof IconListCheck; readonly text: string }[] = [
  { icon: IconListCheck, text: 'File, edit and start tasks: "put this on the 10db board"' },
  { icon: IconBulb, text: 'Record and read Knowledge: the principles and decisions to keep' },
  { icon: IconAdjustments, text: "Check a project's settings, areas and hazards" },
];

/** One status line: what it is on the left, its badge on the right, an optional dimmed line under. */
function StatusRow({
  name,
  detail,
  badge,
  note,
}: {
  readonly name: string;
  readonly detail?: string;
  readonly badge: ReactNode;
  readonly note?: string | null;
}) {
  return (
    <Box px="md" py="sm">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Stack gap={0} miw={0}>
          <Text size="sm" fw={500}>
            {name}
          </Text>
          {detail === undefined ? null : (
            <Text size="xs" c="dimmed" ff="monospace" truncate>
              {detail}
            </Text>
          )}
        </Stack>
        {badge}
      </Group>
      {note ? (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      ) : null}
    </Box>
  );
}

/** Settings › Agent Skill: what the 10db-task skill lets an agent do, its switch, and where it is linked. */
export function AgentSkillSection() {
  const query = useAgentSkill();
  const set = useSetAgentSkill();
  const status = query.data;
  const installable = status?.installable === true;
  return (
    <Stack gap="xl">
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          The 10db-task skill lets a Claude Code or Codex session in any repo work with 10db:
        </Text>
        <Stack gap={6}>
          {USES.map(({ icon: Icon, text }) => (
            <Group key={text} gap="xs" wrap="nowrap">
              <Icon size={16} stroke={1.5} aria-hidden style={{ flex: 'none' }} />
              <Text size="sm">{text}</Text>
            </Group>
          ))}
        </Stack>
      </Stack>
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
      </SettingsCard>
      {status ? (
        <SettingsCard title="Status">
          {status.installable === true ? (
            <StatusRow name="Skill" badge={<StateBadge {...installBadge(status)} />} />
          ) : (
            <StatusRow
              name="Skill"
              badge={<StateBadge label="Not Installed" color="gray" />}
              note={notInstallableLine(status.installable.reason)}
            />
          )}
          {status.installable === true
            ? status.links.map((link) => (
                <StatusRow
                  key={link.tool}
                  name={TOOL_NAME[link.tool]}
                  detail={link.path}
                  badge={<StateBadge {...linkBadge(link)} />}
                  note={linkNote(link)}
                />
              ))
            : null}
          {status.error ? (
            <Text size="xs" c="red" px="md" py="sm">
              {status.error}
            </Text>
          ) : null}
        </SettingsCard>
      ) : null}
    </Stack>
  );
}
