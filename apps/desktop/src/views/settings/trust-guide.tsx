import { JudgeKind } from '@10db/contracts';
import { Badge, Divider, Group, SegmentedControl, Stack, Switch, Text } from '@mantine/core';
import { Fragment } from 'react';
import { PageGuide, STILL_SURFACE, type PageGuideHandle } from '../../shell/page-guide';
import { JUDGE_LABELS, TRUST_ROWS } from './trust-rows';

export const TRUST_GUIDE = 'How trust works';

// Stills of the Trust pages, drawn with their own rows, switches and words. Nothing in them is live.

const SHOWN = ['web', 'yourSkills', 'yourMcpServers'] as const;

/** Three of the switches, on, as the page lists them. */
function SwitchesPicture() {
  const rows = TRUST_ROWS.filter((row) => SHOWN.some((key) => key === row.key));
  return (
    <Stack gap={0} style={STILL_SURFACE}>
      {rows.map((row, index) => (
        <Fragment key={row.key}>
          {index === 0 ? null : <Divider />}
          <Group gap="sm" wrap="nowrap" justify="space-between" px={10} py={6}>
            <Text size="xs" fw={500}>
              {row.label}
            </Text>
            <Switch size="xs" checked readOnly tabIndex={-1} aria-hidden />
          </Group>
        </Fragment>
      ))}
    </Stack>
  );
}

function Call({
  command,
  verdict,
  stopped,
}: {
  readonly command: string;
  readonly verdict: string;
  readonly stopped: boolean;
}) {
  return (
    <Group gap="sm" wrap="nowrap" justify="space-between">
      <Text size="xs" ff="monospace" truncate>
        {command}
      </Text>
      <Badge
        size="sm"
        tt="none"
        fw={500}
        variant="light"
        color={stopped ? 'red' : 'teal'}
        style={{ flex: 'none' }}
      >
        {verdict}
      </Badge>
    </Group>
  );
}

/** Two calls a session makes, and what the judge does with each. */
function JudgePicture() {
  return (
    <Stack gap={8} p={10} style={STILL_SURFACE}>
      <Call command="pnpm test" verdict="Allowed" stopped={false} />
      <Call command="git push --force origin main" verdict="Stopped at a Limit" stopped />
      <Text fz={11} c="dimmed" pt={6} style={{ borderTop: STILL_SURFACE.border }}>
        {`Judged by ${JUDGE_LABELS[JudgeKind.Native]}, or 10db's judge`}
      </Text>
    </Stack>
  );
}

/** A project's row for one switch: Default follows All Projects, or On or Off here. */
function OverridePicture() {
  return (
    <Stack gap={6} p={10} style={STILL_SURFACE}>
      <Text size="xs" fw={500}>
        Web
      </Text>
      <SegmentedControl
        size="xs"
        fullWidth
        value="app"
        data={[
          { value: 'app', label: 'Default · On' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        tabIndex={-1}
      />
    </Stack>
  );
}

/** How trust works: the builder's setup comes along into every session, and a judge decides the risky calls. */
export function TrustGuide({
  guide,
  project,
}: {
  readonly guide: PageGuideHandle;
  /** The project whose Trust the page is; null for the one that applies everywhere. */
  readonly project: string | null;
}) {
  return (
    <PageGuide
      guide={guide}
      lead="Your own setup comes along into every session, as it does in Claude Code. Agents work freely; a judge decides the few calls that could do harm."
      steps={[
        {
          title: 'Your setup comes along',
          caption: 'Each switch brings one part of your setup into every session.',
          picture: <SwitchesPicture />,
        },
        {
          title: 'A judge decides risky calls',
          caption: 'Routine calls run. One that could destroy or leak data is judged first.',
          picture: <JudgePicture />,
        },
        {
          title: 'A project can differ',
          caption: "A project's Trust turns a switch on or off there alone.",
          picture: <OverridePicture />,
        },
      ]}
      scope={
        project === null
          ? 'These apply in every project. Changes apply from the next session.'
          : `Default follows All Projects; On or Off applies only in ${project}. Changes apply from the next session.`
      }
    />
  );
}
