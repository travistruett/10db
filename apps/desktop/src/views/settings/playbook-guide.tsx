import { Rigor, StepRole } from '@10db/contracts';
import { Badge, Group, Stack, Text } from '@mantine/core';
import { IconArrowDown, IconChevronRight } from '@tabler/icons-react';
import { Fragment } from 'react';
import { PageGuide, STILL_SURFACE, type PageGuideHandle } from '../../shell/page-guide';
import { rigorLabel, RIGOR_LABELS } from './rigor-labels';
import { ROLES } from './role-labels';

export const PLAYBOOK_GUIDE = 'How the playbook works';

// Stills of the Playbook, drawn with its own words: a rigor's steps, one cell and what it resolves to, and a kind.
// Nothing in them is live, and none names a model, since which one a cell gets changes with the account.

const roleName = (role: StepRole): string => ROLES.find((r) => r.role === role)?.label ?? role;

/** A word as the Kinds list draws it: a quiet pill that keeps its full width. */
function Pill({ children }: { readonly children: string }) {
  return (
    <Badge size="sm" tt="none" fw={500} variant="light" color="gray" style={{ flex: 'none' }}>
      {children}
    </Badge>
  );
}

/** A rigor's row: its name, what it is for and the steps it runs, in order. */
function RigorPicture() {
  const steps = [StepRole.Plan, StepRole.Implement, StepRole.Review];
  return (
    <Stack gap={8} p={10} style={STILL_SURFACE}>
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text size="xs" fw={600} style={{ flex: 'none' }}>
          {rigorLabel(Rigor.Careful)}
        </Text>
        <Text fz={11} c="dimmed" truncate>
          {RIGOR_LABELS[Rigor.Careful].about}
        </Text>
      </Group>
      <Group gap={4} wrap="nowrap">
        {steps.map((step, index) => (
          <Fragment key={step}>
            {index === 0 ? null : (
              <IconChevronRight size={12} stroke={1.75} color="var(--mantine-color-dimmed)" />
            )}
            <Pill>{roleName(step)}</Pill>
          </Fragment>
        ))}
      </Group>
    </Stack>
  );
}

/** One cell's setting, and what it comes to on the account the page shows. */
function CellPicture() {
  return (
    <Stack gap={6} align="flex-start">
      <Stack gap={0} px={10} py={6} style={STILL_SURFACE}>
        <Text fz={10} fw={600} c="dimmed">
          {`${rigorLabel(Rigor.Careful)} · ${roleName(StepRole.Implement)}`}
        </Text>
        <Text size="xs" fw={500}>
          Auto, at least 40
        </Text>
        <Text fz={11} c="dimmed">
          high effort
        </Text>
      </Stack>
      <Group gap={6} wrap="nowrap" pl={10}>
        <IconArrowDown size={12} stroke={1.75} color="var(--mantine-color-dimmed)" />
        <Text fz={11} c="dimmed">
          on your account
        </Text>
      </Group>
      <Text size="xs" px={10} py={6} style={STILL_SURFACE}>
        The cheapest model that scores 40 or more
      </Text>
    </Stack>
  );
}

/** A kind's row as the Kinds list draws it: its name, its floor and what it changes. */
function KindPicture() {
  return (
    <Stack gap={8} p={10} style={STILL_SURFACE}>
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text size="xs" fw={600} style={{ flex: 'none' }}>
          Security
        </Text>
        <Text fz={11} c="dimmed" truncate>
          {`At least ${rigorLabel(Rigor.Careful)}`}
        </Text>
      </Group>
      <Group gap={4} wrap="nowrap">
        <Pill>Always Reviewed</Pill>
        <Pill>{`${roleName(StepRole.Review)}: Top of Frontier`}</Pill>
      </Group>
    </Stack>
  );
}

/** How the playbook works: a task's rigor picks its steps, each cell a model on the account, and kinds adjust both. */
export function PlaybookGuide({
  guide,
  project,
}: {
  readonly guide: PageGuideHandle;
  /** The project whose own playbook the page is; null for the one that applies everywhere. */
  readonly project: string | null;
}) {
  return (
    <PageGuide
      guide={guide}
      lead="The playbook says which steps run at each rigor, and the model and effort each step gets."
      steps={[
        {
          title: 'A task gets a rigor',
          caption: '10db sizes each task, or you do. More risk runs more steps.',
          picture: <RigorPicture />,
        },
        {
          title: 'Each cell picks a model',
          caption: 'A cell names a rule, and it resolves on the account that pays.',
          picture: <CellPicture />,
        },
        {
          title: 'Kinds adjust it',
          caption: 'A kind of work can raise the rigor or give a step a stronger model.',
          picture: <KindPicture />,
        },
      ]}
      scope={
        project === null
          ? "This playbook applies in every project. A project's own Playbook can change any cell there."
          : `A cell set here applies only in ${project}. Use Global follows All Projects.`
      }
    />
  );
}
