import { RIGORS, type ProjectDto, type Rigor } from '@10db/contracts';
import { Select, Stack, Text, Title } from '@mantine/core';
import { usePatchProject } from '../../daemon/queries';
import { PlaybookTable } from './playbook-table';
import { rigorLabel } from './rigor-labels';
import { SettingRow, SettingsCard } from './setting-row';

const isRigor = (value: string): value is Rigor => RIGORS.some((r) => r === value);

/**
 * A project's playbook: the rigor its tasks get unless one says otherwise, and the same table as the global
 * playbook, where each field the project leaves alone follows the global one (Use global).
 */
export function ProjectPlaybook({ project }: { readonly project: ProjectDto }) {
  const patch = usePatchProject(project.id);
  return (
    <Stack gap="lg">
      <SettingsCard>
        <SettingRow
          label="Default rigor"
          description="The rigor a task gets when nothing sets its own. A kind's minimum can raise it."
        >
          <Select
            aria-label="Default rigor"
            allowDeselect={false}
            data={RIGORS.map((r) => ({ value: r, label: rigorLabel(r) }))}
            value={project.defaultRigor}
            disabled={patch.isPending}
            onChange={(value) => {
              if (value !== null && isRigor(value) && value !== project.defaultRigor)
                patch.mutate({ defaultRigor: value });
            }}
          />
        </SettingRow>
      </SettingsCard>
      {patch.isError ? (
        <Text size="sm" c="red" role="alert">
          {`Couldn't save: ${patch.error.message}`}
        </Text>
      ) : null}
      <Stack gap="xs" component="section" aria-label="Project playbook">
        <Title order={4} size="md" fw={600}>
          Playbook
        </Title>
        <Text size="xs" c="dimmed">
          Cells show what each step resolves to on this project&apos;s account. A field you set here
          applies to this project only; Use global follows All projects › Models.
        </Text>
        <PlaybookTable projectId={project.id} accountId={project.accountId} />
      </Stack>
    </Stack>
  );
}
